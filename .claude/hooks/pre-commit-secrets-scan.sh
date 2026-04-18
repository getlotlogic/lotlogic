#!/usr/bin/env bash
# pre-commit-secrets-scan.sh
#
# Claude Code PreToolUse hook that blocks Write/Edit ops whose proposed
# content contains any known secret token or specific leaked key values.
#
# Wired in .claude/settings.json as a PreToolUse matcher on Write|Edit
# for paths *.md, *.html, *.yml, and docs/**. We scan the *new content*
# of the tool call (`content` for Write, `new_string` for Edit) against
# a fixed list of regexes. On any match: print to stderr, exit 2 (block).
# On no match: exit 0 (allow). Stays silent on success.
#
# Self-contained — reads the JSON tool call payload from stdin, uses
# python3 stdlib only (no new dependencies).

set -u

# Save the hook payload (JSON on stdin) to a temp file so the heredoc-
# inlined python below can read it without fighting the shell for stdin.
payload_file="$(mktemp -t claude-secrets-scan.XXXXXX)"
trap 'rm -f "$payload_file"' EXIT
cat >"$payload_file"

PAYLOAD_FILE="$payload_file" python3 - <<'PY'
import json
import os
import re
import sys

# ---- Patterns ---------------------------------------------------------------
# Env-var-style tokens + well-known prefixes.
PATTERNS = [
    # Supabase service-role key env name leaking a real value.
    (r"SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['\"]?[A-Za-z0-9._-]{20,}", "SUPABASE_SERVICE_ROLE_KEY=<value>"),
    # Any JWT-shaped value following the Supabase key name.
    (r"SUPABASE_SERVICE_ROLE_KEY[^\n]{0,20}eyJ[A-Za-z0-9._-]+", "SUPABASE_SERVICE_ROLE_KEY (JWT value)"),
    # Stripe live secret keys.
    (r"\bsk_live_[A-Za-z0-9]{16,}", "Stripe sk_live_ key"),
    # QuickBooks shared secrets (pattern: QB_<anything>_SECRET=<value>).
    (r"QB_[A-Z_]*SECRET\s*[:=]\s*['\"]?[A-Za-z0-9._/+=-]{8,}", "QB_*_SECRET=<value>"),
    # Twilio auth token.
    (r"TWILIO_AUTH_TOKEN\s*[:=]\s*['\"]?[A-Za-z0-9]{20,}", "TWILIO_AUTH_TOKEN=<value>"),
    # Plate Recognizer API token.
    (r"PLATE_RECOGNIZER_TOKEN\s*[:=]\s*['\"]?[A-Za-z0-9]{16,}", "PLATE_RECOGNIZER_TOKEN=<value>"),
    # Generic AWS access-key IDs.
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access-key id"),
    # Generic 'Bearer <jwt>' with a long JWT body.
    (r"Bearer\s+eyJ[A-Za-z0-9._-]{40,}", "Bearer JWT token"),
    # The specific API key value previously checked into backend/CLAUDE.md.
    # (Starts with 'UJn9' per internal incident notes.) We match the prefix
    # plus some follow-on body so plain prose mentioning 'UJn9' doesn't trip.
    (r"UJn9[A-Za-z0-9._-]{8,}", "Leaked API key starting with UJn9"),
]

# ---- Read Claude Code tool-call payload from the temp file ------------------
payload_path = os.environ.get("PAYLOAD_FILE", "")
try:
    with open(payload_path, "r") as f:
        payload = json.load(f)
except Exception as e:
    # Don't block if we can't parse — fail open so legitimate work isn't lost.
    print(f"[pre-commit-secrets-scan] could not parse hook payload: {e}", file=sys.stderr)
    sys.exit(0)

tool_name = payload.get("tool_name") or payload.get("tool") or ""
tool_input = payload.get("tool_input") or payload.get("input") or {}

# Pull out whatever text this tool call is about to write.
candidate_texts = []
if tool_name in ("Write", "write"):
    candidate_texts.append(tool_input.get("content", "") or "")
elif tool_name in ("Edit", "edit"):
    candidate_texts.append(tool_input.get("new_string", "") or "")
elif tool_name in ("MultiEdit", "multiedit"):
    for edit in tool_input.get("edits", []) or []:
        candidate_texts.append(edit.get("new_string", "") or "")
else:
    # Not a write-type tool; allow.
    sys.exit(0)

text = "\n".join(candidate_texts)
if not text.strip():
    sys.exit(0)

# ---- Scan -------------------------------------------------------------------
hits = []
for pattern, label in PATTERNS:
    if re.search(pattern, text):
        hits.append(label)

if hits:
    file_path = tool_input.get("file_path") or tool_input.get("path") or "<unknown>"
    print("", file=sys.stderr)
    print("[pre-commit-secrets-scan] BLOCKED — proposed change looks like it contains a secret.", file=sys.stderr)
    print(f"  file: {file_path}", file=sys.stderr)
    print(f"  match(es): {', '.join(sorted(set(hits)))}", file=sys.stderr)
    print("  If this is a false positive, use a placeholder (e.g. <REDACTED>) or move the", file=sys.stderr)
    print("  value into an env var reference rather than inlining it in markdown/HTML/YAML.", file=sys.stderr)
    sys.exit(2)

sys.exit(0)
PY
