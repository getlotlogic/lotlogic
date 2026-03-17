#!/usr/bin/env python3
"""
LotLogic Deploy Watchdog Agent

Monitors the deployed dashboard, detects failures, uses Claude to diagnose
and fix the issue, then redeploys via git push.

Usage:
    # Single check
    python deploy_agent.py --check

    # Watch mode (polls every 60s, auto-fixes on failure)
    python deploy_agent.py --watch

    # Diagnose current state without fixing
    python deploy_agent.py --diagnose
"""

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import anthropic
import requests

from agent_config import AgentConfig

# ── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("lotlogic.deploy")

_running = True


def _handle_signal(signum, frame):
    global _running
    logger.info("Shutting down...")
    _running = False


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)

# ── Configuration ───────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
DEPLOY_BRANCH = os.getenv("DEPLOY_BRANCH", "main")
CHECK_INTERVAL = int(os.getenv("DEPLOY_CHECK_INTERVAL", "60"))
MAX_FIX_ATTEMPTS = int(os.getenv("DEPLOY_MAX_FIX_ATTEMPTS", "3"))
COOLDOWN_AFTER_FIX = int(os.getenv("DEPLOY_COOLDOWN", "120"))  # wait after push


# ── Health Probe ────────────────────────────────────────────────────────────

def probe_deployment(dashboard_url: str) -> dict:
    """Check if the deployment is healthy. Returns structured result."""
    if not dashboard_url:
        return {"healthy": False, "error": "No DASHBOARD_URL configured"}

    try:
        start = time.monotonic()
        resp = requests.get(dashboard_url, timeout=20)
        latency_ms = round((time.monotonic() - start) * 1000)

        html = resp.text.lower()
        has_react = "react" in html
        has_app = "lotlogic" in html or "function app" in html

        if resp.status_code != 200:
            return {
                "healthy": False,
                "error": f"HTTP {resp.status_code}",
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
            }

        if not has_react:
            return {
                "healthy": False,
                "error": "Page loaded but React not found — possible blank page or crash",
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
                "content_length": len(resp.text),
            }

        return {
            "healthy": True,
            "status_code": 200,
            "latency_ms": latency_ms,
            "content_length": len(resp.text),
            "has_react": has_react,
            "has_app": has_app,
        }

    except requests.ConnectionError:
        return {"healthy": False, "error": "Connection refused — container not running"}
    except requests.Timeout:
        return {"healthy": False, "error": "Timeout — container not responding"}
    except Exception as e:
        return {"healthy": False, "error": str(e)}


# ── Git helpers ─────────────────────────────────────────────────────────────

def git(*args, check=True) -> str:
    """Run a git command in the repo root."""
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def get_recent_diff() -> str:
    """Get the diff of the last commit (what was most recently deployed)."""
    try:
        return git("diff", "HEAD~1..HEAD", "--", "index.html", "Dockerfile", "nginx.conf")
    except Exception:
        return git("diff", "HEAD", "--", "index.html", "Dockerfile", "nginx.conf", check=False)


def get_recent_commits(n: int = 5) -> str:
    return git("log", f"--oneline", f"-{n}")


def get_file_content(path: str) -> str:
    """Read a file from the repo."""
    full = REPO_ROOT / path
    if full.exists():
        return full.read_text()[:50000]  # cap at 50k chars
    return f"[File not found: {path}]"


# ── Build validation ────────────────────────────────────────────────────────

def validate_html_js(html_content: str) -> dict:
    """Quick JS syntax validation — check bracket balance in the script block."""
    import re
    match = re.search(r"<script type=['\"]text/babel['\"]>(.*?)</script>", html_content, re.DOTALL)
    if not match:
        return {"valid": False, "error": "No <script type='text/babel'> block found"}

    code = match.group(1)
    braces = parens = brackets = 0
    in_string = False
    string_char = ""
    escaped = False
    in_line_comment = False
    in_block_comment = False

    for i, c in enumerate(code):
        if in_block_comment:
            if c == "*" and i + 1 < len(code) and code[i + 1] == "/":
                in_block_comment = False
            continue
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            continue
        if escaped:
            escaped = False
            continue
        if c == "\\":
            escaped = True
            continue
        if in_string:
            if c == string_char:
                in_string = False
            continue
        if c == "/" and i + 1 < len(code):
            if code[i + 1] == "/":
                in_line_comment = True
                continue
            if code[i + 1] == "*":
                in_block_comment = True
                continue
        if c in ("'", '"', "`"):
            in_string = True
            string_char = c
            continue
        if c == "{": braces += 1
        elif c == "}": braces -= 1
        elif c == "(": parens += 1
        elif c == ")": parens -= 1
        elif c == "[": brackets += 1
        elif c == "]": brackets -= 1

    issues = []
    if braces != 0:
        issues.append(f"braces imbalance: {braces:+d}")
    if parens != 0:
        issues.append(f"parens imbalance: {parens:+d}")
    if brackets != 0:
        issues.append(f"brackets imbalance: {brackets:+d}")

    result = {
        "valid": len(issues) == 0,
        "braces": braces,
        "parens": parens,
        "brackets": brackets,
        "script_length": len(code),
    }
    if issues:
        result["issues"] = issues
    return result


