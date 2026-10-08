# LotLogic Playwright tests

Continuous end-to-end coverage for the dashboard, access control, and accessibility.

## Suites

- `e2e/access-control.spec.ts` — verifies each account can only see its own properties, across the UI, URL tampering, and direct API calls. This is the functional proof that the authz system works.
- `e2e/dashboard-smoke.spec.ts` — golden-path login, navigation, logout, offline resilience. Catches UX regressions.
- `a11y/axe.spec.ts` — axe-core sweep of public + logged-in pages. Fails on `serious`/`critical`; `minor`/`moderate` are reported but non-blocking.

## Running locally

```bash
cd tests
npm install
npx playwright install --with-deps chromium

# Point at your target. Defaults to the live beta URL.
export BASE_URL=https://lotlogic-beta.vercel.app
export API_URL=https://lotlogic-backend-production.up.railway.app

# Seeded test accounts (see scripts/seed-test-accounts.mjs)
export TEST_OWNER_A_EMAIL=playwright-owner-a@lotlogic.test
export TEST_OWNER_A_PASSWORD=...
export TEST_OWNER_B_EMAIL=playwright-owner-b@lotlogic.test
export TEST_OWNER_B_PASSWORD=...
export TEST_PARTNER_A_EMAIL=playwright-partner-a@lotlogic.test
export TEST_PARTNER_A_PASSWORD=...

npm test                # full suite
npm run test:access     # just access control
npm run test:smoke      # just smoke
npm run test:a11y       # just accessibility
npm run test:ui         # interactive UI mode
npm run report          # open the last HTML report
```

## Seeding test accounts

The seed script creates two owners and one enforcement partner, each with a password,
and assigns one lot to each owner so cross-tenant checks have real rows to compare.

```bash
ADMIN_API_KEY=... npm run seed
```

The backend exposes `POST /auth/seed-test-account` guarded by `ADMIN_API_KEY`.

## CI

`.github/workflows/playwright.yml` runs the full suite on every push and PR, against
the Vercel preview URL when available, otherwise the live beta. Test accounts are
read from GitHub Actions secrets.

## Portal suite (`@portal`) — local backend only

The N Style communication portal (signup → code → hold → Lookup, the office
Requests section, N Style's Requests tab, the portal access-control and axe
scans) runs against a **local** backend and a throwaway Postgres — never
production. Every portal spec calls `skipUnlessPortal()`, so without
`PORTAL_E2E=1` the whole suite reports as **skipped**, not failed.

| Spec | What it proves |
|---|---|
| `e2e/portal-end-to-end.spec.ts` | The acceptance path on `mobile-safari`: `/join/nstyle` → seven fields → `/app` with the You're-in card and the plate field in the viewport → first hold opens the code sheet → `482190` → "Email confirmed" → `H-` row → "Sent to N Style ✓" → N Style's Lookup: green on the property, amber partner-wide, Confirm, green partner-wide. Records the wall-clock time from `/join` to the hold as the `acceptance-path-ms` annotation. |
| `e2e/signup.spec.ts` | Places autocomplete (skipped without `VITE_GOOGLE_MAPS_KEY`), the ZIP-blur twin match, existing email → sign in → prefilled add-property form, password reset, and the code sheet's wrong / expired / exhausted / cooldown states. |
| `e2e/requests.spec.ts` | "sending" toast, Undo leaves the `removed` notice `cancelled`, the T-1 h `ack_end` link changes nothing, Extend "1 of 4", the 409 that flags the row and its Extend. |
| `e2e/partner-requests.spec.ts` | Got it → Seen, Decline needs a reason, Not ours archives + declines + mails. One test is `test.fail` — see the comment on it (a known backend defect). |
| `e2e/access-control.spec.ts` (`@portal` block) | Office A gets 404 on office B's requests and invite route; a session JWT cannot insert a `verified` property through PostgREST (`42501`). |
| `a11y/*` | Under `PORTAL_E2E` the `requests-owner`, `requests-partner` and `request-action-preview` scans get real rows and a real token. `WAIVED` stays empty. |

### Run it

