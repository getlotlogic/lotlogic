# LotLogic data retention policy

> **STATUS: DRAFT — not in force.** Every period below is a *recommendation* with
> a measured justification. Nothing deletes anything until (a) Gabe answers the
> questions in "Decisions" at the bottom, and (b) the nightly sweep has run in
> dry-run mode for seven consecutive nights and the counts in
> `public.ops_retention_runs` have been read by a human. Until then this file is
> the proposal, and the sweep's `RETENTION_ENABLED` flag stays `false`.
>
> Written for Wave 2.5 of the enterprise-readiness program
> (`docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` §3 item 2.5,
> findings SEC-11, DB-5, FAT-20, PIPE-17).
> Implementation plan: `docs/superpowers/plans/2026-09-14-wave2-5-retention.md`.
>
> **Draft date:** 2026-09-14 · **Measurements:** read-only against production
> (`nzdkoouoaedbbccraoti`) on 2026-09-14.

---

## 1. Why this document exists

Nothing in LotLogic has ever deleted anything.

The system holds, indefinitely: every licence plate ever read by a camera, with
the camera vendor's full JSON payload attached; a photograph of every vehicle
that triggered a read; the mobile phone number of essentially every driver who
has ever registered; photographs of government-issued ID; and signed residential
leases. One site currently produces about **1,049 plate reads a day**. Ten sites
producing that is roughly 3.8 million rows a year on a database that has seized
twice.

Two separate problems, and this policy answers both:

1. **Liability.** Keeping a photograph of someone's driving licence for three
   years because nobody wrote down when to delete it is a choice, and it is the
   expensive choice the day something goes wrong. The shortest period that still
   lets the business function is the right one.
2. **Cost and stability.** `plate_events` is 125 MB across 14 indexes and
   growing; the R2 bucket grows forever by design (its lifecycle rule was
   deliberately deleted in April with "retention = forever" recorded as the
   decision).

The rule this document adopts: **every class of data has a named period, a named
mechanism that enforces it, and a named person who owns the answer.** A class
with no row in the table below is a bug in this document.

---

## 2. Measured inventory (2026-09-14, production, read-only)

| Where | Rows / objects | Size | Span | Note |
|---|---|---|---|---|
| `plate_events` | **72,480** | 125 MB (96 MB heap + 29 MB in 14 indexes) | 2026-04-19 → 2026-09-14 | 68,770 carry a photo URL |
| ↳ `plate_events.raw_data` (vendor JSON) | 72,480 | ~66 MB, avg 996–1,288 B/row | — | 30+ distinct top-level keys |
| ↳ older than 90 days | 27,280 | — | — | **26,569 referenced by nothing at all** |
| `plate_events` by month | Apr 14,627 · May 8,855 · Jun 5,245 · Jul 9,860 · Aug 20,135 · Sep(1–14) 13,758 | — | — | ~1,049/day over the last 7 days |
| `camera_snapshot_diag` | 12,621 | 19 MB | 2026-09-07 → 2026-09-14 | already pruned at 7 days by pg_cron `prune_camera_snapshot_diag` (03:17 UTC) |
| `weak_plate_reads` | 17,329 | 5,280 kB | 2026-05-14 → 2026-05-19 | **100% older than 90 days**; producer stopped in May |
| `plate_match_decisions` | 1,531 | 768 kB | 2026-05-20 → 2026-09-13 | |
| `visitor_passes` | 3,099 | 2,784 kB (20 indexes) | 2026-04-18 → 2026-09-14 | |
| ↳ with a phone number | **3,063** | — | — | 98.8% of all passes |
| ↳ with an email address | 314 | — | — | |
| ↳ with a government-ID photo | **314** | — | — | apartment registry |
| ↳ with a plate photo | 314 | — | — | |
| ↳ pass ended more than 30 days ago | **2,142** | — | — | eligible today under the recommended phone rule |
| ↳ pass ended more than 90 days ago | 704 | — | — | |
| `resident_plates` | 9 | 184 kB | 2026-04-18 → 2026-08-10 | 8 phones, **5 government-ID docs, 5 leases**, 5 plate photos |
| `plaza_payments` | 10 | 120 kB | 2026-09-02 → 2026-09-03 | all 10 carry a phone number |
| `alpr_violations` | 2,494 | 1,744 kB | 2026-04-30 → 2026-09-14 | 2,472 unresolved; **24 tow-confirmed and not yet invoiced** |
| `partner_truck_sightings` | 230 | 168 kB | 2026-04-22 → 2026-09-11 | tow evidence |
| `tow_clip_files` | 60 | 96 kB | — | 4 `archived` (**742 MB** of mp4 in R2), 56 `expired_unarchived` |
| `plate_sessions` | 340 | 304 kB | 2026-04-22 → **2026-05-12** | nothing has written this table in four months |
| `snapshots` (legacy YOLO) | **0** | 11 MB — all index | — | dead table, empty, still carrying 11 MB of indexes |
| `no_registration_violations` | 313 | 784 kB | 2026-05-14 → 2026-05-19 | producer stopped in May |
| Properties / cameras | 11 (10 apartment, 1 truck plaza) / 6 | — | — | |