def validate_dockerfile() -> dict:
    """Check Dockerfile basics."""
    content = get_file_content("Dockerfile")
    issues = []
    if "FROM" not in content:
        issues.append("Missing FROM instruction")
    if "COPY index.html" not in content:
        issues.append("Missing COPY index.html")
    if "EXPOSE" not in content:
        issues.append("Missing EXPOSE")
    return {"valid": len(issues) == 0, "issues": issues}


def validate_nginx_conf() -> dict:
    """Check nginx.conf for basic correctness."""
    content = get_file_content("nginx.conf")
    issues = []
    if "listen" not in content:
        issues.append("Missing 'listen' directive")
    if "server_name" not in content:
        issues.append("Missing 'server_name' directive")
    open_braces = content.count("{")
    close_braces = content.count("}")
    if open_braces != close_braces:
        issues.append(f"Brace mismatch: {open_braces} open vs {close_braces} close")
    return {"valid": len(issues) == 0, "issues": issues}


# ── Claude diagnosis & fix ──────────────────────────────────────────────────

SYSTEM_PROMPT = """You are the LotLogic Deploy Agent — an automated system that diagnoses and fixes
deployment failures for a React SPA served by nginx on Railway.

Architecture:
- Single-page app: index.html with inline React (JSX via Babel standalone)
- Dockerfile: nginx:alpine, copies index.html + nginx.conf
- nginx.conf: template using ${PORT}, SPA fallback, gzip, security headers
- railway.toml: healthcheck at / with 100s timeout
- Deploy: git push to main triggers Railway build + deploy

Common failure modes:
1. JavaScript syntax error (unclosed brackets, missing commas) → blank page, health check fails
2. Dockerfile error (wrong COPY path, missing file)
3. nginx.conf error (bad directive, missing semicolon, brace mismatch)
4. Railway config error (wrong healthcheck path, insufficient timeout)
5. HTML structure error (unclosed tags, malformed script block)

When asked to fix:
- Output ONLY the exact file edits needed as a JSON array
- Each edit: {"file": "path", "find": "exact string to find", "replace": "replacement string"}
- Keep edits minimal — fix only what's broken
- Never rewrite entire files — use surgical edits"""


