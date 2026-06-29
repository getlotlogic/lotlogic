# Sub-project D — 30-day Temp-Tag Detection — Design

**Date:** 2026-06-28
**Status:** Approved (design), pending spec write-up review
**Builds on:** the apartment permit registry (Phase 1, M1–M3).

## Purpose

NC/SC vehicles often run on **paper 30-day temporary tags**. Per the N Style
agreement, **expired tags are a tow category** (the 48-hr-warning-then-tow list).
A temp tag also has a *different format* than a standard plate. So when a **guest**
registers, the system should recognize a temp tag and track its expiry, so an
**expired temp tag surfaces for N Style's expired-tag tow path** — and so staff
see at a glance which passes are on paper tags. Normal passes are unaffected.

This is the "differentiate 30-day vs regular plate, automate by format" ask. No
cameras/Plate Recognizer here — apartment plates are **typed on the form**, so
detection is **format-matching the typed plate** plus a self-declare checkbox.

## Scope

**In:** a temp-tag classifier (configurable format rules), an `is_temp_tag`
marker + `tag_expiration` on guest passes, the guest-form fields that drive it,
and surfacing on the dashboard + N Style lookup.

**Out (later/trivial follow-on):** residents (same mechanism, deferred — the ask
was guest-focused); running plate *photos* through Plate Recognizer (no camera
path); auto-dispatch/auto-tow (N Style enforces; we only flag).

## Design

**1. Classifier — `services/temp_tag.py`**
- `is_temp_tag_format(plate: str, state: str | None) -> bool` — matches the
  normalized plate against a **configurable list of NC/SC temp-tag regex patterns**
  (`TEMP_TAG_PATTERNS`, a module constant seeded with sensible NC/SC defaults and
  **meant to be refined** when real example tags are provided — like the N Style
  email, the framework ships now, the exact patterns are tuned later). A single
  source of truth so the form preview, the backend, and any future consumer agree.
- The classifier is conservative: when unsure, it does NOT mark temp (false marks
  are worse than misses — a self-declare checkbox covers misses).

**2. Detection at registration (two paths → `is_temp_tag`)**
- The classifier runs on the typed plate at guest registration; OR
- the guest ticks **"Temporary / paper tag"** on the form.
- Either sets `visitor_passes.is_temp_tag = true` (new boolean column, default false).

**3. Expiry**
- When it's a temp tag, the form asks for the tag's **printed expiry date** →
  stored in the existing `visitor_passes.tag_expiration` (date). If left blank,
  fallback = registration date + 30 days. (Accurate-when-given, safe-default
  otherwise.) Normal passes leave `tag_expiration` null.

**4. Surfacing (feeds the tow rule, never auto-tows)**
- **Permits list / dashboard:** temp-tag passes show a **"Temp tag"** label +
  `expires <date>`, and **"EXPIRED"** when `tag_expiration < today`.
- **N Style lookup:** the verdict gains a temp-tag line — an **expired temp tag**
  is flagged as **"expired tag — eligible for the 48-hr-warning tow path"** (NOT
  instant-tow; the agreement's expired-tag rule is warning-then-tow). An active
  temp tag shows "temp tag, expires <date>."

## Data model
- Add `visitor_passes.is_temp_tag boolean not null default false`. Reuse the
  existing `tag_expiration date`. No other schema change.

## Edge cases
- Classifier false-positive → the registrant/staff can leave the checkbox off /
  staff can void; conservative matching minimizes this.
- No expiry given → +30 days fallback (documented to the registrant).
- A temp tag that later gets real plates = a new registration; old pass voids.

## Testing
- `is_temp_tag_format` unit tests: representative temp-tag-shaped vs normal-plate
  strings classify correctly; empty/placeholder → false.
- Registration: checkbox OR format → `is_temp_tag=true` + `tag_expiration` set
  (given date, else +30d); a normal plate → false, null expiry.
- Lookup/permits: an expired temp tag surfaces the expired flag; active temp tag
  shows expiry; normal pass shows neither.

## Future
- Apply the same to residents (`resident_plates.plate_expiration` already exists).
- If a camera path is ever added at a property, run the plate photo through PR and
  reuse `is_temp_tag_format` on the read.
