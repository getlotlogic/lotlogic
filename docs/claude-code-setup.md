# Claude Code setup — `lotlogic` (frontend)

This repo ships with a project-scoped Claude Code configuration in
`.claude/` and an `.mcp.json` stub. Nothing is installed globally.

Companion setup lives in `lotlogic-backend` — see its
`docs/claude-code-setup.md`. The two bundles are designed to work
together but can be reviewed independently.

## What's wired in

### Hooks (see `.claude/settings.json`)

| Hook | Event | Behaviour |
| --- | --- | --- |
| `pre-commit-secrets-scan` | PreToolUse on `Write|Edit|MultiEdit` | **Blocks** (exit 2) when the proposed content contains `SUPABASE_SERVICE_ROLE_KEY=`, a Stripe `sk_live_` key, any `QB_*_SECRET=`, `TWILIO_AUTH_TOKEN=`, `PLATE_RECOGNIZER_TOKEN=`, an AWS `AKIA…` key id, a `Bearer eyJ…` JWT, or the specific leaked-before value that starts with `UJn9`. |
| `edge-function-checked-in` | PreToolUse on `Bash` | **Blocks** (exit 2) when the shell command is `supabase functions deploy <name>` and either (a) `supabase/functions/<name>/index.ts` doesn't exist, or (b) `supabase/functions/<name>/` has uncommitted or untracked changes. Stricter than secret-scan — edge functions are the easiest thing to deploy-before-commit. |

Both hooks are self-contained bash + python3 stdlib, `chmod +x`, no
new runtime deps. The secret-scan hook is identical to the backend
repo's copy on purpose — same rules everywhere.

### Skills (`.claude/skills/`)

- `ui-naming-rule` — **auto-loaded by Claude** when editing any user-
  facing string. Enforces "Permanent / Temporary / Driver, never
  Resident / Visitor / Guest" in UI contexts, with a clear DB-column
  exemption. Points to PRs #64 ("Rename user-facing Resident/Visitor/
  Guest → Permanent/Temporary/Driver") and #71 ("Truck-plaza: capture
  Driver Name + finish Visitor→Driver rename in edge functions") as
  canonical examples of the rename being applied.

The existing marketing skills under `.claude/skills/*` (copywriting,
email-marketing, page-cro, etc.) are unchanged by this bundle.

### Subagents (`.claude/agents/`)

- `launch-readiness-auditor` — read-only orchestrator for the pre-
  launch sweep. Frontend-repo flavour owns: edge-function drift,
  `dashboard.html` size, UI naming compliance, HTML/edge-function
  TODOs, and env parity across `vercel.json` / `railway.toml` /
  `.env.example`. For pending-migrations vs `schema_migrations`,
  call through to the matching agent in `lotlogic-backend`.

The existing marketing + planner subagents under `.claude/agents/*`
(attraction-specialist, brainstormer, etc.) are unchanged.

### MCP servers (`.mcp.json`)

Two servers are declared at the project level:

- **Supabase** — used by `launch-readiness-auditor` for
  `get_edge_function`, `list_edge_functions`, etc.
- **GitHub** — used for PR/issue workflows from inside this repo.

#### What you need to set before first use

| Env var | Where it's used | How to get it |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | `.mcp.json` args | From the Supabase dashboard → Project Settings → General → Reference ID. |
| `SUPABASE_ACCESS_TOKEN` | `.mcp.json` env | Personal access token from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens). Not the anon key, not the service role key. |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | `.mcp.json` env | Fine-grained PAT scoped to `getlotlogic/lotlogic` (and `getlotlogic/lotlogic-backend` if you want cross-repo). Needs `repo` for PR creation, `workflow` if you want to run actions, `read:org` for org context. |

#### Global-vs-project scope

If you already have Supabase and GitHub MCP servers configured
globally in `~/.claude/settings.json` or `~/.claude.json`, the
project-level `.mcp.json` will **override for this repo**. That's
fine. If you'd rather rely solely on your global config, delete this
file from the branch before merging and the subagents will still
work.

## Disabling a hook

If a hook ever gets in the way:

1. Comment out the offending entry in `.claude/settings.json`.
2. Or remove the `chmod +x` from the script.

Please don't `git rm` the script without filing a PR — these hooks
came from real incidents in the launch sprint and disabling one
should be a deliberate call.
