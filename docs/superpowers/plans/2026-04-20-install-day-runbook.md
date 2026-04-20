# Install day runbook — 2026-04-20

Things to do tomorrow at Charlotte Travel Plaza in the order to do them.

## What I (Claude) already shipped last night

Apr 19, committed on branch `feat/camera-state-machine`, PR #84 open:

- 4 migrations (011 camera orientation, 012 plate_sessions, 013 plate_holds,
  014 pg_cron schedule) — all applied to prod Supabase.
- `cron-sessions-sweep` edge function — deployed, running every minute.
- `camera-snapshot` edge function v5 — deployed, orientation-aware.
- Dashboard: In Lot Now, 24-Hour Holds (with Release button), Left-before-tow
  queue, session state badges.
- Ops-ready SQL seed file for the 3 new cameras (placeholders to fill in):
  `migrations/ops/2026-04-20-register-charlotte-cameras.sql`
- Backend hand-off doc: `docs/superpowers/plans/tracked-handoffs.md`

**Nothing that affects behavior on the existing single camera** — Charlotte
Travel Plaza still works exactly like last night. The new machinery activates
when cameras with `orientation='exit'` exist and open sessions get the 15-min
grace treatment.

## What I need from you tomorrow

1. **Merge PR #84** after eyeballing the diff — `https://github.com/getlotlogic/lotlogic/pull/84`
2. **Physical install**: place the 3 new cameras at the 2 entrances (one
   entry + one exit per entrance, existing camera stays at Entrance A entry).
3. **Per camera — from each Milesight's local AP:**
   - Grab the `devMac` (hex string, ~12 chars like `1CC31660025E`). Write
     it down beside which role the camera serves (A-exit / B-entry / B-exit).
   - Set the HTTP POST URL to the existing
     `https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/camera-snapshot/<CAMERA_SNAPSHOT_URL_SECRET>`
     (secret is in `.env.local`). Same URL for all 4 cameras — they identify
     themselves via `devMac`.
4. **Fill in the 3 MACs** in `migrations/ops/2026-04-20-register-charlotte-cameras.sql`
   (three `MAC_TO_FILL_*` placeholders) and run via the Supabase MCP
   `apply_migration` tool or the SQL editor.
5. **Drive-by verify** each camera individually:
   ```sql
   SELECT c.name, c.orientation, COUNT(e.id) AS events_10m
     FROM alpr_cameras c
     LEFT JOIN plate_events e ON e.camera_id = c.id AND e.created_at > now() - interval '10 minutes'
    WHERE c.property_id = 'bd44ace8-feda-42e1-9866-5d60f65e1712'
    GROUP BY c.id, c.name, c.orientation ORDER BY c.name;
   ```
   Expected: each camera has ≥1 recent event matching its role. A mis-cabled
   camera will either get 0 events (plates not crossing its field) or land
   events under the wrong camera name.

6. **End-to-end smoke (five scenarios):**
   - **Grace → tow.** Enter, don't register, wait 16 minutes. Expect a new
     `alpr_violations` row with `session_id` filled in, session state flips to
     `expired`, email lands at `standardvendingcompany@gmail.com`.
   - **Grace → register → clean exit.** Enter, register via QR within 15 min
     (pick 12h duration), exit via Entrance A Exit or B Exit. Expect session
     state = `closed_clean`, no violation created.
   - **Early exit → hold.** Enter, register 24h, exit after 10 min. Expect
     session state = `closed_early`, `plate_holds` row with
     `hold_until ≈ now() + 24h`.
   - **Held re-entry.** Immediately try to register the same plate via QR.
     Expect **this step fails** unless the backend hold guard (Task 19 /
     cross-repo hand-off) has been deployed. Today that means the visitor
     pass may actually succeed — the guard is the thing that enforces
     "you're held, go away." Confirm with the lotlogic-backend maintainer
     (or me) that the PR is in before expecting this to work correctly.
   - **Left before tow.** With a dispatched violation still open, drive past
     Exit camera before the tow truck's plate is scanned. Expect
     `alpr_violations.left_before_tow_at` is set and the row appears in the
     new "Left before tow" queue in Billing → Confirmation Review.

7. **Optional cleanup** of today's test rows if you want a clean slate:
   ```sql
   -- DANGER: review the counts before deleting.
   SELECT COUNT(*) FROM plate_events WHERE created_at < '2026-04-20T00:00:00Z'
                                       AND property_id = 'bd44ace8-feda-42e1-9866-5d60f65e1712';
   SELECT COUNT(*) FROM alpr_violations WHERE created_at < '2026-04-20T00:00:00Z'
                                       AND property_id = 'bd44ace8-feda-42e1-9866-5d60f65e1712';
   ```
   Only actually delete if the counts look right; I can help judge.

8. **Backend visitor_pass hold guard.** See
   `docs/superpowers/plans/tracked-handoffs.md` for the code to drop into the
   `lotlogic-backend` repo. Until this ships, the 24h hold only logs — it
   doesn't actually block re-registration.

## If something goes sideways

- **Cameras not reaching us?** Check edge function logs for
  `camera-snapshot` via the MCP `get_logs` tool. If not even a request is
  landing, the Milesight's URL is wrong or SIM is down.
- **Cron not firing?**
  ```sql
  SELECT * FROM cron.job_run_details
   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'plate_sessions_sweep')
   ORDER BY start_time DESC LIMIT 5;
  ```
  If the most recent `status` is `failed`, read the `return_message`.
- **Email not landing?** `standardvendingcompany@gmail.com` Spam folder first,
  then `cron-sessions-sweep` logs for `tow-dispatch-email <status>` warnings.
  The SendGrid dashboard's Activity tab also shows per-email delivery status.
- **Stuck-open sessions** (a car "entered" but never "exited" in our DB
  because a camera missed the exit event):
  ```sql
  SELECT * FROM plate_sessions
   WHERE exited_at IS NULL AND entered_at < now() - interval '12 hours';
  ```
  Anything here after a full day is a hint that an exit camera isn't
  catching its lane.

## Rollback path per change

Each piece is reversible without breaking the rest.

- **Migration rollback order:** 014 → 013 → 012 → 011 (reverse order of
  application). Each is a single DROP statement (DROP TABLE, DROP COLUMN,
  DROP VIEW, `SELECT cron.unschedule(jobname)`).
- **Edge function rollback:** `camera-snapshot` can be redeployed from an
  earlier SHA via `supabase functions deploy` against an older worktree.
  `cron-sessions-sweep` can be deleted (`mcp__claude_ai_SupaBase__delete_edge_function`
  — actually the SDK only exposes deploy, so `cron.unschedule('plate_sessions_sweep')`
  is sufficient to stop it silently).
- **Dashboard rollback:** revert PR #84.
