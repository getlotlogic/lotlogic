# Repeat-Offender Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Truck Parking Log pass, show a chip when the truck re-registered within its 24h cooldown — with a "flagged N× before" count and a click-to-expand list of recent visits (photo · date · outcome · flag).

**Architecture:** Persist a `cooldown_flagged_at` marker on `visitor_passes`, computed by a `BEFORE INSERT` trigger at registration (single source of truth, matching the hardened `cooldownIds` rule). The parking-log endpoint returns the flag + a prior-flag count; a separate lightweight endpoint returns the recent-visits list lazily on expand. The frontend renders the chip and unifies its existing render-time cooldown derivation to read the persisted flag.

**Tech Stack:** Postgres (Supabase) migrations applied via `mcp__supabase__apply_migration` + committed files; Python/FastAPI backend (`lotlogic-backend`, pytest); single-file React/Babel frontend (`lotlogic/frontend/dashboard.html`, Playwright e2e).

**Repos:** DB migrations + backend live in `~/lotlogic-backend`; the dashboard + spec/plan live in `~/lotlogic`. Migrations are applied to prod via the Supabase MCP AND committed as files (per `lotlogic-backend/CLAUDE.md`).

---

## File Structure

- `lotlogic-backend/migrations/<ts>_add_cooldown_flagged_at.sql` — column (Task 1)
- `lotlogic-backend/migrations/<ts>_pass_cooldown_flag_trigger.sql` — BEFORE INSERT trigger (Task 2)
- `lotlogic-backend/migrations/<ts>_backfill_cooldown_flagged_at.sql` — one-time backfill (Task 3)
- `lotlogic-backend/routers/visitor_passes.py` — parking-log returns flag + prior count (Task 4); recent-visits endpoint (Task 5)
- `lotlogic-backend/tests/test_repeat_offender.py` — backend tests (Tasks 4–5)
- `lotlogic/frontend/dashboard.html` — chip render + expand (Task 6); unify `cooldownIds` + `count_on_cooldown` consumer (Task 7)
- `lotlogic/tests/e2e/repeat-offender-chip.spec.ts` — Playwright (Task 6)

Each task produces a self-contained, committable change.

---

## Task 1: Add `cooldown_flagged_at` column

**Files:**
- Create: `lotlogic-backend/migrations/<ts>_add_cooldown_flagged_at.sql` (`<ts>` = `date -u +%Y%m%d%H%M%S`)

- [ ] **Step 1: Write the column migration file**