### Object storage

| Store | Bucket | Public? | Contents | Objects |
|---|---|---|---|---|
| Cloudflare R2 | `parking-snapshots` | **YES** — `https://pub-2b67cfea48564c9695230f8909348716.r2.dev` answers an unsigned GET | every camera frame, every apartment ID/lease/plate document, every tow clip | **68,770 plate photos referenced from the DB**, plus 742 MB of tow clips |
| Cloudflare R2 | `TOW_CLIPS_BUCKET` (private) | n/a | intended home of tow clips | **unset in production** — the backend logs a WARNING on every clip presign and falls back to the public bucket |
| Supabase Storage | `plate-snapshots` | **YES (public)** | — | **0 objects, referenced by zero lines of code** |
| Supabase Storage | `tow-evidence` | no | — | **0 objects, referenced by zero lines of code** |

### Key shapes inside `parking-snapshots` (today)

```
debug/{property_id}/{YYYY-MM-DD}/sidecarempty-{api_key}-{epoch}.jpg   sidecar empty-scene debug frames
{property_id}/{YYYY-MM-DD}/diag-{api_key}-{epoch}-rejected-{reason}.jpg   rejected / diagnostic frames
{property_id}/{YYYY-MM-DD}/{api_key}-{epoch}-{PLATE}.jpg              ACCEPTED plate reads  ← the evidence
apt/{property_id}/{id|lease|plate}/{uuid4hex}.{ext}                   government ID, lease, plate photo
tow-clips/{property_id}/{YYYY-MM-DD}/{anchor}-{api_key}-{8hex}.mp4    tow footage
violations/… , snapshots/…                                            legacy YOLO path, no current writer
```

**This key layout defeats lifecycle rules.** R2 lifecycle filters on prefix.
Accepted reads and rejected diagnostic frames share the same prefix root (a
property UUID) and differ only in a filename segment, so no prefix rule can give
them different periods. Section 5 fixes this by moving new writes under
`reads/`, `diag/` and `evidence/` and keeping one legacy rule per existing
property UUID for the back catalogue.

---

## 3. The policy

Periods are **recommendations** until Gabe answers §7. Each row's
"Setting" is the environment variable that carries the number, so a period can be
changed without a deploy.

### 3.A Enforcement data (plate reads and the evidence chain)

