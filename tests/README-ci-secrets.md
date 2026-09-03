# Turning the Playwright suite back on in CI

The 84-test browser suite — including `e2e/access-control.spec.ts`, the proof
that one property owner cannot see another owner's lots, violations or passes —
has never passed in GitHub Actions. Every logged-in test throws in under half a
second because three test logins were never added to the repo's Actions
secrets:

```
Error: Missing required env var TEST_OWNER_A_EMAIL. Set it in .env or CI secrets.
```

Nothing is wrong with the tests. This page is the exact, ordered sequence to fix
it. **Nothing here has been executed** — it needs a backend env var and repo
secrets, which are the owner's to set.

Everything below runs from `tests/` in `getlotlogic/lotlogic`.

---

## 0. What the workflow actually reads

`.github/workflows/playwright.yml` passes exactly **six required secrets** into
`npm test`, plus two optional ones:

| Secret | Required? | Used by | If missing |
|---|---|---|---|
| `TEST_OWNER_A_EMAIL` | **yes** | `fixtures/accounts.ts` → `accounts.ownerA()` | every logged-in test throws |
| `TEST_OWNER_A_PASSWORD` | **yes** | same | same |
| `TEST_OWNER_B_EMAIL` | **yes** | `accounts.ownerB()` — the *other* tenant in the isolation proof | same |
| `TEST_OWNER_B_PASSWORD` | **yes** | same | same |
| `TEST_PARTNER_A_EMAIL` | **yes** | `accounts.partnerA()` — the tow-partner role | same |
| `TEST_PARTNER_A_PASSWORD` | **yes** | same | same |
| `API_URL` | no | backend base URL | defaults to `https://lotlogic-backend-production.up.railway.app` |
| `VERCEL_PREVIEW_URL` | no | `BASE_URL` for the run | defaults to `https://lotlogic-beta.vercel.app` |
| `TEST_TRUCK_PLAZA_PROPERTY_ID` | no | `e2e/parking-log-smart-search.spec.ts`, `e2e/repeat-offender-chip.spec.ts` | those two specs skip with "needs a truck-plaza property with passes" |

### `TEST_TRUCK_PLAZA_PROPERTY_ID`

The parking-log smart-search suite and the repeat-offender-chip smoke test both
exercise the Truck Parking Log — a view that only exists on a `truck_plaza`
property that has passes on it. The seeded `TEST_OWNER_A` account has exactly
one legacy `lots` row (in the backend's `lots` table, not the dashboard's
`properties` table) and zero properties, so there is nothing for these specs
to open. Rather than fail on data the seed script never provisioned, both
specs skip cleanly (`test.beforeEach` → `test.skip`) whenever this var is
unset.

To turn them into real coverage: create (once, by hand or via a future seed
fixture) a `truck_plaza` property owned by `TEST_OWNER_A` with at least one
registered pass, set `TEST_TRUCK_PLAZA_PROPERTY_ID` to its id as a repo/CI
secret, and both specs will run for real instead of skipping.

Source of the requirement: `tests/fixtures/accounts.ts:11-18` (`required()`),
consumed at `:24`. Source of the plumbing:
`.github/workflows/playwright.yml`, the `env:` block of the "Run tests" step.

---

## 1. Backend prerequisite — `ADMIN_API_KEY`

The seeder calls `POST /auth/seed-test-account` on the live backend, which is
gated on an admin key:

- Set `ADMIN_API_KEY` to a fresh random value on the Railway service
  `lotlogic-backend` (Variables tab), and let the service redeploy.
- **Unset it again once seeding is done.** `CLAUDE.md` records that it must be
  empty in production; the endpoint is a no-op without it. (The audit's fat
  decision 24 goes further and moves that endpoint behind a debug-only build —
  worth doing, separately.)

```bash
# generate a throwaway key
openssl rand -hex 24
```

## 2. Choose the six values

The seeder defaults to `playwright-owner-a@lotlogic.test` etc. with placeholder
passwords that say "please-rotate" — do not ship those. Generate real ones:

```bash
for n in OWNER_A OWNER_B PARTNER_A; do
  echo "TEST_${n}_EMAIL=playwright-$(echo "$n" | tr 'A-Z_' 'a-z-')@lotlogic.test"
  echo "TEST_${n}_PASSWORD=$(openssl rand -base64 24)"
done
```

Keep that block — step 3 and step 4 both need it. These are real, permanent
logins against the production backend, so treat them like any other credential.

