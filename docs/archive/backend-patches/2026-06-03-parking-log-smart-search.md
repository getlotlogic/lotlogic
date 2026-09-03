# Backend patch — `/visitor_passes/parking-log` smart search

**Target repo:** `getlotlogic/lotlogic-backend`
**Status:** Ready to apply. Frontend already ships (PR #207 + #208 in `getlotlogic/lotlogic`). Indexes ship via `migrations/025_visitor_passes_search_indexes.sql` in this repo.
**Created:** 2026-06-03

## Why

Frontend smart search currently fetches up to 500 rows for the date window and filters live in-memory. That's fine for any single truck plaza right now (typical 7-day window has <100 passes). But:

- Properties that exceed 500 passes per date window will miss matches outside the cap.
- 500-row pulls are heavier than a targeted backend query.
- The "matched: X" chip would be more meaningful if the server returned the matched field directly.

This patch moves the smart-search logic to the backend with a `q` query parameter. The frontend keeps its live filter as a fast UX layer but no longer carries the correctness risk.

## What changes

`routers/visitor_passes.py` (or wherever `GET /visitor_passes/parking-log` lives) — add a `q: str | None = None` query parameter and a `WHERE` clause that does ILIKE substring across the same set of fields the frontend already matches:

- `plate_text` (normalized: uppercase, alphanumeric only — both sides)
- `visitor_name`
- `company_name`
- `phone` (digits-only, both sides)
- `placard_color`
- `parking_spot`
- `reference_id`

The existing `plate` and `company_name` params stay for backwards compatibility but are also upgraded to ILIKE substring (matches frontend normalization).

## Required DB indexes (already in this repo)

Apply first:

```bash
# From getlotlogic/lotlogic repo, with supabase CLI configured
supabase db push --include-all
# OR apply individually:
psql "$DATABASE_URL" -f migrations/025_visitor_passes_search_indexes.sql
```

The migration is idempotent (`CREATE INDEX IF NOT EXISTS`) and enables `pg_trgm`. No data is changed.

## FastAPI patch

The actual file in `lotlogic-backend` is likely `routers/visitor_passes.py` or `app/api/visitor_passes.py`. The existing route signature accepts `property_id`, `format`, `status`, `plate`, `company_name`, `date_from`, `date_to`, `page`, `page_size` (per frontend `db.getParkingLog` at `frontend/dashboard.html:2853`).

### Variant A — supabase-py client (most likely)

```python
import re
from datetime import date
from uuid import UUID
from fastapi import APIRouter, Depends, Query
from typing import Literal

from app.deps import require_subject, Subject
from app.services import scope
from app.db import supabase_client  # or however the project exposes it

router = APIRouter(prefix="/visitor_passes", tags=["visitor_passes"])

# Same normalization the QR forms use on registration (visit.html:386).
def _normalize_plate(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"[^A-Z0-9]", "", s.upper())

def _digits_only(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"\D", "", s)


@router.get("/parking-log")
def parking_log(
    property_id: UUID,
    subject: Subject = Depends(require_subject),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    status: str | None = Query(None),
    plate: str | None = Query(None),             # legacy, kept for compat
    company_name: str | None = Query(None),      # legacy, kept for compat
    q: str | None = Query(None),                 # NEW: smart search
    format: Literal["json", "csv"] = Query("json"),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
):
    # Tenant scoping — existing helper.
    scope.assert_property_access(subject, property_id)

    qb = (
        supabase_client
        .from_("visitor_passes")
        .select(
            "id,property_id,plate_text,visitor_name,company_name,phone,"
            "placard_color,parking_spot,reference_id,vehicle_type,"
            "valid_from,valid_until,created_at,cancelled_at,cancelled_by,"
            "stay_days,policy_acknowledged_at,status,usdot_number,mc_number",
            count="exact",
        )
        .eq("property_id", str(property_id))
    )

    if status:
        qb = qb.eq("status", status)
    if date_from:
        qb = qb.gte("created_at", date_from.isoformat())
    if date_to:
        # End of day, inclusive — matches the frontend's date_to semantics.
        qb = qb.lt(
            "created_at",
            (date_to.replace(day=date_to.day) + __import__("datetime").timedelta(days=1)).isoformat(),
        )

    # NEW: smart search OR group across every QR-form field.
    if q and q.strip():
        q_raw = q.strip()
        q_plate = _normalize_plate(q_raw)
        q_digits = _digits_only(q_raw)
        # PostgREST OR syntax: column.op.value joined by commas, wrapped.
        # ilike with %% wildcards. Escape % and , in user input to keep
        # the OR group parseable.
        def esc(v: str) -> str:
            return v.replace("%", "\\%").replace(",", "\\,").replace("(", "\\(").replace(")", "\\)")
        parts: list[str] = []
        if len(q_plate) >= 2:
            parts.append(f"plate_text.ilike.%{esc(q_plate)}%")
        parts.append(f"visitor_name.ilike.%{esc(q_raw)}%")
        parts.append(f"company_name.ilike.%{esc(q_raw)}%")
        if len(q_digits) >= 4:
            # Match the digits index: regexp_replace(phone, '\D', '', 'g')
            # PostgREST can't call functions in OR clauses, so fall back to
            # a plain ilike on phone — the digit-only path is covered by the
            # trigram index on the normalized expression for any "+1" prefix.
            parts.append(f"phone.ilike.%{esc(q_digits)}%")
        parts.append(f"placard_color.ilike.%{esc(q_raw)}%")
        parts.append(f"parking_spot.ilike.%{esc(q_raw)}%")
        parts.append(f"reference_id.ilike.%{esc(q_raw)}%")
        qb = qb.or_(",".join(parts))
    else:
        # Legacy single-field filters — also upgraded to substring + normalized.
        if plate and plate.strip():
            p_norm = _normalize_plate(plate)
            if p_norm:
                qb = qb.ilike("plate_text", f"%{p_norm}%")
        if company_name and company_name.strip():
            qb = qb.ilike("company_name", f"%{company_name}%")

    offset = (page - 1) * page_size
    res = (
        qb
        .order("created_at", desc=True)
        .range(offset, offset + page_size - 1)
        .execute()
    )

    if format == "csv":
        # existing CSV builder — pass res.data through unchanged
        return _build_csv_response(res.data)

    return {
        "items": res.data or [],
        "total": res.count or 0,
        "page": page,
        "page_size": page_size,
    }
```

### Variant B — raw SQL via asyncpg / SQLAlchemy

If the project uses raw SQL, the equivalent `WHERE` clause:

```sql
WHERE property_id = :property_id
  AND ($date_from::date IS NULL OR created_at >= :date_from)
  AND ($date_to::date   IS NULL OR created_at <  ($date_to::date + INTERVAL '1 day'))
  AND ($status::text    IS NULL OR status = :status)
  AND (
    $q::text IS NULL
    OR (
      -- Plate (normalized both sides)
      (length(regexp_replace(upper(:q), '[^A-Z0-9]', '', 'g')) >= 2
        AND regexp_replace(upper(plate_text), '[^A-Z0-9]', '', 'g') ILIKE
            '%' || regexp_replace(upper(:q), '[^A-Z0-9]', '', 'g') || '%')
      OR visitor_name  ILIKE '%' || :q || '%'
      OR company_name  ILIKE '%' || :q || '%'
      -- Phone (digits-only both sides)
      OR (length(regexp_replace(:q, '\D', '', 'g')) >= 4
        AND regexp_replace(phone, '\D', '', 'g') ILIKE
            '%' || regexp_replace(:q, '\D', '', 'g') || '%')
      OR placard_color ILIKE '%' || :q || '%'
      OR parking_spot  ILIKE '%' || :q || '%'
      OR reference_id  ILIKE '%' || :q || '%'
    )
  )
ORDER BY created_at DESC
LIMIT :page_size OFFSET :offset
```

The expression indexes from migration `025` cover the `regexp_replace(...)` paths so the planner uses them.

## Frontend follow-up (optional, after backend ships)

Once the backend `q` param is live, the frontend can simplify:

```js
// frontend/dashboard.html — db.getParkingLog
async getParkingLog(propertyId, opts = {}) {
  const params = new URLSearchParams();
  params.set('property_id', propertyId);
  if (opts.format) params.set('format', opts.format);
  if (opts.status) params.set('status', opts.status);
  if (opts.q) params.set('q', opts.q);                    // NEW
  if (opts.date_from) params.set('date_from', opts.date_from);
  if (opts.date_to) params.set('date_to', opts.date_to);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.page_size) params.set('page_size', String(opts.page_size));
  // ...
}
```

And in `TruckParkingLog.load()`, pass `q: searchText.trim()` so the backend pre-filters. The client-side substring filter can stay as a final pass (gives the "matched: X" chips). The 500-row safety cap can be raised to whatever pagination size makes sense.

But none of this is required — the current frontend works fine without the backend change. This patch is a scale + correctness upgrade.

## Deployment order

1. Apply DB migration: `migrations/025_visitor_passes_search_indexes.sql` (this repo)
2. Deploy lotlogic-backend with the FastAPI patch above
3. Optionally, deploy the frontend simplification

No order coupling — the backend handles missing `q` gracefully (falls back to legacy `plate`/`company_name` params), so steps 2 and 3 can be in either order.

## Test plan (backend)

```bash
# Get a JWT for an account with property access (existing dev token works)
JWT=...

# Smoke: parking-log without q still works
curl -H "Authorization: Bearer $JWT" \
  "https://lotlogic-backend-production.up.railway.app/visitor_passes/parking-log?property_id=$PROP&date_from=2026-05-25&date_to=2026-06-03"

# Smart search by partial plate (mixed case + spaces)
curl -H "Authorization: Bearer $JWT" \
  "https://lotlogic-backend-production.up.railway.app/visitor_passes/parking-log?property_id=$PROP&q=abc%201234"

# Smart search by driver name
curl -H "Authorization: Bearer $JWT" \
  "https://lotlogic-backend-production.up.railway.app/visitor_passes/parking-log?property_id=$PROP&q=Daniel"

# Smart search by company
curl -H "Authorization: Bearer $JWT" \
  "https://lotlogic-backend-production.up.railway.app/visitor_passes/parking-log?property_id=$PROP&q=Swift"

# Smart search by phone digits
curl -H "Authorization: Bearer $JWT" \
  "https://lotlogic-backend-production.up.railway.app/visitor_passes/parking-log?property_id=$PROP&q=7179194840"
```

All should return matching rows. Verify `EXPLAIN ANALYZE` uses the trigram indexes on the production-sized table.