| # | Data class | Where it lives | Why it is kept | Recommended period | Deletion mechanism | Setting | Owner |
|---|---|---|---|---|---|---|---|
| A1 | **Plate-read vendor JSON** — the camera/ALPR vendor's full payload: bounding boxes, sidecar diagnostics, MMC probabilities, pass-match scratch, operator labels | `plate_events.raw_data` (jsonb, ~66 MB) | Debugging a bad match while it is still arguable | **90 days**, then stripped to 12 matched fields (`ocr_source`, `direction`, `flow`, `pass_id`, `pass_match_fuzzy`, `overstay`, `cross_camera_match`, `verified_pair_match`, `operator_label`, `operator_labeled_at`, `_source`, `_mmc_source`) | nightly sweep — `UPDATE`, not `DELETE` | `RETENTION_PLATE_EVENT_RAW_DAYS=90` | `retention_sweep` · Gabe |
| A2 | **Plate-read row** — plate text, time, camera, property, confidence, match | `plate_events` | The enforcement record; a dispute over a tow needs the read behind it | **24 months**, and only if referenced by nothing (violation, session, sighting, pass, match decision) | nightly sweep — batched `DELETE` | `RETENTION_PLATE_EVENT_ROW_DAYS=730` | `retention_sweep` · Gabe |
| A3 | **Accepted plate photograph** | R2 `reads/…` (today: flat `{property_id}/…`) | The photo a driver or a partner asks to see | **12 months** | R2 lifecycle rule | `r2-lifecycle/parking-snapshots.json` | R2 lifecycle · Gabe |
| A4 | **Evidence photograph** — the frame behind a filed violation | R2 `evidence/{property_id}/{violation_id}.jpg` (new; copied at violation time) | Proof of a tow you invoiced for | **24 months** | R2 lifecycle rule | `r2-lifecycle/parking-snapshots.json` | R2 lifecycle · Gabe |
| A5 | **Diagnostic / rejected frames** — frames PR rejected, weak reads, no-plate frames | R2 `diag/…` (today: `{property_id}/…/diag-*`) | Tuning a camera that is reading badly | **90 days** | R2 lifecycle rule | `r2-lifecycle/parking-snapshots.json` | R2 lifecycle · Gabe |
| A6 | **Debug frames** — sidecar empty-scene captures | R2 `debug/…` | One-off bring-up of a new camera model | **14 days** | R2 lifecycle rule | `r2-lifecycle/parking-snapshots.json` | R2 lifecycle · Gabe |
| A7 | **Legacy YOLO frames** | R2 `snapshots/…`, `violations/…` | Nothing — no writer since March | **30 days** | R2 lifecycle rule | `r2-lifecycle/parking-snapshots.json` | R2 lifecycle · Gabe |
| A8 | **Camera ingest diagnostics** | `camera_snapshot_diag` | Explaining why a camera POST was rejected, same week | **7 days — already enforced** by pg_cron `prune_camera_snapshot_diag` | pg_cron (live since ~Sept) | — | pg_cron · Gabe |
| A9 | **Weak plate reads** | `weak_plate_reads` (17,329 rows, all >90 days) | Second-pass OCR retry material | **90 days** | nightly sweep | `RETENTION_WEAK_PLATE_READ_DAYS=90` | `retention_sweep` · Gabe |
| A10 | **Matcher decision log** | `plate_match_decisions` | Auditing why the matcher matched | **90 days** | nightly sweep | `RETENTION_PLATE_MATCH_DECISION_DAYS=90` | `retention_sweep` · Gabe |

### 3.B Personal data on a pass

| # | Data class | Where it lives | Why it is kept | Recommended period | Deletion mechanism | Setting | Owner |
|---|---|---|---|---|---|---|---|
| B1 | **Driver phone number** | `visitor_passes.phone` (3,063 rows), `resident_plates.phone` (8) | Reaching the driver while the pass is live, and during the cooldown window after | **pass end + 30 days**, then set to `NULL` (the row survives) | nightly sweep — `UPDATE … SET phone = NULL` | `RETENTION_PASS_PHONE_DAYS=30` | `retention_sweep` · Gabe |
| B2 | **Driver email address** | `visitor_passes.email` (314), `resident_plates.email` | Same as B1 | **pass end + 30 days**, then `NULL` | nightly sweep | `RETENTION_PASS_PHONE_DAYS` (shared) | `retention_sweep` · Gabe |
| B3 | **Payment contact phone** | `plaza_payments.phone` (10) | Refunds and card-network chargebacks; it is attached to a financial record | **13 months**, then `NULL` (the payment row itself is a 7-year record, B7) | nightly sweep | `RETENTION_PAYMENT_PHONE_DAYS=395` | `retention_sweep` · Gabe |
| B4 | **Government-ID photograph** | R2 `apt/{property}/id/…`, keyed from `visitor_passes.id_photo_url` (314) and `resident_plates.id_doc_url` (5) | The apartment registry's identity check at registration time | **decision + 30 days** (approved *or* rejected); for a pass never reviewed, **pass end + 30 days**. R2 object deleted, column set to `NULL` | nightly sweep — R2 `delete_object` then `UPDATE … NULL` | `RETENTION_ID_DOC_DAYS=30` | `retention_sweep` · Gabe |
| B5 | **Signed lease** | R2 `apt/{property}/lease/…`, keyed from `resident_plates.lease_doc_url` (5) | Proof the holder actually lives at the property, for the first quarter of the tenancy | **decision + 90 days** | nightly sweep — same mechanism as B4 | `RETENTION_LEASE_DOC_DAYS=90` | `retention_sweep` · Gabe |
| B6 | **Plate photograph on a pass** | R2 `apt/{property}/plate/…`, keyed from `*.plate_photo_url` (319) | Matching a registered plate to the vehicle that showed up | **pass end + 90 days** | nightly sweep | `RETENTION_PASS_PLATE_PHOTO_DAYS=90` | `retention_sweep` · Gabe |
| B7 | **Pass row itself** (plate, unit, company, dates) | `visitor_passes`, `resident_plates` | The enforcement record; a tow dispute turns on whether a pass existed | **not swept.** Reviewed in Wave 3 once reporting reads from an analytics schema instead of the raw table | — | — | Gabe |