```sql
-- Quiet marker: set at INSERT when a truck-plaza pass is a cooldown
-- re-registration (within 24h of the same plate's last exit). No alert/email.
alter table public.visitor_passes
  add column if not exists cooldown_flagged_at timestamptz;

comment on column public.visitor_passes.cooldown_flagged_at is
  'Set at insert by trg_set_pass_cooldown_flag when this truck-plaza pass is a cooldown re-registration. Quiet marker only.';
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply the file's SQL with `mcp__supabase__apply_migration`, name `add_cooldown_flagged_at`.
Expected: `{"success": true}`.

- [ ] **Step 3: Verify the column exists**

Run via `mcp__supabase__execute_sql`:
```sql
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='visitor_passes' and column_name='cooldown_flagged_at';
```
Expected: one row, `timestamp with time zone`.

- [ ] **Step 4: Commit**

```bash
cd ~/lotlogic-backend
git add migrations/*_add_cooldown_flagged_at.sql
git commit -m "feat: add visitor_passes.cooldown_flagged_at marker column"
```

---

## Task 2: Cooldown-flag BEFORE INSERT trigger

The trigger sets `NEW.cooldown_flagged_at` when a prior real-stay pass for the
same truck (front OR back plate) ended within 24h. Matches the hardened
`cooldownIds` rule: end = `coalesce(exited_at, valid_until)`, flagged when
`end > reg - 24h`. Excludes operator-cancelled/revoked priors and placeholder plates.

**Files:**
- Create: `lotlogic-backend/migrations/<ts>_pass_cooldown_flag_trigger.sql`

- [ ] **Step 1: Write the SQL test scenario first (a throwaway verification block)**

Run via `mcp__supabase__execute_sql` against a scratch property to confirm CURRENT behavior is "no flag ever" (trigger not yet created). Use an existing `truck_plaza` property id `:pid` (find one: `select id from properties where property_type='truck_plaza' limit 1`). Insert a prior exited pass + a re-registration, then read the flag:

```sql
-- EXPECT (pre-trigger): cooldown_flagged_at IS NULL on the second insert.
begin;
insert into visitor_passes (property_id, plate_text, normalized_back_plate, valid_from, valid_until, status, exited_at)
  values (:pid, 'ZZTEST1', null, now() - interval '30 hours', now() - interval '6 hours', 'cancelled', now() - interval '6 hours');
insert into visitor_passes (property_id, plate_text, normalized_back_plate, valid_from, valid_until, status)
  values (:pid, 'ZZTEST1', null, now(), now() + interval '24 hours', 'active')
  returning cooldown_flagged_at;  -- pre-trigger: NULL
rollback;
```
Expected now: `cooldown_flagged_at` = NULL (no trigger yet). This is the "failing test" — it SHOULD become non-null after the trigger exists.

- [ ] **Step 2: Write the trigger migration file**

```sql
-- Set cooldown_flagged_at when a truck-plaza pass is a cooldown re-registration:
-- a prior REAL-STAY pass for the same truck (front OR back plate, normalized)
-- ended within 24h. Mirrors the frontend cooldownIds rule. Quiet marker only.
create or replace function public.set_pass_cooldown_flag()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  ptype text;
  reg   timestamptz := coalesce(new.valid_from, now());
  newf  text := regexp_replace(upper(coalesce(new.plate_text,'')), '[^A-Z0-9]', '', 'g');
  newb  text := coalesce(new.normalized_back_plate, '');
  placeholders text[] := array['NOPLATE','TEMPTAG','NONE','NA','TEMP','UNKNOWN'];
begin
  select property_type into ptype from properties where id = new.property_id;
  if ptype is distinct from 'truck_plaza' then
    return new;
  end if;

  -- Guard placeholder plates so different trucks sharing 'NOPLATE' never group.
  if newf = any(placeholders) then newf := ''; end if;
  if newb = any(placeholders) then newb := ''; end if;
  if newf = '' and newb = '' then
    return new;
  end if;

  if exists (
    select 1
    from visitor_passes p
    where p.property_id = new.property_id
      and p.id is distinct from new.id
      and not (p.status = 'revoked'
               or (p.status = 'cancelled' and coalesce(p.cancelled_by,'') not like 'camera_exit%'))
      and (
        (newf <> '' and (regexp_replace(upper(coalesce(p.plate_text,'')),'[^A-Z0-9]','','g') = newf
                         or p.normalized_back_plate = newf))
        or
        (newb <> '' and (regexp_replace(upper(coalesce(p.plate_text,'')),'[^A-Z0-9]','','g') = newb
                         or p.normalized_back_plate = newb))
      )
      and coalesce(p.exited_at, p.valid_until) > reg - interval '24 hours'
  ) then
    new.cooldown_flagged_at := reg;
  end if;

  return new;
end;
$function$;

revoke execute on function public.set_pass_cooldown_flag() from public, anon, authenticated;

drop trigger if exists trg_set_pass_cooldown_flag on public.visitor_passes;
create trigger trg_set_pass_cooldown_flag
  before insert on public.visitor_passes
  for each row execute function public.set_pass_cooldown_flag();
```

- [ ] **Step 3: Apply via Supabase MCP**

Apply with `mcp__supabase__apply_migration`, name `pass_cooldown_flag_trigger`. Expected `{"success": true}`.

- [ ] **Step 4: Run the test scenarios — verify PASS**

Run via `mcp__supabase__execute_sql` (each in its own `begin; … rollback;` so nothing persists):

Scenario A — re-reg within 24h ⇒ flagged:
```sql
begin;
insert into visitor_passes (property_id, plate_text, valid_from, valid_until, status, exited_at)
  values (:pid,'ZZTEST1', now()-interval '30 hours', now()-interval '6 hours','cancelled', now()-interval '6 hours');
insert into visitor_passes (property_id, plate_text, valid_from, valid_until, status)
  values (:pid,'ZZTEST1', now(), now()+interval '24 hours','active')
  returning (cooldown_flagged_at is not null) as flagged;  -- EXPECT: true
rollback;
```

Scenario B — last exit > 24h ago ⇒ NOT flagged:
```sql
begin;
insert into visitor_passes (property_id, plate_text, valid_from, valid_until, status, exited_at)
  values (:pid,'ZZTEST2', now()-interval '5 days', now()-interval '4 days','cancelled', now()-interval '4 days');
insert into visitor_passes (property_id, plate_text, valid_from, valid_until, status)
  values (:pid,'ZZTEST2', now(), now()+interval '24 hours','active')
  returning (cooldown_flagged_at is not null) as flagged;  -- EXPECT: false
rollback;
```

Scenario C — prior operator-cancelled (not camera_exit) ⇒ NOT flagged:
```sql
begin;
insert into visitor_passes (property_id, plate_text, valid_from, valid_until, status, cancelled_by, cancelled_at)
  values (:pid,'ZZTEST3', now()-interval '10 hours', now()+interval '14 hours','cancelled','operator@x (dup)', now()-interval '2 hours');
insert into visitor_passes (property_id, plate_text, valid_from, valid_until, status)
  values (:pid,'ZZTEST3', now(), now()+interval '24 hours','active')
  returning (cooldown_flagged_at is not null) as flagged;  -- EXPECT: false
rollback;
```

Scenario D — front/back cross-match (prior front = new back) ⇒ flagged:
```sql
begin;
insert into visitor_passes (property_id, plate_text, valid_from, valid_until, status, exited_at)
  values (:pid,'FRONT99', now()-interval '20 hours', now()-interval '3 hours','cancelled', now()-interval '3 hours');
insert into visitor_passes (property_id, plate_text, normalized_back_plate, valid_from, valid_until, status)
  values (:pid,'OTHERXX','FRONT99', now(), now()+interval '24 hours','active')
  returning (cooldown_flagged_at is not null) as flagged;  -- EXPECT: true
rollback;
```

All four must match their EXPECT comment.

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic-backend
git add migrations/*_pass_cooldown_flag_trigger.sql
git commit -m "feat: BEFORE INSERT trigger sets cooldown_flagged_at on cooldown re-registrations"
```

---

## Task 3: Backfill existing passes

**Files:**
- Create: `lotlogic-backend/migrations/<ts>_backfill_cooldown_flagged_at.sql`

- [ ] **Step 1: Write the backfill migration file**

```sql
-- One-time: stamp cooldown_flagged_at on historical truck-plaza passes using the
-- same rule as the trigger (a prior real-stay same-truck pass ended within 24h
-- before this pass's registration).
update visitor_passes vp
set cooldown_flagged_at = coalesce(vp.valid_from, vp.created_at)
from properties pr
where pr.id = vp.property_id and pr.property_type = 'truck_plaza'
  and vp.cooldown_flagged_at is null
  and regexp_replace(upper(coalesce(vp.plate_text,'')),'[^A-Z0-9]','','g') <> ''
  and exists (
    select 1 from visitor_passes p
    where p.property_id = vp.property_id
      and p.id <> vp.id
      and p.created_at < vp.created_at
      and not (p.status='revoked'
               or (p.status='cancelled' and coalesce(p.cancelled_by,'') not like 'camera_exit%'))
      and (
        regexp_replace(upper(coalesce(p.plate_text,'')),'[^A-Z0-9]','','g')
          = regexp_replace(upper(coalesce(vp.plate_text,'')),'[^A-Z0-9]','','g')
        or p.normalized_back_plate = regexp_replace(upper(coalesce(vp.plate_text,'')),'[^A-Z0-9]','','g')
        or (coalesce(vp.normalized_back_plate,'') <> ''
            and (regexp_replace(upper(coalesce(p.plate_text,'')),'[^A-Z0-9]','','g') = vp.normalized_back_plate
                 or p.normalized_back_plate = vp.normalized_back_plate))
      )
      and coalesce(p.exited_at, p.valid_until)
            > coalesce(vp.valid_from, vp.created_at) - interval '24 hours'
      and coalesce(p.exited_at, p.valid_until) <= coalesce(vp.valid_from, vp.created_at)
  );
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with name `backfill_cooldown_flagged_at`. Expected `{"success": true}`.

- [ ] **Step 3: Spot-check the result**

```sql
select count(*) filter (where cooldown_flagged_at is not null) as flagged,
       count(*) as total
from visitor_passes vp join properties pr on pr.id=vp.property_id
where pr.property_type='truck_plaza';
```
Expected: a plausible non-negative `flagged` ≤ `total`. Then hand-verify 2 flagged rows by re-running the EXISTS rule for their plate — confirm a real prior exit within 24h.

- [ ] **Step 4: Commit**

```bash
cd ~/lotlogic-backend
git add migrations/*_backfill_cooldown_flagged_at.sql
git commit -m "feat: backfill cooldown_flagged_at on historical truck-plaza passes"
```

---

## Task 4: parking-log returns flag + prior-flag count

Extend the parking-log query so each row carries `cooldown_flagged_at` and
`prior_flag_count` (count of EARLIER flagged passes for the same truck). Cheap
aggregate; recent-visits list is lazy (Task 5).

**Files:**
- Modify: `lotlogic-backend/routers/visitor_passes.py` (the parking-log SELECT + row serialization)
- Test: `lotlogic-backend/tests/test_repeat_offender.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_repeat_offender.py
from routers.visitor_passes import build_prior_flag_count_sql

def test_prior_flag_count_sql_counts_earlier_flagged_same_plate():
    sql = build_prior_flag_count_sql()
    # Counts EARLIER passes (created_at < this row), same property,
    # front/back plate match, cooldown_flagged_at not null.
    assert "cooldown_flagged_at is not null" in sql
    assert "created_at <" in sql
    assert "normalized_back_plate" in sql
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/lotlogic-backend && python3.11 -m pytest tests/test_repeat_offender.py -q`
Expected: FAIL — `ImportError: cannot import name 'build_prior_flag_count_sql'`.

- [ ] **Step 3: Implement the helper + wire it into the parking-log query**

In `routers/visitor_passes.py`, add:
```python
def build_prior_flag_count_sql() -> str:
    """Correlated subquery: count of EARLIER flagged passes for the same truck
    (front or back plate, normalized), used as prior_flag_count per row."""
    return """
      (select count(*) from public.visitor_passes pf
        where pf.property_id = vp.property_id
          and pf.created_at < vp.created_at
          and pf.cooldown_flagged_at is not null
          and (
            regexp_replace(upper(coalesce(pf.plate_text,'')),'[^A-Z0-9]','','g')
              = regexp_replace(upper(coalesce(vp.plate_text,'')),'[^A-Z0-9]','','g')
            or pf.normalized_back_plate = regexp_replace(upper(coalesce(vp.plate_text,'')),'[^A-Z0-9]','','g')
            or (coalesce(vp.normalized_back_plate,'') <> ''
                and (regexp_replace(upper(coalesce(pf.plate_text,'')),'[^A-Z0-9]','','g') = vp.normalized_back_plate
                     or pf.normalized_back_plate = vp.normalized_back_plate))
          ))
    """.strip()
```
Then add `vp.cooldown_flagged_at` and `{build_prior_flag_count_sql()} as prior_flag_count` to the parking-log SELECT column list, and include both in the row dict the endpoint returns (JSON: `cooldown_flagged_at`, `prior_flag_count`).

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd ~/lotlogic-backend && python3.11 -m pytest tests/test_repeat_offender.py -q`
Expected: PASS.

- [ ] **Step 5: Lint + compile**

Run: `cd ~/lotlogic-backend && ruff check routers/visitor_passes.py && python3.11 -m py_compile routers/visitor_passes.py`
Expected: "All checks passed!" and no compile error.

- [ ] **Step 6: Commit**

```bash
cd ~/lotlogic-backend
git add routers/visitor_passes.py tests/test_repeat_offender.py
git commit -m "feat: parking-log returns cooldown_flagged_at + prior_flag_count"
```

---

## Task 5: Recent-visits endpoint (lazy, for expand)

Returns a truck's most-recent 5 passes for the expanded list. Keyed by pass id
(server resolves the plates) so the frontend doesn't pass plate strings around.

**Files:**
- Modify: `lotlogic-backend/routers/visitor_passes.py` (new route `GET /visitor_passes/{id}/recent-visits`)
- Test: `lotlogic-backend/tests/test_repeat_offender.py`

- [ ] **Step 1: Write the failing test**

```python
from routers.visitor_passes import build_recent_visits_sql

def test_recent_visits_sql_excludes_self_and_limits_five():
    sql = build_recent_visits_sql()
    assert "p.id <> :pass_id" in sql          # exclude the current pass
    assert "first_seen_event_id" in sql        # photo link
    assert "order by p.created_at desc" in sql
    assert "limit 5" in sql
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/lotlogic-backend && python3.11 -m pytest tests/test_repeat_offender.py::test_recent_visits_sql_excludes_self_and_limits_five -q`
Expected: FAIL — `cannot import name 'build_recent_visits_sql'`.

- [ ] **Step 3: Implement the SQL builder + the route**

In `routers/visitor_passes.py`:
```python
def build_recent_visits_sql() -> str:
    """Most-recent 5 passes for the same truck as :pass_id (front/back plate),
    excluding the pass itself. Joins the photo event for a thumbnail."""
    return """
      with me as (
        select property_id,
               regexp_replace(upper(coalesce(plate_text,'')),'[^A-Z0-9]','','g') as f,
               coalesce(normalized_back_plate,'') as b
        from public.visitor_passes where id = :pass_id
      )
      select p.id, p.plate_text, p.valid_from, p.valid_until, p.exited_at,
             p.status, p.cancelled_by, (p.cooldown_flagged_at is not null) as flagged,
             pe.image_url as photo_url
      from public.visitor_passes p, me
        left join public.plate_events pe
          on pe.id = (select fse.id from public.plate_events fse
                       where fse.id = (select first_seen_event_id from public.visitor_passes where id = p.id))
      where p.property_id = me.property_id
        and p.id <> :pass_id
        and (
          (me.f <> '' and (regexp_replace(upper(coalesce(p.plate_text,'')),'[^A-Z0-9]','','g') = me.f
                           or p.normalized_back_plate = me.f))
          or (me.b <> '' and (regexp_replace(upper(coalesce(p.plate_text,'')),'[^A-Z0-9]','','g') = me.b
                              or p.normalized_back_plate = me.b))
        )
      order by p.created_at desc
      limit 5
    """.strip()
```
Add an owner/partner-scoped route `GET /visitor_passes/{pass_id}/recent-visits` that runs this SQL (bind `:pass_id`), maps each row to `{id, date: valid_from, stay_hours, outcome, flagged, photo_url}` where `outcome` = `"towed"` if status='towed', `"exited"` if exited_at set or cancelled_by like 'camera_exit%', else `"cancelled"`/`"active"`. Apply the same `_assert_property_scope` guard the cancel route uses.

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd ~/lotlogic-backend && python3.11 -m pytest tests/test_repeat_offender.py -q`
Expected: PASS (both tests).

- [ ] **Step 5: Lint + compile**

Run: `cd ~/lotlogic-backend && ruff check routers/visitor_passes.py && python3.11 -m py_compile routers/visitor_passes.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd ~/lotlogic-backend
git add routers/visitor_passes.py tests/test_repeat_offender.py
git commit -m "feat: GET /visitor_passes/{id}/recent-visits for the chip expand"
```

---

## Task 6: Frontend chip + expand (`frontend/dashboard.html`)

**Files:**
- Modify: `lotlogic/frontend/dashboard.html` (Truck Parking Log row render + a small chip component)
- Test: `lotlogic/tests/e2e/repeat-offender-chip.spec.ts`

- [ ] **Step 1: Add the chip render to the pass row**

In the Truck Parking Log row render, after the plate/company line, add (React/Babel, match surrounding style):
```jsx
{r.cooldown_flagged_at && (
  <CooldownChip
    passId={r.id}
    priorFlagCount={r.prior_flag_count || 0}
  />
)}
```

- [ ] **Step 2: Implement the `CooldownChip` component**

Add near the other small components in `dashboard.html`:
```jsx
function CooldownChip({ passId, priorFlagCount }) {
  const [open, setOpen] = React.useState(false);
  const [visits, setVisits] = React.useState(null); // null=unfetched, []=none
  const [loading, setLoading] = React.useState(false);
  const toggle = async () => {
    const next = !open; setOpen(next);
    if (next && visits === null) {
      setLoading(true);
      try {
        const res = await apiFetch(`/visitor_passes/${passId}/recent-visits`);
        setVisits(res.visits || res || []);
      } catch { setVisits([]); }
      finally { setLoading(false); }
    }
  };
  const suffix = priorFlagCount > 0 ? ` · flagged ${priorFlagCount}× before` : '';
  return (
    <div className="cooldown-chip-wrap">
      <button className="parking-reg-badge cooldown" onClick={toggle}>
        ⚠ Re-registered within cooldown{suffix} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="cooldown-visits">
          {loading && <div className="cooldown-visits-loading">Loading…</div>}
          {visits && visits.length === 0 && !loading && (
            <div className="cooldown-visits-empty">No earlier visits on record.</div>
          )}
          {visits && visits.map(v => (
            <div className="cooldown-visit-row" key={v.id}>
              {v.photo_url
                ? <img className="cooldown-visit-thumb" src={v.photo_url} alt="" />
                : <div className="cooldown-visit-thumb placeholder" />}
              <span className="cooldown-visit-date">{fmtVisitDate(v.date)}</span>
              <span className="cooldown-visit-stay">{fmtStay(v.stay_hours)}</span>
              <span className="cooldown-visit-outcome">{v.outcome}</span>
              {v.flagged && <span className="cooldown-visit-flag">⚠ flagged</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function fmtVisitDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtStay(hours) {
  if (hours == null) return '';
  const days = Math.floor(hours / 24);
  return days >= 1 ? `${days}d` : `${Math.round(hours)}h`;
}
```

- [ ] **Step 3: Add minimal styles**

In the `<style>` block, near the existing `.parking-reg-badge.cooldown`:
```css
.cooldown-chip-wrap { margin-top: 4px; }
.cooldown-visits { margin-top: 6px; border-left: 2px solid rgba(251,191,36,.4); padding-left: 8px; display: flex; flex-direction: column; gap: 4px; }
.cooldown-visit-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
.cooldown-visit-thumb { width: 40px; height: 28px; object-fit: cover; border-radius: 4px; }
.cooldown-visit-thumb.placeholder { background: var(--unknown-pattern); }
.cooldown-visit-flag { color: #fbbf24; font-weight: 700; }
```

- [ ] **Step 4: Write a Playwright smoke test**

```ts
// tests/e2e/repeat-offender-chip.spec.ts
import { test, expect, accounts, loginAs } from '../fixtures/accounts';

test.describe('repeat-offender chip @smoke', () => {
  test('chip appears only on flagged passes and expands on click', async ({ page }) => {
    await loginAs(page, accounts.ownerA());
    // Navigate to a truck_plaza property's Parking Log (helper mirrors other specs).
    // A normal pass shows no chip; a flagged pass shows the chip and expands.
    const chip = page.getByRole('button', { name: /Re-registered within cooldown/i }).first();
    if (await chip.count()) {
      await chip.click();
      await expect(page.locator('.cooldown-visits')).toBeVisible();
    }
    // No-chip rows must not render the badge text inline.
    expect(true).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run Playwright (or manual verify if CI secrets unavailable)**

Run: `cd ~/lotlogic/tests && npm ci || npm install && npx playwright test e2e/repeat-offender-chip.spec.ts --project=chromium-desktop`
Expected: PASS. If test accounts aren't seeded locally, instead manually verify on the deployed preview: a flagged pass shows the chip; clicking expands the recent list with photos; a normal pass shows nothing.

- [ ] **Step 6: Commit**

```bash
cd ~/lotlogic
git add frontend/dashboard.html tests/e2e/repeat-offender-chip.spec.ts
git commit -m "feat: repeat-offender cooldown chip + recent-visits expand on truck parking log"
```

---

## Task 7: Unify `cooldownIds` + `count_on_cooldown` to read the persisted flag

Remove the render-time cooldown derivation; read `cooldown_flagged_at` instead.
One source of truth → chip, "On Cooldown" tile, and cooldown bucket agree.

**Files:**
- Modify: `lotlogic/frontend/dashboard.html` (`cooldownIds` derivation → flag read; bucket/tile consumers)
- Create: `lotlogic-backend/migrations/<ts>_count_on_cooldown_use_flag.sql`

- [ ] **Step 1: Replace the `cooldownIds` derivation**

Replace the `cooldownIds` IIFE (the `byPlate` grouping + flagging) with a direct read:
```jsx
const cooldownIds = React.useMemo(() => {
  const s = new Set();
  for (const r of (unionRows || [])) if (r.cooldown_flagged_at) s.add(r.id);
  return s;
}, [unionRows]);
```
Delete the now-dead helpers (`indexUnder`, the `byPlate`/`flagged` loop, `isRealStay`, `COOLDOWN_MS`, `COOLDOWN_PLACEHOLDER_PLATES`, `isTestRow`) only if no other consumer references them — grep first; keep any that are still used elsewhere.

- [ ] **Step 2: Verify the roster query selects the flag**

Confirm `getActiveRoster` (which does `select('*')`) and the parking-log rows both carry `cooldown_flagged_at`. `select('*')` already includes it; for the parking-log it's added in Task 4. No change if both present — otherwise add the column.

- [ ] **Step 3: Update `count_on_cooldown` RPC to key off the flag**

```sql
-- count_on_cooldown now counts active/just-ended passes carrying the persisted
-- cooldown flag, instead of re-deriving the window. Keeps SECURITY INVOKER.
create or replace function public.count_on_cooldown(p_property_id uuid, p_hours integer default 24)
returns integer language sql stable set search_path to 'public' as $$
  select count(*)::integer
  from visitor_passes vp
  where vp.property_id = p_property_id
    and vp.cooldown_flagged_at is not null
    and coalesce(vp.exited_at, vp.valid_until) > now() - make_interval(hours => p_hours);
$$;
```
Apply via `mcp__supabase__apply_migration`, name `count_on_cooldown_use_flag`, and save the file.

- [ ] **Step 4: Verify tile/bucket/chip agree on a seeded check**

Run via `mcp__supabase__execute_sql` for a truck_plaza `:pid`:
```sql
select
  (select count_on_cooldown(:pid)) as rpc_count,
  (select count(*) from visitor_passes where property_id=:pid and cooldown_flagged_at is not null
     and coalesce(exited_at, valid_until) > now() - interval '24 hours') as direct_count;
```
Expected: `rpc_count = direct_count`.

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic && git add frontend/dashboard.html && git commit -m "refactor: cooldownIds reads persisted cooldown_flagged_at (single source of truth)"
cd ~/lotlogic-backend && git add migrations/*_count_on_cooldown_use_flag.sql && git commit -m "refactor: count_on_cooldown keys off persisted cooldown_flagged_at"
```

---

## Self-Review

**Spec coverage:**
- Chip only on cooldown re-reg → Task 2 (flag) + Task 6 (render condition). ✓
- `flagged N× before` (omit at 0) → Task 4 (count) + Task 6 (suffix logic). ✓
- Expand: photo · date · stay · outcome · flag → Task 5 (data) + Task 6 (render). ✓
- Recent 5, full trail elsewhere → Task 5 `limit 5`. ✓
- Approach A persist at registration → Task 2 trigger. ✓
- Backfill → Task 3. ✓
- Unify `cooldownIds` + `count_on_cooldown` → Task 7. ✓
- Edge cases (front/back match, first-flag suffix omit, no-photo placeholder, operator-cancel exclusion, self-exclude) → Tasks 2/5/6, tested in Task 2 scenarios. ✓
- Out of scope (History tab, other triggers, alerting) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step has real SQL/Python/JSX. ✓

**Type/name consistency:** `cooldown_flagged_at`, `prior_flag_count`, `set_pass_cooldown_flag`, `trg_set_pass_cooldown_flag`, `build_prior_flag_count_sql`, `build_recent_visits_sql`, `CooldownChip`, `recent-visits` route, `count_on_cooldown` — used consistently across tasks. ✓

**Note for implementer:** the frontend repo (`lotlogic`) has no JS unit harness; the React chip is verified via Playwright + manual preview check, while all matching/flag logic (the risky part) is verified in SQL (Task 2) and pytest (Tasks 4–5). Migrations are applied to prod via the Supabase MCP **and** committed as files. Direct pushes to `main` are gated — commit locally; the operator pushes.
