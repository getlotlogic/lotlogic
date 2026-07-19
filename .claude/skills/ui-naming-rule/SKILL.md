---
name: ui-naming-rule
description: Enforce the LotLogic UI naming convention — the ONLY user-facing term is "parking pass". Never Resident, Visitor, Guest, Permanent, Temporary, or Driver in any user-facing string (HTML, copy, landing pages, email templates, SMS, toast messages, modal labels). Auto-load whenever Claude edits *.html, blog/*, resident.html, visit.html, pitch-*.html, dashboard.html, or any edge function that returns a user-facing message. DB column names keep their legacy names — this rule is UI-only.
---

# UI naming rule — say "parking pass", and nothing else

**There is exactly one user-facing noun for what this product issues: a
"parking pass".** Not a resident pass, not a temporary pass, not a driver
pass. Just a parking pass.

| Do not use in UI | Use instead |
| --- | --- |
| Resident | (nothing — say "parking pass") |
| Visitor | (nothing — say "parking pass") |
| Guest | (nothing — say "parking pass") |
| Permanent | (nothing — say "parking pass") |
| Temporary | (nothing — say "parking pass") |
| Driver | (nothing — say "parking pass", or name the person) |

## History — read this before "fixing" anything

This rule has changed twice, and the intermediate step is a trap.

1. Originally the UI said **Resident / Visitor / Guest**.
2. A rename replaced those with **Permanent / Temporary / Driver**.
3. **Superseded 2026-05-14.** All six words are now banned from user-facing
   copy. The distinction itself was the problem: drivers do not care whether
   the system classifies them as permanent or temporary, and surfacing the
   internal taxonomy made the product harder to understand, not easier.

An earlier version of this very skill documented step 2 as current and told
agents to write "Permanent / Temporary". **That was stale and contradicted
`CLAUDE.md`.** If you find copy, comments, PR descriptions, or other skills
still asserting step 2, they are wrong — `CLAUDE.md` is authoritative.

## Where the rule applies

- All `*.html` files (`dashboard.html`, `resident.html`, `visit.html`,
  `pitch-*.html`, marketing pages).
- Blog posts under `blog/`.
- Edge function response bodies in `supabase/functions/*/index.ts` —
  anything that eventually renders to a human.
- Tab/button/label/toast/modal copy in any SPA-style JS inside the HTML.
- Email subject lines and bodies; SMS copy.

## Where the rule does NOT apply (the DB-column exemption)

The Postgres schema keeps its legacy names, and changing them means a
breaking migration across every RLS policy and consumer. So these are fine
and must NOT be renamed:

- Tables: `visitor_passes`, `resident_plates`, `parking_passes`
- Columns: `visitor_name`, `holder_role`, `back_plate`
- Values: `holder_role = 'resident'`, `holder_role = 'employee'`

Only rewrite when a value crosses the DB→UI boundary. If you need a label
for a row, prefer saying nothing about its class at all — show the plate,
the company, and the window. Those are what an operator actually reads.

## How to audit an edit

1. Scan proposed user-facing text for `Resident`, `Visitor`, `Guest`,
   `Permanent`, `Temporary`, `Driver` (case-insensitive, word-boundary,
   including plurals and possessives).
2. For each hit, decide whether it is user-facing. Almost always **yes** in
   HTML/blog/landing-page contexts; **sometimes no** inside a `<script>`
   block where the value is a literal DB enum.
3. If user-facing, rewrite the sentence so it does not need the word.
   Usually the sentence is clearer without it: "Temporary pass expires in
   4h" → "Parking pass expires in 4h".
4. If removing the word genuinely changes meaning, surface the ambiguity to
   the user rather than silently renaming.

## Subtle cases

- **`/visit` landing page** — the filename stays `visit.html`. Page
  headings and form labels say "parking pass". Don't "fix" the filename.
- **Legacy blog posts** — pre-rename posts may still use old terms. Do
  **not** backfill published posts unless asked; rewriting published
  headings/URLs has SEO cost.
- **Truck-plaza flow** — "Trailer" is NOT covered by this rule. It is a
  physical part of the vehicle, not a pass class, and the dashboard
  correctly labels the rear plate "Trailer".
- **Email + SMS** — check `supabase/functions/tow-dispatch-email/` and
  `tow-dispatch-sms/`.

## One-sentence summary

> In any string a human will read, say "parking pass" and never name a pass
> class. In any string only the database will read, leave the legacy column
> and enum names alone.