### 3.C Tow evidence — **already implemented, unchanged by this policy**

| # | Data class | Where it lives | Why it is kept | Period | Deletion mechanism | Setting | Owner |
|---|---|---|---|---|---|---|---|
| C1 | **Camera SD-card footage** (the source) | the camera itself | The window in which a clip can still be exported | **`TOW_FOOTAGE_RETENTION_DAYS=10`**, per-camera overrides in `TOW_FOOTAGE_RETENTION_OVERRIDES` (`api_key:days`; north card ≈ 2.3 d, south ≈ 32 d) | the camera recycles its own card; `services/tow_retention.parse_overrides` is the one reader; `tow_digest` files an `ops_findings` row 24 h before expiry | `TOW_FOOTAGE_RETENTION_*` | `tow_digest` · Gabe |
| C2 | **Archived tow clip** | R2 `tow-clips/…` (4 objects, 742 MB) | Proof of a tow you invoiced for — same job as A4 | **24 months** (matches A4) | R2 lifecycle rule on the *private* clips bucket | `r2-lifecycle/tow-clips.json` | R2 lifecycle · Gabe |
| C3 | **Clip access URL** | minted on demand | — | **15 minutes**, presigned (`GET /ops/tow-sightings/{id}/clip`, `Cache-Control: private, no-store`) | already live | `tow_sightings.CLIP_URL_TTL_S` | backend · Gabe |

> **Open gap in C2/C3:** `TOW_CLIPS_BUCKET` is **unset in production**, so clips
> are written to and presigned from `parking-snapshots` — a bucket with a public
> r2.dev domain. The 15-minute presign is therefore decorative: the same object
> answers an unsigned GET. Plan task 12 closes this.

### 3.D Operational data

| # | Data class | Where | Why | Period | Mechanism | Setting | Owner |
|---|---|---|---|---|---|---|---|
| D1 | Job run history | `ops_job_runs` (19 rows — one per job, upserted) | The dead-man | not swept — the table does not grow | — | — | — |
| D2 | Retention sweep history | `ops_retention_runs` (new) | The seven-night dry-run evidence, and the audit trail of what was deleted | **90 days** | nightly sweep (sweeps itself) | `RETENTION_OPS_JOB_HISTORY_DAYS=90` | `retention_sweep` · Gabe |
| D3 | Closed findings | `ops_findings` | History of what broke | open: forever · **closed: 12 months** | nightly sweep | `RETENTION_CLOSED_FINDING_DAYS=365` | `retention_sweep` · Gabe |
| D4 | `cron.job_run_details` | pg_cron | — | **7 days — already enforced** by `purge_cron_job_run_details` (03:45 UTC) | pg_cron | — | pg_cron · Gabe |

### 3.E Never swept — business and tax records

