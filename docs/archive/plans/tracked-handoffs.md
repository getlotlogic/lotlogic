# Tracked Cross-Repo Hand-offs

Things that need to land in a repo other than `lotlogic` (the frontend + edge
functions + migrations repo), enumerated so they don't get lost.

## Open

### 1. `lotlogic-backend` — visitor_pass POST must reject held plates

**Blocker for:** Task 19 of
`docs/superpowers/plans/2026-04-20-camera-session-state-machine.md`.
Without this guard, a driver who's on a 24-hour hold can still register
via the QR code flow, which defeats the early-exit penalty that the state
machine just put in place.

**What to change:** at the top of the visitor_pass POST handler (the endpoint
that `visit.html` posts to when a driver completes the truck-plaza /
temporary-pass form), after normalizing the plate text, look up
`plate_holds` for an unexpired row and refuse the POST with HTTP 409 if
one exists.

**File:** likely `routers/visitor_passes.py` in `getlotlogic/lotlogic-backend`.
Search for where a `visitor_passes` row is INSERTed.

**Code sketch** (FastAPI + asyncpg flavour — adjust for whatever ORM / DB
layer the backend actually uses):

```python
import re
from fastapi import HTTPException

# ... inside the visitor_pass POST handler, BEFORE the INSERT ...

normalized_plate = re.sub(r"[^A-Z0-9]", "", plate_text.upper())

held_row = await db.fetch_one(
    """
    SELECT held_at, hold_until
      FROM plate_holds
     WHERE property_id = :property_id
       AND normalized_plate = :plate
       AND hold_until > now()
     ORDER BY hold_until DESC
     LIMIT 1
    """,
    {"property_id": property_id, "plate": normalized_plate},
)

if held_row:
    # Return a structured 409 so visit.html can show a friendly message.
    raise HTTPException(
        status_code=409,
        detail={
            "code": "plate_on_hold",
            "held_at": held_row["held_at"].isoformat(),
            "hold_until": held_row["hold_until"].isoformat(),
            "message": (
                "This plate left the lot before its previous registration "
                "ended, and is on a 24-hour hold. Please try again after "
                f"{held_row['hold_until'].strftime('%I:%M %p %Z')}."
            ),
        },
    )
```

**Frontend counterpart:** `frontend/visit.html` already has error handling
for backend responses. When it receives a 409 with
`detail.code === 'plate_on_hold'`, render the message in `detail.message`
instead of the generic failure toast. If `visit.html` currently only
handles the generic case, this frontend change rides alongside the
backend PR (same change set, touches both repos' PRs simultaneously).

**Test:**

```sql
-- On Supabase: create a fake hold for testing.
INSERT INTO plate_holds (property_id, normalized_plate, source_session_id, held_at, hold_until, reason)
VALUES (
  'bd44ace8-feda-42e1-9866-5d60f65e1712',
  'TESTHOLD1',
  (SELECT id FROM plate_sessions LIMIT 1),  -- any session is fine for the FK
  now() - interval '1 hour',
  now() + interval '23 hours',
  'early_exit'
);
```

Then POST to the visitor_pass endpoint with `plate_text='TEST-HOLD1'` (raw,
before normalization). Expect `409` with `detail.code='plate_on_hold'`.
Clean up: `DELETE FROM plate_holds WHERE normalized_plate = 'TESTHOLD1';`

**Tracked status:** not yet opened as a PR.

## Closed / handed off

(none yet)
