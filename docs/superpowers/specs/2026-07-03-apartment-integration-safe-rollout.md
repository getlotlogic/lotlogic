# Apartment Pass System → lotlogicparking.com — Safe Integration Plan

**Date:** 2026-07-03
**Goal:** Give apartment **owners (leasing offices)** a view in the live dashboard to manage their pass system (approve/reject/extend/void passes, review ID/lease/plate docs, residents/guests, feedback), **without any effect on NMLD / Charlotte Travel Plaza (the truck plaza).**
**Constraint (hard):** the working truck-plaza + NMLD flow must be provably unchanged.

---

## 1. Current state (verified, not assumed)

- The apartment registry is **already built** on `feat/apartment-permit-registry` (both repos): reviewed, review-fixes applied, tests green (158 pass). **Not deployed.** `main` (live) is at `d866480`; our branch HEAD is `46c4861`.
- **The apartment owner view already exists in `dashboard.html`** — component `ApartmentPermits({property})` (line ~10504), rendered only when `property.property_type === 'apartment'`.
- **The isolation seam is `isTruckPlaza = property.property_type === 'truck_plaza'`.** Every apartment vs truck-plaza divergence in the property detail (tabs, plate labels, the "log" section, the type pill) branches on this. Truck-plaza uses its own registration-based view; apartment uses `ApartmentPermits`. No shared render path.
- **Backend** apartment endpoints are all **additive** new routes: `/apartment/passes/{permits,approve,reject,extend,void,lookup}`, `/apartment/{uploads,docs}`, `/apartment/feedback`, `/admin/*`. No existing truck-plaza route (`/visitor_passes/*`, `/violations/*`) is modified.
- The one shared backend file, `public_registration.py`, gained temp-tag fields — but the **truck-plaza branch is untouched** (confirmed in review; full suite green).
- **DB (prod):** apartment schema + RLS policies already applied; Stevensons provisioned. Truck-plaza tables/RLS untouched.

**Conclusion:** this is a *rollout*, not a build. The risk surface is deployment + gating, not new code.

---

## 2. Why the truck plaza / NMLD is safe (four independent guarantees)

1. **Property-type gating.** Every apartment UI surface renders only for `property_type==='apartment'`. NMLD only sees the `truck_plaza` property (verified: Frank's live session returns only Charlotte Travel Plaza). A truck-plaza owner only sees truck-plaza UI. Neither can reach apartment code paths.
2. **Additive backend.** New `/apartment/*` + `/admin/*` routes only. Zero edits to `/visitor_passes/*`, `/violations/*`, the cooldown path, or the truck-plaza QR (`visit.html`). The lone shared file's truck-plaza branch is untouched.
3. **RLS scope.** Apartment policies scope apartment data by owner/tow-company; truck-plaza policies untouched. NMLD is scoped by `partner_id` — and the "View as Partner" leak was just fixed (`scopePropsToPartner`), so no cross-tenant bleed.
4. **No shared component.** `ApartmentPermits` is a separate component behind an `ErrorBoundary`; if it ever threw, it cannot take down the truck-plaza view.

---

## 3. "Only for our admin view" — the rollout gate

Property-type gating already means NMLD/truck-plaza never see apartment UI. For extra rollout safety (deploy the code but keep it dark from *clients* until you're ready), add a thin **admin-only visibility flag**:

- Deploy the branch, but gate the apartment-owner surfaces so they render only for a **platform-admin session** (you) until sign-off. You verify end-to-end on Stevensons via your admin login / "View as Owner"; the leasing office gets no working login yet.
- When verified, flip the flag (or simply issue the leasing office their owner login) to expose it. This is a one-line gate, reversible, and never touches the truck-plaza path.

This gives: code live + tested in prod, but clients (and certainly NMLD) see nothing new until you say go.

---

## 4. Safe rollout sequence (each step verified before the next)

1. **Pre-deploy (done / re-confirm):** backend full suite green (158 pass); `dashboard.html`/`apt.html`/`lookup.html` esbuild/`node --check` clean; diff confirms no truck-plaza endpoint or the `isTruckPlaza` truck path changed.
2. **Deploy backend (Railway — your gated push).** Additive routers go live. **Verify:** (a) a truck-plaza QR test registration still succeeds; (b) `/visitor_passes/*` + cooldown unchanged; (c) NMLD dashboard identical; (d) `/apartment/*` respond (200/401 as expected). Confirm required env is present (R2 for doc uploads, reCAPTCHA keys, SendGrid — emails stay dormant per your call).
3. **Deploy frontend (Vercel — your gated push).** Dashboard apartment views + apt.html + lookup.html + the Stevensons fix go live. **Verify:** (a) Frank/NMLD view unchanged — only the plaza, cooldown works, no Stevensons in "View as Partner"; (b) a truck-plaza owner's property detail unchanged; (c) the admin-gated apartment view works on Stevensons.
4. **Admin-only verification on Stevensons.** As platform admin, walk the full apartment loop: pending queue → approve/reject → extend/void → view an uploaded doc → feedback. Fix anything before exposure.
5. **Expose to the leasing office.** Issue the Friedlam/leasing owner login (they already exist as the owner on Stevensons) + flip the visibility flag. They now manage their passes.

Rollback at any step: revert the Vercel/Railway deploy to the prior build (truck-plaza is on `main` and unaffected either way).

---

## 5. What the apartment owner gets (already built)

Log into `lotlogicparking.com/app` → their apartment property → **Parking Passes**: pending approval queue (residents + guests), **approve / reject / extend / void**, view uploaded **ID / lease / plate** docs via the authenticated proxy, resident + guest lists, and a **feedback** control. Public residents/guests register via the `apt.html` QR form.

---

## 6. Risks + mitigations

| Risk | Mitigation |
|---|---|
| `public_registration.py` temp-tag change breaks truck-plaza QR | Truck-plaza branch verified untouched + full suite green; step-2 smoke test |
| Apartment view errors for a truck-plaza user | Property-type gating + `ErrorBoundary`; step-3 smoke test on NMLD |
| RLS mis-scope leaks data to a partner | Verified RLS + Stevensons fix + clean security review |
| Doc uploads need R2 / reCAPTCHA env | Verify env at step 2 before exposing the public form |
| Emails firing prematurely | Notify framework is dormant (no N Style/owner email wired) — confirmed |

---

## 7. Decisions needed from you

1. **Rollout gate:** admin-only visibility flag first (recommended), or straight to the leasing-office login?
2. **Deploy:** pushes are yours (gated) — I prep + verify, you push backend then frontend. OK?
3. **Scope confirm:** this rollout is apartment-owner management only. The N Style *partner* lookup + the internal admin *Onboard* console are separate follow-ons (already built as `lookup.html` / `admin.html`) — fold those in next, or leave standalone for now?
