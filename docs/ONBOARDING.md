# LotLogic team onboarding

Hand this doc to a new collaborator. Walks them through getting access to every service in the stack.

**You'll need from Gabe:** a list of which services they should be invited to (most likely all of them) + their work email.

---

## 1. GitHub (the code)

**What's there:** Frontend dashboard, edge functions, sidecar code, scripts, docs, migrations.

**Repos:**
- `getlotlogic/lotlogic` — frontend + edge functions + sidecar + docs
- `getlotlogic/lotlogic-backend` — Python FastAPI backend

**To invite:**
- github.com → repo → **Settings** → **Collaborators and teams** → **Add people** → their GitHub username
- Role: **Write** (push + PRs) for engineers, **Admin** if they manage settings

**They do:**
```bash
git clone https://github.com/getlotlogic/lotlogic.git
cd lotlogic
cat CLAUDE.md     # project context — read this first
```

---

## 2. Claude Code (the AI assistant)

**Per-user.** No shared accounts.

**They do:**
1. Install: https://docs.claude.com/en/docs/claude-code/quickstart
2. Sign in with their Anthropic/Claude.ai account
3. Run `claude` in the cloned repo directory
4. Read `CLAUDE.md` → has all project rules + agent triggers

**What carries over:** code + `CLAUDE.md` rules + spec/plan docs in `docs/superpowers/`

**What does NOT carry over:** my conversation history, my auto-memory (`~/.claude/projects/...`). Those are per-machine. They start fresh.

---

## 3. Supabase (DB, edge functions, secrets)

**What's there:** All tables (`plate_events`, `plate_sessions`, `alpr_violations`, etc.), edge functions, secrets, RLS policies.

**To invite:**
- supabase.com → project `nzdkoouoaedbbccraoti` → **Settings** → **Team** (or **Members**) → **Invite**
- Role: **Developer** for most engineers (deploy + edit, no billing/delete-project), **Owner** for trusted leads

**They get:**
- SQL editor + DB console
- Edge function deploys via `supabase functions deploy`
- Read/write all secrets via `supabase secrets ...`
- Realtime + auth + storage console

---

## 4. Vercel (frontend hosting)

**What's there:** dashboard.html, visit.html, resident.html, marketing pages. Auto-deploys from `main`.

**To invite:**
- vercel.com → team `gabebs1-2452s-projects` → **Settings** → **Members** → invite email
- Role: **Member** is enough

**They get:**
- Build logs, preview URLs, prod promotions, rollback, env vars

---

## 5. Railway (workers, backend, sidecar)

**What's there:**
- `lotlogic-backend` (FastAPI)
- `puller` (snapshot worker)
- `monitoring` (Claude AI agent, Zone Guardian)
- `lotlogic-production` aka openalpr-sidecar (YOLOv9 + fast-plate-ocr ALPR)

**To invite:**
- railway.app → project → **Settings** → **Members** → invite

**They get:**
- Deploys, logs, env vars, restart services, billing visibility

---

## 6. Cloudflare (DNS, R2, Email Routing)

**What's there:**
- DNS for `lotlogicparking.com`
- R2 bucket `parking-snapshots` (camera images)
- Email Routing (inbound → Gmail)
- API tokens (R2 access keys live here)

**To invite:**
- dash.cloudflare.com → **Account home** → **Manage Account** → **Members** → **Invite Member**
- Role: **Super Administrator** for full, **Administrator (Read)** for read-only audit access

**They get:** DNS edits, R2 bucket management + token rotation, email routing rules

---

## 7. Plate Recognizer (paid OCR API)

**What's there:** API token used by edge function. Per-call billing.

**To share:**
- app.platerecognizer.com → **Account** → **Team** (depends on plan; Snapshot Cloud Standard supports sub-users)
- Or share the API token securely via 1Password/Bitwarden if no team feature

**Where the token lives:** Supabase secret `PLATE_RECOGNIZER_TOKEN`. Once your partner has Supabase access they have effective access via the secret list.

---

## 8. Resend (transactional email)

**What's there:** Tow dispatch emails to enforcement partners.

**To invite:**
- resend.com → **Settings** → **Team** → invite email
- Role: **Member**

**They get:** Send logs, domain settings (`lotlogicparking.com` DKIM), API keys

---

## 9. QuickBooks Online (invoicing)

**What's there:** LotLogic invoices to enforcement partners.

**To invite:**
- QuickBooks Online → **Settings** (gear) → **Manage Users** → **Add User**
- Role: **Standard user** for ops, **Company admin** for trusted finance

---

## 10. Anthropic / Claude API (used by monitoring agents)

**What's there:** API key used by `monitoring/zone_guardian.py` (and future training-curator) on Railway.

**To share:**
- console.anthropic.com → **Settings** → **Members** → invite work email
- Or just generate a separate key for them per workload

---

## 11. Domain registrar (Cloudflare for `lotlogicparking.com`)

Already covered by Cloudflare access (#6).

---

## Day-1 checklist for the partner

After invites are sent:

- [ ] Accept all invites in their email
- [ ] Clone GitHub repos
- [ ] Install Claude Code, sign in
- [ ] Read `CLAUDE.md` end to end
- [ ] Read `docs/ONBOARDING.md` (this doc)
- [ ] Read `docs/superpowers/specs/2026-04-20-alpr-pipeline-post-gut-consolidated-design.md` (the ALPR system overview)
- [ ] Verify they can: log into Supabase SQL editor, see Vercel deploys, view Railway logs, view Cloudflare R2 buckets
- [ ] Test one no-op deploy: clone, make a tiny doc edit, push, watch Vercel auto-deploy

---

## Secrets they'll need (separate from above invites)

These are not "invites" — they're shared secrets stored in 1Password or similar:

- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — needed for `scripts/export-yolo-dataset.py` and any local R2 work
- `SUPABASE_SERVICE_ROLE_KEY` — for backend scripts that need RLS bypass
- `JWT_SECRET` — only if they're working on auth code

Best practice: they use the **service-level invites** (#3-#11 above) for normal work. Direct secret-sharing is only for local scripts that can't go through service consoles.

---

## Order of operations (recommended)

1. GitHub → they can read code immediately
2. Supabase + Vercel + Railway → they can run the system end-to-end
3. Cloudflare → DNS / R2 work
4. Resend / Plate Recognizer / QuickBooks / Anthropic → as needed