`alpr_violations`, `no_registration_violations`, `partner_truck_sightings`,
`tow_clip_files`, `plaza_payments`, `plaza_reconciliations`, `pending_invoices`,
QuickBooks linkage columns, `properties`, `enforcement_partners`, `lot_owners`.
These are the invoice trail. **7 years**, reviewed when an accountant says
otherwise. The sweep must not have a rule that can reach them, and Task 7's
tests assert that.

---

## 4. The three hard rules the sweep obeys

1. **Never delete a row something points at.** Every rule carries an explicit
   `NOT EXISTS` guard. This is not defensive coding — the foreign keys make it
   load-bearing:

   | Child | Column | On delete of a `plate_events` row |
   |---|---|---|
   | `plate_match_decisions` | `plate_event_id` | **CASCADE** — silently deleted |
   | `partner_truck_sightings` | `plate_event_id` | **CASCADE — silently deletes tow evidence** |
   | `visitor_passes` | `first_seen_event_id`, `exited_via_plate_event_id` | **SET NULL** — silently blanks a pass's first-seen photo |
   | `parking_passes` | `exited_via_plate_event_id` | SET NULL |
   | `alpr_violations` | `plate_event_id` | NO ACTION — the delete *errors* (the safe direction) |
   | `plate_sessions` | `entry_plate_event_id`, `exit_plate_event_id` | NO ACTION — errors |

   A naïve `DELETE FROM plate_events WHERE created_at < …` would therefore
   destroy tow sightings and blank pass photos without raising anything.
   Measured: of 27,280 `plate_events` older than 90 days, **26,569 are
   referenced by nothing** — the guard costs 711 rows and buys the difference
   between a retention sweep and an incident.

2. **Never delete a row attached to something open.** "Open" means: a violation
   not resolved, a tow not yet invoiced (24 of those today), a billing hold, a
   dispute flag, a pass still valid. The guard is a shared SQL fragment, not a
   per-rule copy.

3. **Dry run is the default and the only mode that ships first.** The sweep
   writes what it *would* have deleted into `ops_retention_runs` and stops.
   `RETENTION_ENABLED=false` is the deployed default; seven nights of counts
   must be on the record before anyone flips it.

---

## 5. Bucket lifecycle, committed as config

Lifecycle rules live in the repo as JSON and are applied by
`scripts/apply_r2_lifecycle.py`, which diffs live-vs-file and refuses to apply
without `--yes`. Nobody clicks in the Cloudflare dashboard; the rule that got
deleted in April got deleted because it was a click.

| Bucket | Rule | Prefix | Days |
|---|---|---|---|
| `parking-snapshots` | debug frames | `debug/` | 14 |
| `parking-snapshots` | diagnostic / rejected frames | `diag/` | 90 |
| `parking-snapshots` | accepted reads | `reads/` | 365 |
| `parking-snapshots` | evidence copies | `evidence/` | 730 |
| `parking-snapshots` | legacy YOLO | `snapshots/`, `violations/` | 30 |
| `parking-snapshots` | legacy flat reads (back catalogue) | one rule per existing property UUID | 365 |
| `parking-snapshots` | incomplete multipart uploads | — | abort at 7 days |
| `lotlogic-docs` (new, private) | apartment ID / lease / plate documents | `apt/` | **no lifecycle rule** — B4/B5/B6 are row-driven, the sweep deletes each object individually because the period depends on a decision date, not an upload date |
| `tow-clips` (new, private) | archived tow clips | `tow-clips/` | 730 |

Supabase Storage: `plate-snapshots` (public, empty, unreferenced) is made
private and left empty pending deletion; `tow-evidence` (private, empty,
unreferenced) likewise. Both are declared in a migration so the state is
reviewable.

---

## 6. Photo URLs: presigned, not public

68,770 plate photographs are addressed today by a permanent, unauthenticated
`https://pub-…r2.dev/…` URL stored in `plate_events.image_url`, rendered
straight into `<img src>` in about fifteen places in `frontend/dashboard.html`,
and pasted verbatim into the tow-dispatch email. Government-ID photos and leases
live in the same public bucket (behind unguessable UUID keys, and served through
a correctly-built authenticated proxy — but the bucket itself is open).

