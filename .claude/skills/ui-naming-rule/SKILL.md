---
name: ui-naming-rule
description: Enforce the LotLogic UI naming convention — Permanent / Temporary / Driver, never Resident / Visitor / Guest — in any user-facing string (HTML, copy, landing pages, email templates, toast messages, modal labels). Auto-load whenever Claude edits *.html, blog/*, resident.html, visit.html, pitch-*.html, dashboard.html, or any edge function that returns a user-facing message. The DB columns keep their legacy names — this rule is UI-only.
---

# UI naming rule — Permanent / Temporary / Driver

This product previously used "Resident / Visitor / Guest" throughout the
UI. It no longer does. Every user-facing string must use:

| Old (do not use in UI) | New (use in UI) |
| --- | --- |
| Resident | **Permanent** |
| Visitor | **Temporary** |
| Guest   | **Driver** |

The conversion happened across two sprints, captured in PR #64
("Rename user-facing Resident/Visitor/Guest → Permanent/Temporary/Driver")
and PR #71 ("Truck-plaza: capture Driver Name + finish Visitor→Driver
rename in edge functions"). When in doubt, diff those PRs.

## Where the rule applies

- All `*.html` files in the repo root (`dashboard.html`, `resident.html`,
  `visit.html`, `pitch-apartments.html`, `pitch-tow.html`, etc.).
- Blog posts under `blog/`.
- Edge function response bodies in `supabase/functions/*/index.ts` —
  anything that eventually renders to a human.
- Tab/button/label/toast/modal copy in any SPA-style JS inside the HTML.
- Marketing landing pages.
- Email subject lines and bodies.

## Where the rule does **not** apply (the DB-column exemption)

The Postgres schema still uses the legacy names in column values and
enum types, and changing those means a breaking migration across every
RLS policy and every consumer. So:

- `passes.pass_type = 'visitor'` in SQL is fine.
- `passes.vehicle_type = 'resident'` in SQL is fine.
- `lots.guest_mode = true` in SQL is fine.

Only rewrite when the value crosses the DB→UI boundary. Typical shape:

```ts
const labelFor = (dbType: string) => {
    switch (dbType) {
        case "resident": return "Permanent";
        case "visitor":  return "Temporary";
        case "guest":    return "Driver";
        default:         return dbType;
    }
};
```

Adapt, don't rename the source column.

## How to audit an edit

When Claude is asked to write or modify any UI string:

1. Scan the proposed text for the words `Resident`, `Visitor`, `Guest`
   (case-insensitive, word-boundary). Also catch possessives and
   plurals: `Residents'`, `Visitors`, `Guest's`.
2. For each hit, decide: is it user-facing? Almost always **yes** in
   HTML/blog/landing-page contexts, **sometimes no** inside a `<script>`
   block where the value is a literal DB enum.
3. If user-facing, swap it to the new term. Keep grammatical shape:
   "Visitors" → "Temporary passes" or "Temporary guests", not
   "Temporarys".
4. If swapping changes meaning ("Guest Wi-Fi" is a product-unrelated
   marketing term), surface the ambiguity to the user rather than
   silently renaming.

## Subtle cases to watch for

- **Truck-plaza pass flow** — PR #71 finished the rename in
  `supabase/functions/alpr-webhook/` and `supabase/functions/alpr-snapshot/`.
  If you touch either, re-confirm response bodies, email templates, and
  SMS copy say "Driver".
- **Dashboard tab labels** — PR #64 renamed `Visitors` tab to
  `Temporary` in `dashboard.html`. Any new tab you add must follow the
  same wording.
- **`/visit` landing page** — filename stays `visit.html`, but the page
  heading and form labels say "Temporary pass". Don't "fix" the filename.
- **Legacy blog posts** — pre-rename posts under `blog/` may still read
  "Visitor"; do **not** backfill old posts unless the user asks. Rewriting
  published URLs/headings has SEO cost.
- **Email + SMS** — check `supabase/functions/tow-dispatch-email/` and
  `supabase/functions/tow-dispatch-sms/`. "Guest" here almost always
  becomes "Driver".

## One-sentence summary

> In any string a human will read on our product, say Permanent, Temporary,
> or Driver. In any string only the database will read, leave resident,
> visitor, and guest alone.