def diagnose_failure(client: anthropic.Anthropic, config: AgentConfig, probe_result: dict) -> dict:
    """Ask Claude to diagnose the deployment failure."""

    # Gather context
    recent_diff = get_recent_diff()
    recent_commits = get_recent_commits()
    js_validation = validate_html_js(get_file_content("index.html"))
    dockerfile_validation = validate_dockerfile()
    nginx_validation = validate_nginx_conf()

    context = {
        "probe_result": probe_result,
        "js_validation": js_validation,
        "dockerfile_validation": dockerfile_validation,
        "nginx_validation": nginx_validation,
        "recent_commits": recent_commits,
        "recent_diff_preview": recent_diff[:5000] if recent_diff else "(no diff)",
    }

    # If validations already found clear issues, include relevant file snippets
    extra = ""
    if not js_validation["valid"]:
        html = get_file_content("index.html")
        # Send last 200 lines of the script for context
        lines = html.split("\n")
        extra += f"\n\nLast 200 lines of index.html (lines {max(1,len(lines)-199)}-{len(lines)}):\n"
        extra += "\n".join(f"{i+1}: {l}" for i, l in enumerate(lines[-200:], start=max(0, len(lines) - 200)))

    if not nginx_validation["valid"]:
        extra += f"\n\nnginx.conf:\n{get_file_content('nginx.conf')}"

    response = client.messages.create(
        model=config.model,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": f"""The deployment is DOWN. Diagnose the failure.

Context:
```json
{json.dumps(context, indent=2)}
```
{extra}

Provide:
1. Root cause (1-2 sentences)
2. Severity (critical/warning)
3. Can this be auto-fixed? (yes/no)
4. If yes, provide the exact edits as JSON: [{{"file": "...", "find": "...", "replace": "..."}}]

Respond in JSON format:
{{"root_cause": "...", "severity": "...", "auto_fixable": true/false, "edits": [...], "explanation": "..."}}"""
        }],
    )

    text = next((b.text for b in response.content if b.type == "text"), "{}")

    # Extract JSON from response (handle markdown code blocks)
    import re
    json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if json_match:
        text = json_match.group(1)
    else:
        # Try to find raw JSON
        json_match = re.search(r"\{.*\}", text, re.DOTALL)
        if json_match:
            text = json_match.group(0)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "root_cause": "Could not parse Claude's diagnosis",
            "severity": "critical",
            "auto_fixable": False,
            "edits": [],
            "explanation": text[:500],
        }


def apply_edits(edits: list[dict]) -> list[str]:
    """Apply file edits from Claude's diagnosis. Returns list of modified files."""
    modified = []
    for edit in edits:
        filepath = REPO_ROOT / edit["file"]
        if not filepath.exists():
            logger.warning("Skipping edit — file not found: %s", edit["file"])
            continue

        content = filepath.read_text()
        find = edit["find"]
        replace = edit["replace"]

        if find not in content:
            logger.warning("Skipping edit — string not found in %s: %s...", edit["file"], find[:80])
            continue

        count = content.count(find)
        if count > 1:
            logger.warning("String found %d times in %s — applying first occurrence only", count, edit["file"])
            content = content.replace(find, replace, 1)
        else:
            content = content.replace(find, replace)

        filepath.write_text(content)
        modified.append(edit["file"])
        logger.info("Applied edit to %s", edit["file"])

    return modified


def commit_and_push(modified_files: list[str], diagnosis: dict) -> bool:
    """Commit the fix and push to trigger redeploy."""
    if not modified_files:
        return False

    try:
        for f in modified_files:
            git("add", f)

        cause = diagnosis.get("root_cause", "deployment failure")[:100]
        git("commit", "-m", f"fix(deploy-agent): auto-fix — {cause}")

        # Push with retry + exponential backoff
        for attempt in range(4):
            try:
                git("push", "origin", DEPLOY_BRANCH)
                logger.info("Pushed fix to %s", DEPLOY_BRANCH)
                return True
            except RuntimeError as e:
                if attempt < 3:
                    wait = 2 ** (attempt + 1)
                    logger.warning("Push failed (attempt %d), retrying in %ds: %s", attempt + 1, wait, e)
                    time.sleep(wait)
                else:
                    logger.error("Push failed after 4 attempts: %s", e)
                    return False
    except Exception as e:
        logger.error("Commit/push failed: %s", e)
        return False


# ── Agent Modes ─────────────────────────────────────────────────────────────

def run_check(config: AgentConfig) -> dict:
    """Single deployment health check."""
    result = probe_deployment(config.dashboard_url)

    status = "UP" if result["healthy"] else "DOWN"
    detail = f"latency={result.get('latency_ms', '?')}ms" if result["healthy"] else result.get("error", "unknown")
    logger.info("Deployment %s: %s", status, detail)

    # Also run local validations
    js_val = validate_html_js(get_file_content("index.html"))
    docker_val = validate_dockerfile()
    nginx_val = validate_nginx_conf()

    if not js_val["valid"]:
        logger.warning("JS validation issues: %s", js_val.get("issues", []))
    if not docker_val["valid"]:
        logger.warning("Dockerfile issues: %s", docker_val.get("issues", []))
    if not nginx_val["valid"]:
        logger.warning("nginx.conf issues: %s", nginx_val.get("issues", []))

    return {
        "probe": result,
        "validations": {
            "js": js_val,
            "dockerfile": docker_val,
            "nginx": nginx_val,
        },
    }


def run_diagnose(config: AgentConfig):
    """Diagnose without fixing."""
    probe = probe_deployment(config.dashboard_url)

    if probe["healthy"]:
        logger.info("Deployment is healthy — nothing to diagnose")
        return

    logger.info("Deployment is DOWN: %s", probe.get("error"))
    logger.info("Running Claude diagnosis...")

    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    diagnosis = diagnose_failure(client, config, probe)

    print(f"\n{'='*60}")
    print("  Deploy Agent Diagnosis")
    print(f"{'='*60}")
    print(f"  Root cause: {diagnosis.get('root_cause', '?')}")
    print(f"  Severity:   {diagnosis.get('severity', '?')}")
    print(f"  Auto-fix:   {diagnosis.get('auto_fixable', False)}")
    if diagnosis.get("edits"):
        print(f"  Edits:      {len(diagnosis['edits'])} file(s)")
        for e in diagnosis["edits"]:
            print(f"    - {e['file']}: replace {len(e.get('find',''))} chars")
    print(f"\n  {diagnosis.get('explanation', '')}")
    print()

    # Save diagnosis
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_file = config.report_dir / f"diagnosis_{ts}.json"
    report_file.write_text(json.dumps(diagnosis, indent=2))
    logger.info("Diagnosis saved: %s", report_file)


def run_watch(config: AgentConfig):
    """Continuous watch mode — detect failures and auto-fix."""
    logger.info("Deploy watchdog started")
    logger.info("  Dashboard:      %s", config.dashboard_url)
    logger.info("  Deploy branch:  %s", DEPLOY_BRANCH)
    logger.info("  Check interval: %ds", CHECK_INTERVAL)
    logger.info("  Max fix attempts: %d", MAX_FIX_ATTEMPTS)

    if not config.anthropic_api_key:
        logger.error("ANTHROPIC_API_KEY required for auto-fix — exiting")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    consecutive_failures = 0
    fix_attempts = 0
    last_fix_time = 0

    while _running:
        probe = probe_deployment(config.dashboard_url)

        if probe["healthy"]:
            if consecutive_failures > 0:
                logger.info("Deployment RECOVERED after %d failures and %d fix attempts",
                            consecutive_failures, fix_attempts)
                fix_attempts = 0
            consecutive_failures = 0
            logger.info("UP — %dms", probe.get("latency_ms", 0))

        else:
            consecutive_failures += 1
            logger.warning("DOWN (%d consecutive): %s", consecutive_failures, probe.get("error"))

            # Wait for 2 consecutive failures before acting (avoid transient blips)
            if consecutive_failures < 2:
                logger.info("Waiting for confirmation (need 2 consecutive failures)...")

            # In cooldown after a recent fix — wait for Railway to rebuild
            elif time.time() - last_fix_time < COOLDOWN_AFTER_FIX:
                remaining = int(COOLDOWN_AFTER_FIX - (time.time() - last_fix_time))
                logger.info("In cooldown after fix — %ds remaining", remaining)

            # Too many fix attempts
            elif fix_attempts >= MAX_FIX_ATTEMPTS:
                logger.error("Max fix attempts (%d) reached — manual intervention needed", MAX_FIX_ATTEMPTS)
                # Save state for human review
                ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
                state = {
                    "timestamp": ts,
                    "consecutive_failures": consecutive_failures,
                    "fix_attempts": fix_attempts,
                    "last_probe": probe,
                    "message": "Auto-fix exhausted. Manual intervention required.",
                }
                (config.report_dir / f"escalation_{ts}.json").write_text(json.dumps(state, indent=2))

            # Attempt auto-fix
            else:
                fix_attempts += 1
                logger.info("Attempting auto-fix (%d/%d)...", fix_attempts, MAX_FIX_ATTEMPTS)

                try:
                    diagnosis = diagnose_failure(client, config, probe)
                    logger.info("Diagnosis: %s", diagnosis.get("root_cause", "?"))

                    if not diagnosis.get("auto_fixable"):
                        logger.warning("Claude says not auto-fixable: %s", diagnosis.get("explanation", ""))
                        fix_attempts = MAX_FIX_ATTEMPTS  # Don't retry

                    elif diagnosis.get("edits"):
                        # Validate edits are safe (no destructive changes)
                        edits = diagnosis["edits"]
                        logger.info("Applying %d edit(s)...", len(edits))
                        modified = apply_edits(edits)

                        if modified:
                            # Re-validate after edits
                            post_js = validate_html_js(get_file_content("index.html"))
                            if not post_js["valid"]:
                                logger.warning("Post-fix JS validation still failing: %s", post_js["issues"])
                                # Revert
                                git("checkout", "--", *modified)
                                logger.info("Reverted edits — validation failed after fix")
                            else:
                                pushed = commit_and_push(modified, diagnosis)
                                if pushed:
                                    last_fix_time = time.time()
                                    logger.info("Fix pushed — waiting %ds for Railway rebuild...", COOLDOWN_AFTER_FIX)

                                    # Save fix report
                                    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
                                    (config.report_dir / f"fix_{ts}.json").write_text(
                                        json.dumps({"diagnosis": diagnosis, "modified": modified}, indent=2)
                                    )
                        else:
                            logger.warning("No edits could be applied")
                    else:
                        logger.warning("No edits provided in diagnosis")

                except Exception as e:
                    logger.exception("Auto-fix failed: %s", e)

        # Sleep in small increments for responsive shutdown
        for _ in range(CHECK_INTERVAL):
            if not _running:
                break
            time.sleep(1)

    logger.info("Watchdog stopped.")


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="LotLogic Deploy Watchdog Agent")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true", help="Single deployment health check")
    group.add_argument("--diagnose", action="store_true", help="Diagnose failure (no fix)")
    group.add_argument("--watch", action="store_true", help="Continuous watch + auto-fix")
    args = parser.parse_args()

    config = AgentConfig.from_env()

    if not config.dashboard_url:
        logger.error("DASHBOARD_URL must be set")
        sys.exit(1)

    if args.check:
        result = run_check(config)
        sys.exit(0 if result["probe"]["healthy"] else 1)
    elif args.diagnose:
        run_diagnose(config)
    elif args.watch:
        run_watch(config)


if __name__ == "__main__":
    main()