## 3. Seed the three accounts (the exact command)

From `tests/`, with the six values exported and `ADMIN_API_KEY` set to whatever
you put on Railway in step 1:

```bash
cd tests
npm ci

ADMIN_API_KEY='<the value from step 1>' \
API_URL='https://lotlogic-backend-production.up.railway.app' \
TEST_OWNER_A_EMAIL='...'    TEST_OWNER_A_PASSWORD='...' \
TEST_OWNER_B_EMAIL='...'    TEST_OWNER_B_PASSWORD='...' \
TEST_PARTNER_A_EMAIL='...'  TEST_PARTNER_A_PASSWORD='...' \
npm run seed
```

That runs `scripts/seed-test-accounts.mjs`, which creates two `lot_owners`
(each with its own lot — that is what makes the cross-tenant test meaningful)
and one `enforcement_partner`. Success looks like three lines:

```
seeded owner playwright-owner-a@lotlogic.test → id <uuid>
seeded owner playwright-owner-b@lotlogic.test → id <uuid>
seeded partner playwright-partner-a@lotlogic.test → id <uuid>
```

A `401`/`403` means `ADMIN_API_KEY` has not taken effect on Railway yet.

## 4. Set the six repo secrets

```bash
gh secret set TEST_OWNER_A_EMAIL     --repo getlotlogic/lotlogic --body '...'
gh secret set TEST_OWNER_A_PASSWORD  --repo getlotlogic/lotlogic --body '...'
gh secret set TEST_OWNER_B_EMAIL     --repo getlotlogic/lotlogic --body '...'
gh secret set TEST_OWNER_B_PASSWORD  --repo getlotlogic/lotlogic --body '...'
gh secret set TEST_PARTNER_A_EMAIL   --repo getlotlogic/lotlogic --body '...'
gh secret set TEST_PARTNER_A_PASSWORD --repo getlotlogic/lotlogic --body '...'

gh secret list --repo getlotlogic/lotlogic | grep TEST_   # expect 6 rows
```

(Optional, only if you want the suite to run against a preview rather than the
live beta: `gh secret set VERCEL_PREVIEW_URL --repo getlotlogic/lotlogic --body 'https://…'`.)

Use `--body-file -` and paste instead of `--body` if you would rather the
password not land in your shell history.

## 5. Verify locally first, then in CI

```bash
cd tests
TEST_OWNER_A_EMAIL='...' TEST_OWNER_A_PASSWORD='...' \
TEST_OWNER_B_EMAIL='...' TEST_OWNER_B_PASSWORD='...' \
TEST_PARTNER_A_EMAIL='...' TEST_PARTNER_A_PASSWORD='...' \
npm run test:access          # the tenant-isolation proof — this is the one that matters
```

Then in CI:

```bash
gh workflow run Playwright --repo getlotlogic/lotlogic
gh run watch --repo getlotlogic/lotlogic
```

## 6. Then, and only then, make it mandatory

A green suite that nothing depends on decays back to red. Once step 5 passes:

GitHub → Settings → Rules → New ruleset on `main`: require a pull request,
require the status check **`e2e + a11y`** (the job name in
`playwright.yml`), block force-push. That is program item 3 (DEL-4), and the
program is explicit that it must come *after* this page, or the first thing you
do is bypass your own gate.

---

## Accessibility: what was waived, and why

The program asks for the two accessibility failures to be fixed *or* explicitly
waived so the suite can reach green. They are waived, narrowly, in
`a11y/axe.spec.ts` (`WAIVED`).

Both are the same thing and neither is a mistake on the page: the brand tokens
are too light against the cream ground. `--amber #D97706` is 2.66:1 and
`--terra-deep #9A5530` is 4.27:1 against `--paper`/`--paper-2`, where AA wants
4.5:1 for body text and 3:1 for large text. Locally the same run also flags
`/pitch-tow.html`, which the CI log did not name — same tokens, same cause — so
it is waived on the same terms.

Darkening those tokens is not a test fix: they are copy-pasted into 18 HTML
files, so it is a visible change to the whole marketing site and wants the
owner's eye on the replacement colors. That work is FE-10 (darken four tokens)
riding on FE-12 (one shared stylesheet), both Wave 2.

The waiver is deliberately narrow: it is keyed by page **and** rule **and** node
count, so a new serious violation of any other rule, on any other page, or the
same rule spreading to more nodes, still fails the run. Delete the entry the day
the tokens are darkened.
