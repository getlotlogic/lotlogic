# LotLogic — Disaster Recovery & Handoff Runbook

**Last updated:** 2026-06-05 · **Owner:** Standard Vending Company (gabriel@lotlogicparking.com)

Purpose: everything needed to (a) give a teammate full access and (b) rebuild
the entire operation if this laptop / any single account were lost. Two repos
back this system:
- `getlotlogic/lotlogic` (this repo) — frontend dashboard + QR forms (Vercel), Supabase **edge functions**, puller/monitoring workers, leadgen, Cloudflare worker.
- `getlotlogic/lotlogic-backend` — FastAPI backend (Railway), DB migrations, `recovery/` DB artifacts.

> **No secret VALUES live in git.** This runbook lists secret *names* and where
> their values live. The values themselves belong in a shared password manager
> (see §9). Anything marked 🔑 is a secret to put in the vault.

---

## 1. "If the laptop died right now" — current status
- ✅ **Code**: both repos pushed to GitHub. Recoverable.
- ✅ **Running infra**: Vercel/Railway/Supabase/Cloudflare are cloud-hosted, not on the laptop.
- ✅ **Edge functions**: 16 of the 18 live functions are in git. `test-resend-probe` and `system-notice` are deployed with no source here — see §4.
- ⚠️ **Secrets**: real values live only in laptop `.env*` files + provider dashboards + this person's head. → vault (§9).
- ✅ **DB schema**: rebuilds from git (`scripts/db/migrate.sh --baseline`), proven by CI. ⚠️ **DB data**: Supabase backups only → still CONFIRM (§7).
- ⚠️ **Claude memory** (`~/.claude/.../memory/`): institutional knowledge, laptop-only → back up (§9).
- ⚠️ **pg_cron, Railway cron, DNS, Email Routing**: console-only state → documented here, recreate by hand.

---

## 2. Accounts & access matrix — invite the teammate to each
Give the teammate his **own login/seat** wherever the service supports it (own
audit trail, independently revocable). Single-secret services → shared vault (§9).