```bash
# 1. Backend: a lotlogic-backend worktree with the portal branches merged.
cd ~/lotlogic-backend-<worktree>
python3.11 -m venv .venv && .venv/bin/pip install -q -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m tests.portal.cluster          # leave running; prints DATABASE_URL / PG_PLAIN_URL

# 2. In another shell, the backend on :8010. DEBUG makes SIGNUP_TEST_CODE the
#    6-digit code every issue_code mints and skips reCAPTCHA; the CORS origin is
#    the fixed one the suite serves the build on. All values are throwaway.
DEBUG=true JWT_SECRET=portal-test-secret API_KEY=test ADMIN_API_KEY=test \
SIGNUP_TEST_CODE=482190 RECAPTCHA_SECRET_KEY= CORS_ALLOWED_ORIGINS=http://127.0.0.1:4173 \
TWILIO_ACCOUNT_SID=test TWILIO_AUTH_TOKEN=test TWILIO_FROM_NUMBER=+15555555555 \
R2_ACCOUNT_ID=test R2_ACCESS_KEY_ID=test R2_SECRET_ACCESS_KEY=test R2_PUBLIC_URL=https://test.invalid \
ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
DATABASE_URL=<DATABASE_URL from step 1> .venv/bin/uvicorn main:app --port 8010

# 3. Accounts. The backend's email validator refuses the reserved `.test`
#    TLD, so the portal run uses e2e.lotlogic.dev addresses.
cd ~/lotlogic/tests
export PORTAL_E2E=1 API_URL=http://localhost:8010
export PORTAL_TEST_PG_URL=<PG_PLAIN_URL from step 1>
export PORTAL_BACKEND_DIR=~/lotlogic-backend-<worktree>      # mints /r/<token> links
export TEST_OWNER_A_EMAIL=pw-owner-a@e2e.lotlogic.dev   TEST_OWNER_A_PASSWORD=playwright-a-pw-please-rotate
export TEST_OWNER_B_EMAIL=pw-owner-b@e2e.lotlogic.dev   TEST_OWNER_B_PASSWORD=playwright-b-pw-please-rotate
export TEST_PARTNER_A_EMAIL=pw-partner-a@e2e.lotlogic.dev TEST_PARTNER_A_PASSWORD=playwright-partner-pw-please-rotate
psql "$PORTAL_TEST_PG_URL" -c "INSERT INTO public.markets (name, state) SELECT 'Charlotte','NC' WHERE NOT EXISTS (SELECT 1 FROM public.markets)"
ADMIN_API_KEY=test npm run seed

# 4. The gate.
npx playwright test --grep @portal     # both projects; the acceptance path is mobile-safari only
npm run test:a11y
npm run test:access
```

With `PORTAL_E2E=1`, `fixtures/portalGlobalSetup.ts` builds this branch's
`frontend/` once and serves it on `http://127.0.0.1:4173` with
`vercel.json`'s rewrites (so `/join/nstyle`, `/app?…` and `/r/<token>` are
the real routes), and `BASE_URL` / `API_URL` default to that build and the
local backend. Pages reach the local backend through `window.__LOTLOGIC_API__`,
which `frontend/src/lib/e2e.js` honours only under the e2e flag and never on
the production hostnames.

### What the fixture does to the harness database

`fixtures/portal.ts` is the only place the suite touches Postgres
(`PORTAL_TEST_PG_URL`, via `psql`), and only for what a browser cannot do:
turn partner A into N Style (`signup_slug='nstyle'`); clear `auth_throttle`
(every signup comes from 127.0.0.1 — each page also presents its own fake
`X-Forwarded-For` /24); read captured mail from `outbound_notices` (nothing is
sent locally); flip a partner delivery to `sent` (the local `dispatch_now`
has no SendGrid key — the acceptance path's one DB write); move a code's
clock for the expired / exhausted / cooldown states; archive earlier runs'
properties holding the acceptance plate `ABC1234`.

The dashboard's direct Supabase reads (`db.getProperty`, legacy tables) are
answered by `fixtures/postgrestShim.ts` from the same harness database, as the
request's own JWT role under the database's own GRANTs and RLS — the
production Supabase project never sees a locally signed token, and requests to
the production API host are proxied to the local backend.

### CI

The `portal (local backend)` job in `.github/workflows/playwright.yml` runs
all of the above in the runner, and only when the repository variable
`PORTAL_E2E` is `1` — flip it after the portal backend deploys. Optional:
`PORTAL_BACKEND_REF` (variable, default `main`) and `BACKEND_REPO_TOKEN`
(secret, if `getlotlogic/lotlogic-backend` is not readable with the default
token).
