#!/usr/bin/env bash
# edge-function-checked-in.sh
#
# Claude Code PreToolUse hook on the Bash tool. Triggers when the tool
# call is `supabase functions deploy <name>`. Verifies:
#   1. supabase/functions/<name>/index.ts actually exists in the repo.
#   2. The working tree is clean for supabase/functions/<name>/ — no
#      uncommitted or untracked changes, so what's deployed matches
#      what's on disk and checked into git.
#
# On failure: exit 2 (block). On success: exit 0 (allow).
# Self-contained — reads the JSON tool call payload from stdin, uses
# bash + git + python3 stdlib only.

set -u

# Save the hook payload (JSON on stdin) to a temp file so we can hand
# it to python without fighting the shell for stdin.
payload_file="$(mktemp -t claude-edge-check.XXXXXX)"
trap 'rm -f "$payload_file"' EXIT
cat >"$payload_file"

# Extract the command string with python (safer than jq/grep dances).
cmd="$(
  PAYLOAD_FILE="$payload_file" python3 - <<'PY'
import json, os, sys
try:
    with open(os.environ["PAYLOAD_FILE"]) as f:
        payload = json.load(f)
except Exception:
    sys.exit(0)
ti = payload.get("tool_input") or payload.get("input") or {}
cmd = ti.get("command") or ti.get("cmd") or ""
sys.stdout.write(cmd)
PY
)"

# If this isn't a `supabase functions deploy <name>` call, do nothing.
# We match loosely so `env FOO=bar supabase functions deploy foo --project-ref ...`
# still parses.
if ! printf '%s' "$cmd" | grep -Eq '(^|[[:space:]])supabase[[:space:]]+functions[[:space:]]+deploy([[:space:]]|$)'; then
    exit 0
fi

# Extract the function name: the first non-flag arg after "deploy".
# Pass the command via env var so the heredoc-inlined python doesn't
# have to compete with the shell for stdin.
fn_name="$(
    FN_CMD="$cmd" python3 - <<'PY'
import os, sys
cmd = os.environ.get("FN_CMD", "")
tokens = cmd.split()
try:
    idx = next(i for i, t in enumerate(tokens)
               if t == "deploy" and i > 0 and tokens[i - 1] == "functions")
except StopIteration:
    sys.exit(0)
for t in tokens[idx + 1:]:
    if t.startswith("-"):
        continue
    print(t)
    break
PY
)"

if [ -z "${fn_name:-}" ]; then
    echo "[edge-function-checked-in] BLOCKED — could not determine the function name from:" >&2
    echo "    $cmd" >&2
    echo "  Expected shape: supabase functions deploy <name> [flags]" >&2
    exit 2
fi

# Resolve repo root so this works from any cwd inside the repo.
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fn_dir="$repo_root/supabase/functions/$fn_name"
fn_index="$fn_dir/index.ts"

# 1. File must exist on disk.
if [ ! -f "$fn_index" ]; then
    echo "[edge-function-checked-in] BLOCKED — supabase/functions/$fn_name/index.ts does not exist." >&2
    echo "  You are about to deploy an edge function that isn't in this repo." >&2
    echo "  Create the file and commit it before deploying, so the source of truth stays git." >&2
    exit 2
fi

# 2. git must be clean for that directory.
#    We check both tracked (diff) and untracked (ls-files -o) changes.
tracked_dirty="$(git -C "$repo_root" status --porcelain -- "supabase/functions/$fn_name" 2>/dev/null || true)"

if [ -n "$tracked_dirty" ]; then
    echo "[edge-function-checked-in] BLOCKED — supabase/functions/$fn_name/ has uncommitted or untracked changes:" >&2
    printf '%s\n' "$tracked_dirty" | sed 's/^/    /' >&2
    echo "  Commit (or revert) those changes before deploying so the deployed version matches git." >&2
    exit 2
fi

# All good.
exit 0