| Service | What it runs | How to add teammate |
|---|---|---|
| **GitHub** `getlotlogic` org | All source | Org → People → invite as Owner/Member |
| **Vercel** team `gabebs1-2452s-projects` | Frontend `lotlogicparking.com/app` | Team → Members → invite |
| **Railway** | Backend API + workers + QB cron | Project → Members → invite |
| **Supabase** project `nzdkoouoaedbbccraoti` | DB, auth, edge fns, storage, cron | Org → Team → invite |
| **Cloudflare** acct `25eda16dfb7e7c04951ac81d1b7069e4` | DNS, Email Routing, R2, Workers | Manage Account → Members → invite |
| **QuickBooks Online** (realm #9341456900947821) | Tow invoicing | Intuit → Manage Users → invite |
| **Plate Recognizer** | Plate OCR (paid) | Account → team, or share key via vault |
| **Cloudflare R2** | Snapshot/evidence storage | Covered by Cloudflare invite |
| **ZeroTier** | Private camera mesh | Central → network → share; teammate joins own node (§8) |
| **Resend** | Outbound email | Team invite or shared key |
| **Twilio** | SMS (not live) | Console → teammate |
| **Simbase** | 4G SIM usage | Shared key |
| **Anthropic / Claude** | Claude Code seats | Teammate gets own Pro/Max seat (or Team plan for one bill) |
| **Modal** | Fuzzy-config auto-tuner (out of tree) | Workspace invite |
| **Apify / SerpAPI / Hunter / Google Maps** | leadgen | Shared keys (vault) |

---

## 3. Repositories & deploy map
| Repo / path | Deploys to | Trigger |
|---|---|---|
| `lotlogic/frontend/*` | Vercel (project `lotlogic`, root dir `frontend/`) | auto on push to `main`; tagged `frontend-<ts>-<sha>` by `.github/workflows/deploy-tag.yml` |
| `lotlogic/supabase/functions/*` (all 16) | Supabase Edge | auto on push to `main` via `.github/workflows/edge-functions.yml` — type-checked and tested first, and only the slugs whose sources changed are deployed |
| `lotlogic/cloudflare-workers/email-tow-action` | Cloudflare Workers | **manual** `wrangler deploy` |
| `lotlogic/puller`, `lotlogic/monitoring` | Railway workers | auto on push — **both are the retired camera-zone pipeline; see programme fat decision 2 (turn off / delete)** |
| `lotlogic-backend` | Railway API (`lotlogic-backend-production.up.railway.app`) | auto on push to `main`; tagged `backend-<ts>-<sha>` by `.github/workflows/deploy-tag.yml` |

GitHub Actions secrets required: 🔑 `SUPABASE_ACCESS_TOKEN` (edge deploys),
🔑 `SUPABASE_URL`, 🔑 `INTERNAL_TOKEN`, the Playwright `TEST_*` account creds,
and 🔑 `VERCEL_AUTOMATION_BYPASS_SECRET` (preview e2e). The deploy-tag and
secret-scan workflows use the automatic `GITHUB_TOKEN` and need nothing added.

---

## 4. Edge functions (16 live, Supabase project `nzdkoouoaedbbccraoti`)
All need `SUPABASE_URL` + 🔑`SUPABASE_SERVICE_ROLE_KEY`.

`verify_jwt` is declared per function in `supabase/config.toml`, which the CLI
reads at deploy time — that file, not a CLI flag, is the source of truth.
**`verify_jwt=true` is not authentication**: the key it accepts is the
publishable anon key, which ships in every page of lotlogicparking.com.

**15 of the 16 are `verify_jwt = false`; only `simbase-usage` is `true`.** What actually gates each:

| Gate | Functions |
|---|---|
| 🔑`INTERNAL_TOKEN` bearer | check-violations · cron-sessions-sweep · notify-expiring-plates · tow-confirm · tow-dispatch-email · tow-dispatch-sms · cron-no-reg-sweep · cron-plate-pair-learn · weather-pull · weather-risk-eval |
| Shared secret row `public.integration_secrets['rut_watchdog']`, sent as the body's `secret` field or `X-Watchdog-Secret` | **camera-watchdog** — its callers are field RUT routers on the private ZeroTier mesh that **cannot send a Bearer header**. Do not "standardise" this onto `INTERNAL_TOKEN`: every camera uptime heartbeat would stop, and `camera-down-check` reads missing heartbeats as a site brownout |
| Trailing-path URL secret | camera-snapshot (🔑`CAMERA_SNAPSHOT_URL_SECRET`) · pr-ingest (🔑`PR_INGEST_URL_SECRET`) |
| 🔑`CAMERA_DEBUG_TOKEN` | camera-debug |
| Backend-issued HS256 JWT, verified in-function, scoped on `properties.tow_company_id` | walk-around-ocr |
| Anon key only — reads a third-party billing API, writes nothing | simbase-usage |

A camera's MAC **is** its `alpr_cameras.api_key`, the value `camera-snapshot`
matches an inbound frame against. Treat MACs as credentials: they belong in the
database and in the vault, never in source. They come back with a DB restore.

**Two functions are deployed in Supabase with no source in this repo:**
`test-resend-probe` (v34, `verify_jwt=true`) and `system-notice` (v3) — found
by Task 3 while building the deploy matrix above. Because that matrix is
computed from `supabase/functions/_ci/slugs.mjs`, which only sees what's in
this repo, neither workflow will ever deploy, update, or roll either of them
back. Their source is not reconstructable from git; recovering it means
`supabase functions download test-resend-probe` / `system-notice` against the
live project. They are not counted in the "16 live" above because that count
is this repo's deploy surface, not everything Supabase is currently running.

Deploy drift guard: the workflow is the only thing that should deploy. Before
any hand deploy, diff against the deployed copy (`supabase functions download
<slug>` or the MCP `get_edge_function`) — live source that is not in git has
happened here before.

---

## 5. Secrets inventory (NAMES only — values go in the vault, §9)
**Supabase edge secrets:** 🔑`SUPABASE_SERVICE_ROLE_KEY`, 🔑`INTERNAL_TOKEN`,
🔑`JWT_SECRET`, 🔑`PLATE_RECOGNIZER_TOKEN`, 🔑`PARKPOW_USDOT_TOKEN`,
🔑`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`/`R2_PUBLIC_BASE_URL`,
🔑`CAMERA_SNAPSHOT_URL_SECRET`, 🔑`PR_INGEST_URL_SECRET`, 🔑`CAMERA_DEBUG_TOKEN`,
🔑`RESEND_API_KEY`, `FROM_EMAIL`/`FROM_NAME`/`OWNER_CC_EMAIL`/`BACKEND_URL`,
🔑`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER`, 🔑`SIMBASE_API_KEY`.
Plus `integration_secrets['rut_watchdog']` row in the DB (used by `camera-watchdog`).

**Backend (Railway) — required to boot:** 🔑`API_KEY`, 🔑`DATABASE_URL`,
🔑`ENCRYPTION_KEY` (Fernet — see §6), 🔑`TWILIO_*`, 🔑`R2_*`, 🔑`RECAPTCHA_SECRET_KEY`.
Plus: 🔑`JWT_SECRET` (must match Supabase), 🔑`PLATE_RECOGNIZER_API_KEY`,
🔑`QUICKBOOKS_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI`/`_ENVIRONMENT`,
🔑`SENDGRID_API_KEY`, `INVOICE_FROM_EMAIL`/`INVOICE_RECIPIENT_EMAIL`,
🔑`ADMIN_API_KEY` (empty in prod), `SUPABASE_URL`, `DASHBOARD_URL`.

**Local-only secret files (back up to vault NOW):**
`/Users/gabe/lotlogic/.env.local` (Supabase service role, Cloudflare API token, R2 keys, ingest secrets),
`/Users/gabe/Documents/lotlogic/leadgen/.env` (Gmail app password, Apify, Supabase service key).

**Rotate during handoff** (have appeared in docs/bundle history per CLAUDE.md):
the shared `API_KEY`/`X-API-Key`, and anything previously committed. Put fresh
values only in the vault.

---

## 6. Cross-service coupling — get these wrong and things silently break
- **`JWT_SECRET` is a 3-way coupling**: it must be byte-identical across (1) the
  Supabase JWT secret, (2) the backend (`JWT_SECRET`), and (3) the
  `tow-dispatch-email` + `walk-around-ocr` edge functions. Mismatch → RLS rejects
  every dashboard token (blank dashboard) and tow-action / walk-around links fail.
- **`ENCRYPTION_KEY` (backend, Fernet)** encrypts QuickBooks OAuth tokens and
  camera passwords at rest. Lose/rotate it → must re-OAuth QuickBooks and re-enter
  camera creds. Preserve it across any redeploy/restore.
- **Per-camera keys** (`alpr_cameras.api_key`) live only in the DB; cameras POST
  with `X-Camera-Key`. They come back with a DB restore.

---

## 7. Database — rebuildable from git as of 2026-09-05

Measured: 51 tables (all RLS-on), 3 views, 1 matview, 70 functions, 86 policies,
28 triggers, 8 pg_cron jobs (4 of them intentionally inactive), 217 indexes.
Full state snapshot: `lotlogic-backend/recovery/db-state.md`.

**The schema now rebuilds from `lotlogic-backend/migrations/`.** One command:

```bash
cd lotlogic-backend
scripts/db/migrate.sh "$DATABASE_URL" --baseline
```

That applies `0000_baseline.prereqs.sql` (roles + extension schema; a no-op on
Supabase), then `0000_baseline.sql` (the full public schema, in pg_dump's raw
applyable order), records the 176 sealed migrations in
`supabase_migrations.schema_migrations`, seeds pg_cron (only when the `pg_cron`
extension is installed — true on Supabase, false on plain Postgres/CI, where
it's skipped with a notice instead), then applies every post-baseline
migration file, one per transaction. A clean re-run against an
already-baselined database is a no-op; a crash mid-baseline (after
`0000_baseline.sql` runs but before its manifest is fully sealed) is **not**
resumable — start over with a fresh, empty database.

CI proves this on every pull request (`schema-rebuild`), and a second job
(`schema-drift`) fails when a migration file has no applied record in
production or a production record has no file — once the one-time
`PROD_SCHEMA_READER_URL` secret is wired up (see
`lotlogic-backend/docs/db/schema-drift.md` for Gabe's setup SQL); until then it
no-ops with a notice rather than blocking PRs.

**Still not in the schema dump, still needed after a restore:**
1. `migrations/0000_baseline.cron.sql` — the 8 pg_cron jobs. `--baseline`
   applies it automatically whenever `pg_cron` is installed (a real Supabase
   restore); it's idempotent (upserts by job name), so re-running it by hand
   afterward is safe, cheap insurance. Four are recreated inactive on
   purpose; do not turn them on.
2. Table **data**. The schema is in git; the rows are not. Data recovery is a
   Supabase backup or PITR restore, and nothing else.
3. Per-camera `alpr_cameras.api_key` values — data, so item 2 covers them.

**TODO (unchanged, still the highest-priority DR gap): confirm daily backups +
PITR in the Supabase dashboard, and do one test restore.** The schema being
rebuildable does not give you back a single plate read.

---

## 8. ZeroTier (camera access) — re-provision, not file-recovery
The mesh node identity is device-specific. On a new machine: install ZeroTier,
join the network ID (record it in the vault), then **authorize the new node** in
ZeroTier Central. Camera IPs/creds are in `~/.claude/.../memory/reference_camera_access.md`
(sensitive — vault it).

---

## 9. Laptop-only assets → back these up (the actual "recover if lost" list)
1. 🔑 `/Users/gabe/lotlogic/.env.local` → vault.
2. 🔑 `/Users/gabe/Documents/lotlogic/leadgen/.env` → vault.
3. `~/.claude/projects/-Users-gabe/memory/` (34 files incl. camera creds) → vault or a **private** repo (scrub `reference_camera_access.md` if using GitHub).
4. WIP git stashes (5) + 2 orphan-branch commits in this repo → pushed to `backup/*` branches on 2026-06-05 (see `git branch -a`).
5. Pitch decks `~/Documents/*Pitch*.pptx` → confirm a cloud copy.
6. SSH keys — verify they aren't keychain-only; export to the vault if so.
7. Browser-saved logins → migrate to the password manager as source of truth.

---

## 10. Rebuild-from-zero (order matters)
1. Restore Supabase project from backup for DATA. For schema on a fresh
   project: `lotlogic-backend/scripts/db/migrate.sh "$DATABASE_URL" --baseline`,
   then `psql "$DATABASE_URL" -f lotlogic-backend/migrations/0000_baseline.cron.sql`;
   re-set all Supabase edge secrets (§5).
2. Set `JWT_SECRET` consistently across Supabase + backend + edge fns (§6).
3. Deploy edge functions: `supabase functions deploy <slug>` for each (§4).
4. Railway: recreate API service + the **Monday-06:00-ET QB invoicing cron**
   service (UI-only config: `curl -XPOST -H "X-API-Key: $ADMIN_API_KEY" .../quickbooks/run-weekly-invoicing`); set all backend env (§5).
5. Vercel: connect repo, root dir `frontend/`, push to `main`.
6. Cloudflare: DNS for `lotlogicparking.com` (keep Resend/SendGrid auth CNAMEs
   DNS-only / gray cloud), Email Routing, R2 bucket `parking-snapshots`,
   `wrangler deploy` the `email-tow-action` worker.
7. Re-OAuth QuickBooks (`/quickbooks/oauth/start`); re-set `integration_secrets['rut_watchdog']`.
8. Verify: backend `/health` 200, dashboard loads + roster shows, a test QR
   registration appears, run Playwright access-control spec.

---

## 11. Human action checklist (do these — not automatable from here)
- [ ] Create a shared **1Password/Bitwarden vault**; load every 🔑 above + the two local `.env` files.
- [ ] Invite the teammate to every service in §2.
- [ ] **Confirm Supabase daily backups + PITR** (§7).
- [ ] Rotate the legacy shared keys (§5) and store fresh values only in the vault.
- [ ] Back up `~/.claude/.../memory/` (§9.3).
- [ ] Record the ZeroTier network ID + how to authorize a new node (§8).
- [ ] Verify SSH keys aren't keychain-only (§9.6).
- [ ] Confirm the first `backend-*` and `frontend-*` tags appeared after the next deploy of each repo.
- [ ] Do one **rehearsed** rollback of the frontend (12.2) at a quiet hour, and write the elapsed time next to the procedure. A procedure nobody has ever run is a wish.

---

## 12. Rollback — how to undo a deploy

Every production deploy is tagged by CI at the moment of the push
(`.github/workflows/deploy-tag.yml` in each repo). The tag's annotation names
the tag that was live before it, so the rollback target is always one command
away:

```bash
git fetch --tags origin
git tag --list 'backend-*'  | tail -2   # or frontend-*
git show <newest-tag> | head -8         # the annotation names the previous one
```

There is no staging environment (that is Wave 3.3), so every rollback below is
performed against production. Tell someone before you start.

### 12.1 Backend (Railway)

Railway builds this repo's `main` with the Dockerfile and serves it at
`lotlogic-backend-production.up.railway.app`.

1. Find the target: `git show $(git tag --list 'backend-*' | tail -1) | head -8`
   → the line `Previous production tag: backend-…` is where you are going.
2. **Railway dashboard → project → the API service → Deployments.** Find the
   deployment whose commit is that tag's SHA (the tag name ends in the short
   SHA). Use **Redeploy** on it. Railway rebuilds that commit; it does not
   change what is on `main`.
3. Watch `/ready` — not `/health`. `/health` answers "ok" without touching the
   database and stayed green through both August wedges.
   `watch -n5 'curl -s -o /dev/null -w "%{http_code}\n" https://lotlogic-backend-production.up.railway.app/ready'`
   Expect `200` within about 90 seconds.
4. **Then fix `main`.** A Railway redeploy is not a code change: the next push
   to `main` deploys the bad commit again. Either `git revert <bad sha>` and
   push, or ship the fix forward. Until you do, the running code and `main`
   disagree — say so in the channel.
5. **If the bad deploy included a migration**, the rollback is not complete:
   Railway redeploying old code against a new schema is its own outage. Stop,
   read `recovery/db-state.md` and `docs/db/schema-drift.md`, and roll the schema
   back first. Wave 2.4 (#84) gives you the tools: `migrations/0000_baseline.sql`
   plus `scripts/db/migrate.sh` rebuild any schema from git, and
   `scripts/db/check_drift.py` tells you where production and `migrations/`
   disagree. There is still no automatic *down* migration — take a `pg_dump`
   first and write down what you undo as you undo it.

### 12.2 Frontend (Vercel)

Vercel builds `frontend/` from `main` on push.

1. Find the target tag as above, with `frontend-*`.
2. **Vercel dashboard → project `lotlogic` (team `gabebs1-2452s-projects`) →
   Deployments.** Find the Production deployment built from that tag's commit
   and use **Instant Rollback**. This is an alias switch, not a rebuild — it
   takes seconds and cannot fail on a build error. Equivalent via CLI, run
   locally/by hand — never in CI, since no Vercel token exists in Actions:
   `vercel rollback <deployment-url-or-id> --token=$VERCEL_TOKEN`.
3. Verify: load `https://lotlogicparking.com/app` in a private window and check
   that the dashboard renders and a property's roster loads. Then load the QR
   page for the plaza (`/visit?...`) — that is the surface a driver standing in
   a lot is using.
4. **Then fix `main`**, same reasoning as 12.1: the next push re-deploys the bad
   commit and silently un-does the rollback.

### 12.3 Edge functions (Supabase)

Supabase keeps no deployment history and has no rollback button. Redeploying the
old source **is** the rollback, and `.github/workflows/edge-functions.yml` can do
it from a tag.

1. **GitHub → Actions → "Edge functions" → Run workflow.**
2. Set **ref** to the `frontend-*` tag you want back, and **only** to the slug(s)
   to restore — e.g. `ref: frontend-20260914-1130-a1b2c3d`, `only: camera-snapshot`.
   `only` is a required input: a blank `only` is rejected by the workflow
   (`slugsForOnly()` in `supabase/functions/_ci/slugs.mjs` throws
   `workflow_dispatch needs \`only\`: a comma-separated slug list, or \`all\`.`
   before anything deploys). If you do not know which function broke, type
   **`only: all`** explicitly to redeploy every function from that ref.
3. The run type-checks and tests before it deploys, so a rollback to a commit
   that was itself broken fails loudly instead of shipping.
4. Verify the one that matters — the camera path:
   ```sql
   -- most recent frame the pipeline accepted
   select id, camera_id, plate_text, created_at
     from plate_events order by created_at desc limit 5;
   ```
   A gap that starts at the bad deploy and does not close within a few minutes
   of the rollback means the rollback did not take. Check the function's logs
   (`mcp__supabase__query_logs`, service `edge-function`).
5. **Then fix `main`**, same reasoning: the next push to `main` deploys the bad
   source again.
6. `camera-snapshot`, `pr-ingest` and `cron-sessions-sweep` write to the database
   on every invocation. Rolling one of them back does not un-write what the bad
   version wrote. Check `plate_events`, `visitor_passes` and `alpr_violations`
   for rows created during the bad window before you call it done.

### 12.4 What is NOT covered here

- **Database schema.** See §7 and `lotlogic-backend/recovery/db-state.md`.
  Wave 2.4 owns making this a procedure.
- **Git history rewrites.** Credentials that were committed and later removed are
  still in history. Removing them means a force-push that invalidates every
  clone and every open PR. Not an emergency operation; decide it deliberately.
- **Cloudflare Worker (`email-tow-action`)**: `wrangler rollback` from the
  `cloudflare-workers/email-tow-action` directory; it deploys by hand, so it is
  not tagged.
