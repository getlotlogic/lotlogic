# Repeat-Offender Chip on Truck-Plaza Passes — Design

**Date:** 2026-06-15
**Status:** Approved (design), pending implementation plan

## Purpose

Give the operator, *on the pass itself*, an at-a-glance signal that a truck is
abusing the parking system — plus the evidence to confirm it's the same truck.
Specifically, surface when a truck **re-registered within its 24-hour cooldown**,
and how many times that truck has **been flagged before**. Everything stays
clean by default — a normal pass shows nothing.

This serves three on-pass purposes (priority order from the operator):
1. **Catch cooldown abuse** — the chip + repeat count.
2. **Confirm it's the same truck** — photos in the expanded list.
3. **Spot repeat visitors** — the visit list and count.

The **full audit trail** (purpose #4) is explicitly *out of scope* here — it
belongs in a separate History tab, a later project.

## Behavior / UX

On each row in the **Truck Parking Log** (the registration-based pass list):

- **Chip appears ONLY when the current pass is a cooldown re-registration** —
  i.e. this truck registered again within 24h of its last exit. Every other
  pass shows nothing (no clutter).
- **Chip text:** `⚠ Re-registered within cooldown`, with `· flagged N× before`
  appended **only when N > 0** (a truck on its first-ever flag shows no count).
- **Click `▾`** → the row expands inline to show that truck's **recent visits**
  (last 5), most-recent first. Each visit row shows:
  `[photo thumbnail] · date · stay length · outcome (exited / towed / cancelled) · ⚠ on flagged ones`
- The expanded list is **recent only (5)**. The complete history lives in the
  future History tab.

```
NORMAL PASS (most rows)
  XYZ9876 · Bob's Hauling                 [active 6h]

NOTABLE PASS (cooldown re-registration, 2 prior flags)
  ABC1234 · Acme Trucking                 [active 4h]
  ⚠ Re-registered within cooldown · flagged 2× before   ▾

  (expanded)
  ┌────────────────────────────────────────────────┐
  │ [🖼]  Jun 13   2d · exited           ⚠ flagged  │
  │ [🖼]  Jun 09   1d · exited                      │
  │ [🖼]  Jun 02   1d · towed            ⚠ flagged  │
  └────────────────────────────────────────────────┘
```

## Architecture — Approach A: persist the cooldown flag at registration

Today the cooldown flag is derived live in the browser (`cooldownIds` in
`dashboard.html`) and never stored. The "flagged N× before" count needs durable
history, so we persist the flag at registration. This also quietly removes the
fragility of deriving cooldown at render time.

### 1. Data model

Add one nullable column to `visitor_passes`:

- `cooldown_flagged_at timestamptz` — set at registration when the new pass is a
  cooldown re-registration; NULL otherwise. Quiet marker only — **no violation
  row, no email** (deliberately unlike the insert-time alpr_violations 'cooldown'
  path removed 2026-06-08, which was a latent false-alert source).

One-time **backfill**: stamp `cooldown_flagged_at` on existing passes by applying
the rule below across history, so prior flags count immediately.

### 2. Backend — stamp it at registration (`routers/public_registration.py`)

When a truck-plaza pass is inserted, compute the flag with the **same rule the
hardened `cooldownIds` uses**, evaluated at registration time (`reg = now`):

A prior pass makes this registration a cooldown breach when ALL hold:
- Same `property_id`.
- **Same truck:** prior `plate_text` OR `normalized_back_plate` matches this
  registration's front or back plate (cross front/back, normalized).
- **Real prior stay:** prior is not `revoked`, and not operator-cancelled
  (`status='cancelled'` with `cancelled_by` NOT starting `camera_exit`). Only
  camera-exit / expired prior stays count. (Mirrors `isRealStay`.)
- **Ended within 24h:** prior end = `coalesce(prior.exited_at, prior.valid_until)`,
  and `end > reg - 24h` and `end <= reg`. (An exit only counts if it happened
  before this registration; otherwise fall back to scheduled `valid_until` —
  identical to the frontend rule.)
- Placeholder plates (`NOPLATE`, `TEMP`, etc.) and test rows are excluded.

If such a prior exists → `cooldown_flagged_at = now`.

This becomes the **single source of truth** for "is this pass a cooldown
breach." The existing render-time `cooldownIds` derivation is refactored to read
this persisted flag (one source, no divergence) — see Phase 4.

### 3. Frontend — the chip (`frontend/dashboard.html`)

For each pass in the Truck Parking Log:
- **Show the chip** iff `pass.cooldown_flagged_at` is set.
- **Count** `flagged N× before` = number of *prior* passes (created before this
  one) for the same truck (front/back plate match) with `cooldown_flagged_at`
  not null. Omit the suffix when N = 0.
- **Expanded list** = the same truck's most recent 5 passes (excluding the
  current one), each rendered as `photo · date · stay · outcome · flag`. The
  photo reuses the existing `first_seen_event_id` → image path (now auto-assigned
  by `trg_pass_photo_from_plate_event`). Outcome maps from status:
  `exited/cancelled(camera_exit)` → "exited", `towed` → "towed",
  operator `cancelled` → "cancelled".

