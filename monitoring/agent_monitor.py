#!/usr/bin/env python3
"""
LotLogic Autonomous Monitoring Agent

Continuously monitors the LotLogic parking enforcement system and uses Claude
to analyze issues, suggest improvements, and generate reports.

Usage:
    # Single health check
    python agent_monitor.py --once

    # Continuous monitoring (runs forever)
    python agent_monitor.py --daemon

    # Deep analysis with Claude
    python agent_monitor.py --analyze

    # Generate improvement report
    python agent_monitor.py --report
"""

import argparse
import json
import logging
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import anthropic

from agent_config import AgentConfig
from agent_tools import run_all_checks

# ── Logging Setup ────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("lotlogic.agent")

# Graceful shutdown
_running = True


def _handle_signal(signum, frame):
    global _running
    logger.info("Received signal %s, shutting down gracefully...", signum)
    _running = False


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


# ── Claude Analysis ──────────────────────────────────────────────────────────

def analyze_with_claude(client: anthropic.Anthropic, config: AgentConfig, health_data: dict) -> str:
    """Send health check results to Claude for intelligent analysis."""
    system_prompt = """You are the LotLogic System Monitor — an AI operations analyst for a parking
enforcement platform. You analyze system health data and provide actionable insights.

The system consists of:
- Frontend: React SPA deployed on Railway (nginx + Docker)
- Backend: Python API on Railway
- Database: Supabase (PostgreSQL)
- AI Pipeline: YOLO vehicle detection → Plate Recognizer OCR → violation creation
- Cameras: IP cameras sending snapshots every 30 seconds

Your job is to:
1. Identify issues and their severity (critical/warning/info)
2. Explain root causes in plain language
3. Suggest specific, actionable fixes
4. Track trends over time (improving/degrading/stable)
5. Prioritize issues by business impact

Format your response as a structured report with sections."""

    response = client.messages.create(
        model=config.model,
        max_tokens=4096,
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": f"""Analyze this system health check data and provide a status report with recommendations:

```json
{json.dumps(health_data, indent=2)}
```

Provide:
1. Executive summary (1-2 sentences)
2. Issues found (bullet list with severity)
3. Recommended actions (prioritized)
4. System health score (0-100)"""
        }],
    )

    return next((b.text for b in response.content if b.type == "text"), "")


def generate_improvement_plan(client: anthropic.Anthropic, config: AgentConfig, health_data: dict) -> str:
    """Use Claude to generate a detailed improvement plan."""
    system_prompt = """You are a senior software architect reviewing the LotLogic parking enforcement
system. Generate a detailed improvement plan based on the current system state.

Focus on:
- AI detection accuracy (YOLO model, plate recognition, vehicle classification)
- System reliability (uptime, error rates, latency)
- User experience (dashboard responsiveness, data quality display)
- Revenue optimization (faster enforcement, better plate reads)
- Scalability (handling more cameras, lots, violations)

Be specific — include exact changes, file paths, API calls, and configuration values."""

    response = client.messages.create(
        model=config.model,
        max_tokens=8192,
        thinking={"type": "adaptive"},
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": f"""Based on this health data, create a prioritized improvement plan:

```json
{json.dumps(health_data, indent=2)}
```

For each improvement:
1. Title and priority (P0-P3)
2. Current state vs desired state
3. Exact implementation steps
4. Expected impact on key metrics
5. Effort estimate (hours)"""
        }],
    )

    return next((b.text for b in response.content if b.type == "text"), "")


# ── Alert System ─────────────────────────────────────────────────────────────

def send_alert(config: AgentConfig, subject: str, body: str):
    """Send alert via Slack webhook (if configured)."""
    if not config.slack_webhook_url:
        logger.info("Alert (no Slack configured): %s", subject)
        return

    import requests
    try:
        requests.post(
            config.slack_webhook_url,
            json={"text": f"*{subject}*\n{body}"},
            timeout=10,
        )
    except Exception as e:
        logger.error("Failed to send Slack alert: %s", e)


# ── Report Persistence ───────────────────────────────────────────────────────

def save_report(config: AgentConfig, report_type: str, data: dict | str):
    """Save a report to the reports directory."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = config.report_dir / f"{report_type}_{ts}.json"

    content = data if isinstance(data, str) else json.dumps(data, indent=2)
    filename.write_text(content)
    logger.info("Report saved: %s", filename)
    return filename


def save_health_log(config: AgentConfig, health_data: dict):
    """Append health check to rolling log file."""
    log_file = config.log_dir / "health_log.jsonl"
    with open(log_file, "a") as f:
        f.write(json.dumps(health_data) + "\n")


# ── Main Modes ───────────────────────────────────────────────────────────────

def run_once(config: AgentConfig):
    """Run a single health check and print results."""
    logger.info("Running single health check...")
    results = run_all_checks(config)

    print(f"\n{'='*60}")
    print(f"  LotLogic Health Check — {results['timestamp']}")
    print(f"  Overall: {results['overall'].upper()}")
    print(f"{'='*60}")

    for name, check in results["checks"].items():
        icon = {"ok": "+", "warning": "!", "error": "X"}.get(check["status"], "?")
        print(f"  [{icon}] {name}: {check['details']}")

    print()
    save_health_log(config, results)

    # Alert on errors
    errors = [
        f"{name}: {check['details']}"
        for name, check in results["checks"].items()
        if check["status"] == "error"
    ]
    if errors:
        send_alert(config, "LotLogic Health Alert", "\n".join(errors))

    return results


def run_analyze(config: AgentConfig):
    """Run health check + Claude analysis."""
    results = run_once(config)

    if not config.anthropic_api_key:
        logger.error("ANTHROPIC_API_KEY not set — cannot run Claude analysis")
        return

    logger.info("Sending data to Claude for analysis...")
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    analysis = analyze_with_claude(client, config, results)

    print(f"\n{'='*60}")
    print("  Claude Analysis")
    print(f"{'='*60}")
    print(analysis)

    save_report(config, "analysis", {"health": results, "analysis": analysis})


def run_report(config: AgentConfig):
    """Generate a full improvement plan."""
    results = run_once(config)

    if not config.anthropic_api_key:
        logger.error("ANTHROPIC_API_KEY not set — cannot generate report")
        return

    logger.info("Generating improvement plan with Claude...")
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    plan = generate_improvement_plan(client, config, results)

    print(f"\n{'='*60}")
    print("  LotLogic Improvement Plan")
    print(f"{'='*60}")
    print(plan)

    report_path = save_report(config, "improvement_plan", plan)
    print(f"\nSaved to: {report_path}")


def run_daemon(config: AgentConfig):
    """Run continuously with scheduled checks."""
    logger.info("Starting LotLogic monitoring daemon...")
    logger.info("  Health check interval: %ds", config.health_check_interval)
    logger.info("  Deep analysis interval: %ds", config.deep_analysis_interval)

    client = None
    if config.anthropic_api_key:
        client = anthropic.Anthropic(api_key=config.anthropic_api_key)
        logger.info("  Claude analysis: enabled (model: %s)", config.model)
    else:
        logger.warning("  Claude analysis: disabled (no API key)")

    last_health = 0
    last_analysis = 0
    consecutive_errors = 0

    while _running:
        now = time.time()

        # Health check
        if now - last_health >= config.health_check_interval:
            try:
                results = run_all_checks(config)
                save_health_log(config, results)

                if results["overall"] == "error":
                    consecutive_errors += 1
                    errors = [
                        f"{n}: {c['details']}"
                        for n, c in results["checks"].items()
                        if c["status"] == "error"
                    ]
                    logger.error("Health check FAILED (%d consecutive): %s",
                                 consecutive_errors, "; ".join(errors))
                    if consecutive_errors >= 3:
                        send_alert(config, "CRITICAL: LotLogic System Errors",
                                   f"{consecutive_errors} consecutive failures:\n" + "\n".join(errors))
                else:
                    if consecutive_errors > 0:
                        logger.info("System recovered after %d errors", consecutive_errors)
                    consecutive_errors = 0
                    logger.info("Health check OK: %s",
                                "; ".join(f"{n}={c['status']}" for n, c in results["checks"].items()))

                last_health = now
            except Exception as e:
                logger.exception("Health check crashed: %s", e)

        # Deep analysis (with Claude)
        if client and now - last_analysis >= config.deep_analysis_interval:
            try:
                results = run_all_checks(config)
                analysis = analyze_with_claude(client, config, results)
                save_report(config, "analysis", {"health": results, "analysis": analysis})
                logger.info("Deep analysis complete")
                last_analysis = now
            except Exception as e:
                logger.exception("Deep analysis failed: %s", e)

        # Sleep in small increments for responsive shutdown
        for _ in range(10):
            if not _running:
                break
            time.sleep(1)

    logger.info("Daemon stopped.")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="LotLogic Autonomous Monitoring Agent")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--once", action="store_true", help="Run a single health check")
    group.add_argument("--daemon", action="store_true", help="Run continuously")
    group.add_argument("--analyze", action="store_true", help="Health check + Claude analysis")
    group.add_argument("--report", action="store_true", help="Generate improvement plan")
    args = parser.parse_args()

    config = AgentConfig.from_env()

    if args.once:
        run_once(config)
    elif args.daemon:
        run_daemon(config)
    elif args.analyze:
        run_analyze(config)
    elif args.report:
        run_report(config)


if __name__ == "__main__":
    main()