The policy:

| Surface | Today | Policy |
|---|---|---|
| Dashboard plate photo | permanent public r2.dev URL read straight from Supabase | **15-minute presigned URL** from an authenticated, scope-checked backend endpoint |
| Apartment ID / lease / plate doc | authenticated streaming proxy (`GET /apartment/docs/…`, `Cache-Control: private, no-store`) — **already correct** | unchanged; the *bucket* moves to a private one |
| Tow clip | 15-minute presigned — **already correct** | unchanged; the *bucket* moves to a private one |
| Tow-dispatch email to the partner | permanent public URL embedded in the email body | **presigned, TTL = the action token's 48 h.** An email client cannot carry a bearer token, so this is the one place a long-lived signed URL is the right answer — and 48 h is still not "forever" |
| The public r2.dev domain itself | on | **off**, once the four rows above have landed |

---

## 7. Decisions — one line each, for Gabe

Each is a yes/no. "Yes" adopts the recommended default; the implementation can
run in dry-run mode without any of these being answered.

1. **Plate-read vendor JSON.** The camera vendor's raw payload (~66 MB, 30+ keys per read) sits on every one of 72,480 plate reads. → *Strip it to the 12 fields we actually match on after 90 days, keeping plate, time, camera, photo and match?* **(recommended: yes)**
2. **Plate-read rows.** 72,480 reads, 26,569 of them older than 90 days and referenced by nothing. → *Delete a plate read at 24 months when no violation, session, tow sighting, pass or match decision points at it?* **(recommended: yes)**
3. **Accepted plate photos in R2.** 68,770 photos, kept forever. → *Delete an accepted plate photo at 12 months?* **(recommended: yes)**
4. **Evidence photos.** The frame behind a violation you invoiced for — copied to its own prefix so it outlives rule 3. → *Keep evidence photos 24 months?* **(recommended: yes — this is spec fat-decision 28: 12 / 24 / forever)**
5. **Diagnostic and rejected frames in R2.** Frames the plate reader threw away. → *Delete at 90 days?* **(recommended: yes)**
6. **Debug frames in R2.** Empty-scene captures from camera bring-up. → *Delete at 14 days?* **(recommended: yes)**
7. **Weak plate reads.** 17,329 rows, none written since 19 May, all older than 90 days. → *Delete at 90 days (which clears all 17,329 on night one)?* **(recommended: yes)**
8. **Driver phone numbers.** 3,063 of 3,099 passes carry one; 2,142 belong to passes that ended more than 30 days ago. → *Blank the phone (and email) 30 days after the pass ends, keeping the pass row itself?* **(recommended: yes)**
9. **Payment contact phone.** All 10 plaza payments carry one; it is attached to a financial record. → *Blank it at 13 months, keeping the payment row?* **(recommended: yes)**
10. **Government-ID photographs.** 319 of them, kept forever. → *Delete the ID photo 30 days after the registration is approved or rejected (pass end + 30 for one never reviewed)?* **(recommended: yes)**
11. **Signed leases.** 5 of them, kept forever. → *Delete the lease 90 days after approval?* **(recommended: yes)**
12. **Plate photos on a pass.** 319 of them. → *Delete 90 days after the pass ends?* **(recommended: yes)**
13. **Tow clips and camera footage.** Already governed by `TOW_FOOTAGE_RETENTION_DAYS=10` plus per-camera overrides; archived clips are the tow's proof. → *Leave the existing footage overrides exactly as they are, and give an archived clip the same 24 months as rule 4?* **(recommended: yes)**
14. **The public photo domain.** `pub-…r2.dev` answers an unsigned GET for every photo, lease and ID in the bucket. → *Turn the public r2.dev domain off once the dashboard and the tow email are on presigned URLs?* **(recommended: yes)**
15. **Going live.** → *Run the sweep in dry-run for seven nights, then flip `RETENTION_ENABLED=true` if the counts match this document?* **(recommended: yes)**

---

## 8. Change log

| Date | Change | By |
|---|---|---|
| 2026-09-14 | First draft. Periods proposed, not adopted. | Wave 2.5 |
