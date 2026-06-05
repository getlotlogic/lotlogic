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
- ✅ **Edge functions**: all 17 live functions now in git (4 were pulled back in on 2026-06-05).
- ⚠️ **Secrets**: real values live only in laptop `.env*` files + provider dashboards + this person's head. → vault (§9).
- ⚠️ **DB**: schema can't be rebuilt from `migrations/` alone; depends on Supabase backups → CONFIRM (§7).
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
| `lotlogic/frontend/*` | Vercel (project `lotlogic`, root dir `frontend/`) | auto on push to `main` |
| `lotlogic/supabase/functions/camera-snapshot` | Supabase Edge | auto via `.github/workflows/auto-deploy-camera-snapshot.yml` |
| `lotlogic/supabase/functions/cron-sessions-sweep` | Supabase Edge | auto via `auto-deploy-cron-sessions-sweep.yml` |
| all other edge functions | Supabase Edge | **manual** `supabase functions deploy <slug> --project-ref nzdkoouoaedbbccraoti` |
| `lotlogic/cloudflare-workers/email-tow-action` | Cloudflare Workers | **manual** `wrangler deploy` (now in git as of 2026-06-05) |
| `lotlogic/puller`, `lotlogic/monitoring` | Railway workers | auto on push |
| `lotlogic-backend` | Railway API (`lotlogic-backend-production.up.railway.app`) | auto on push to `main` |

GitHub Actions secrets required: 🔑 `SUPABASE_ACCESS_TOKEN`, 🔑 `SUPABASE_URL`,
🔑 `INTERNAL_TOKEN`, and the Playwright `TEST_*` account creds.

---

## 4. Edge functions (17 live, Supabase project `nzdkoouoaedbbccraoti`)
All are `verify_jwt=false` except `simbase-usage` + `test-resend-probe`. All need
`SUPABASE_URL` + 🔑`SUPABASE_SERVICE_ROLE_KEY`; cron/internal ones also 🔑`INTERNAL_TOKEN`.

camera-snapshot · pr-ingest · camera-debug · cron-sessions-sweep · cron-no-reg-sweep ·
cron-plate-pair-learn · check-violations · notify-expiring-plates · tow-dispatch-email ·
tow-confirm · tow-dispatch-sms · simbase-usage · weather-pull · weather-risk-eval ·
camera-watchdog · walk-around-ocr · test-resend-probe (throwaway — can delete).

Deploy drift guard: before overwriting any function, diff against the deployed
copy (`supabase functions download <slug>` or the MCP `get_edge_function`).

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

## 7. Database — see `lotlogic-backend/recovery/db-state.md`
46 tables (all RLS-on), 66 functions, 80 policies, 26 triggers, 5 pg_cron jobs.
**Migrations cannot rebuild the schema** (30+ unfiled). Authoritative recovery =
Supabase backup. **TODO: confirm daily backups + PITR are enabled in the Supabase
dashboard.** pg_cron jobs are in `lotlogic-backend/recovery/pg_cron.sql` (recreate
after any restore).

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
1. Restore Supabase project from backup (or new project + `pg_dump`); enable
   extensions; run `recovery/pg_cron.sql`; re-set all Supabase edge secrets (§5).
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