The count and recent list are sourced from a backend query keyed by the truck's
plate(s), not re-derived in the browser. Implementation plan will choose between
an RPC and an extension of the parking-log endpoint; either returns, per pass:
`cooldown_flagged_at`, `prior_flag_count`, and the recent-visits array.

### 4. Unify `cooldownIds` (targeted cleanup, in scope)

The browser's render-time cooldown derivation (`cooldownIds`) drove a separate
red "Violation — re-registered within the 24-hour cooldown" banner. The chip now
reads the persisted `cooldown_flagged_at` directly and gates on the exact same
condition, so the banner became a redundant second warning on every flagged row.
Per "clean not cluttered," the banner, the `cooldownIds` derivation, and its
`isCooldownViol` consumer were all removed — the chip is the single cooldown
surface (and the fragile recompute-every-render logic, with the merge-order and
front/back bugs once patched there, is gone with it).

The same-truck matcher used by the flag is centralized in one immutable SQL
function `public.cooldown_match_key(text)` (normalize → drop <4 chars → drop a
placeholder/equipment denylist), called by the trigger, the backfill, and both
parking-log read helpers, so the flag, the `prior_flag_count`, and the
recent-visits list match the same trucks by construction.

**Correction (post-implementation, 2026-06-15):** the original plan also keyed the
`count_on_cooldown` RPC off `cooldown_flagged_at` so the "On Cooldown" tile, the
parking-log bucket, and the chip would "all agree." That was a semantic error —
they measure different things and were reverted to NOT share the flag:
- The **"On Cooldown (Tow if seen)" tile** and the parking-log **`cooldown`
  bucket** count trucks whose pass *ended* within the last 24h (recently departed,
  tow-if-seen). This is a time-window enforcement metric. `count_on_cooldown`
  stays time-based; the tile and bucket agree with each other.
- The **chip + violation banner** (`cooldownIds` → `cooldown_flagged_at`) mark a
  pass that is itself a *re-registration* within cooldown — an abuse marker, a
  different population. These two agree with each other.
Keying the tile off the abuse flag made it read 3 while the bucket showed 38.
Only `cooldownIds` reads the persisted flag; the RPC does not.

## Edge cases

- **Same-truck matching** uses front OR back plate, normalized, reusing the
  existing paired-plate matcher — so a truck registered front-only still matches
  a prior back-plate pass once plates are completed.
- **First-ever flag:** count = 0 → chip shows, suffix omitted.
- **No photo yet** for a past visit: show a neutral placeholder thumbnail (the
  auto-assign trigger fills it once the camera reads that truck).
- **Operator-cancelled / revoked priors** never count toward the flag or the
  count (not real stays).
- **Self-match guard:** the current pass is excluded from both its own count and
  its own recent list.

## Testing

- **Backend unit:** registration flag logic — within-24h sets it, outside-24h
  doesn't; front↔back cross-match; operator-cancelled prior doesn't trigger;
  placeholder plates excluded.
- **Backfill:** flag counts on historical data match a hand-checked sample.
- **Frontend:** chip renders only when `cooldown_flagged_at` set; suffix omitted
  at N=0 and correct at N>0; expand shows ≤5 recent with photo/date/outcome/flag;
  normal passes render no chip.
- **Unification:** after Phase 4, the chip, "On Cooldown" tile, and cooldown
  bucket counts agree on a seeded dataset.

## Out of scope

- The History tab / full audit trail (purpose #4) — separate project.
- Frequent-visitor, "back sooner than usual", and prior-tow triggers — the
  operator chose cooldown-breach-only for the chip.
- Any alerting (email/SMS/violation) off the flag — it is a silent marker.
