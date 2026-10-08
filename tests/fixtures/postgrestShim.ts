/**
 * A tiny PostgREST stand-in for the portal suite's local runs (Task 30).
 *
 * The dashboard still reads a few things straight from Supabase's PostgREST
 * (`db.getProperty` → `GET /rest/v1/properties?select=*&id=eq.<id>`, the
 * legacy pass / camera tables). Locally there is no PostgREST — only the
 * harness Postgres from `python -m tests.portal.cluster` — and the bundle's
 * Supabase URL is the production project, which must never see a locally
 * signed token. So the browser's `*.supabase.co/rest/v1/*` calls are routed
 * here instead and answered from the harness DB **the way PostgREST would**:
 *
 *   - the request's Bearer JWT payload becomes `request.jwt.claims` and the
 *     statement runs as its `role` claim (`authenticated`), so the database's
 *     own GRANTs and RLS policies decide what comes back or what is refused —
 *     nothing here filters by tenant;
 *   - no token → role `anon`, as PostgREST does with the anon key.
 *
 * The JWT signature is NOT checked: the only tokens a test browser holds are
 * the ones the local backend minted. Only the request shapes the dashboard
 * actually sends are understood — `select=*` or a plain column list, filters
 * `eq` / `neq` / `is.null` / `not.is.null` / `in.(…)`, `order`, `limit`, and a
 * single-object `Accept`; anything else (embedded selects, `ilike`, RPC)
 * answers `[]`, which is what every caller already treats as "nothing here".
 * Writes: `POST` inserts the JSON body's keys only (column defaults apply),
 * which is enough for access-control's "a session JWT cannot insert a
 * verified property" proof. A Postgres error comes back as PostgREST shapes
 * it — `{code, message}` with 401 for `42501` under `anon`, 403 otherwise.
 */
import { execFile } from 'node:child_process';
import type { BrowserContext, Page, Route } from '@playwright/test';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const MARK = 'PGRST-SHIM:';

function decodeClaims(auth: string | undefined): Record<string, unknown> | null {
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function q(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** PostgREST query string → `WHERE …` / `ORDER BY …` / `LIMIT …`, or null
 *  when the request uses something this shim does not translate. */
export function translateQuery(params: URLSearchParams): { select: string; where: string; order: string; limit: string } | null {
  let select = '*';
  const where: string[] = [];
  let order = '';
  let limit = '';
  for (const [key, value] of params) {
    if (key === 'select') {
      if (value === '*') continue;
      const cols = value.split(',');
      if (!cols.every((c) => IDENT.test(c))) return null;
      select = cols.join(', ');
    } else if (key === 'order') {
      const parts = value.split(',').map((p) => p.split('.'));
      if (!parts.every(([c, dir]) => IDENT.test(c) && (!dir || dir === 'asc' || dir === 'desc'))) return null;
      order = ' ORDER BY ' + parts.map(([c, dir]) => `${c} ${dir ?? 'asc'}`).join(', ');
    } else if (key === 'limit') {
      if (!/^\d+$/.test(value)) return null;
      limit = ` LIMIT ${value}`;
    } else if (key === 'offset' || key === 'columns') {
      return null;
    } else {
      if (!IDENT.test(key)) return null;
      if (value === 'is.null') where.push(`${key} IS NULL`);
      else if (value === 'not.is.null') where.push(`${key} IS NOT NULL`);
      else if (value.startsWith('eq.')) where.push(`${key}::text = ${q(value.slice(3))}`);
      else if (value.startsWith('neq.')) where.push(`${key}::text <> ${q(value.slice(4))}`);
      else if (/^in\.\(.*\)$/.test(value)) {
        const items = value.slice(4, -1).split(',').filter(Boolean);
        where.push(items.length ? `${key}::text IN (${items.map(q).join(', ')})` : 'false');
      } else return null;
    }
  }
  return { select, where: where.length ? ' WHERE ' + where.join(' AND ') : '', order, limit };
}

function runAs(pgUrl: string, claims: Record<string, unknown> | null, statement: string, vars: Record<string, string> = {}) {
  const role = claims && typeof claims.role === 'string' && IDENT.test(claims.role) ? claims.role : 'anon';
  const script = [
    'BEGIN;',
    `SELECT set_config('request.jwt.claims', :'claims', true);`,
    `SET LOCAL ROLE ${role};`,
    statement,
    'COMMIT;',
  ].join('\n');
  const args = [pgUrl, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', `claims=${JSON.stringify(claims ?? {})}`];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return new Promise<{ ok: boolean; out: string; err: string; role: string }>((resolve) => {
    const child = execFile('psql', [...args, '-f', '-'], { encoding: 'utf8' }, (error, stdout, stderr) => {
      // set_config echoes the claims back; the statement's answer is the one
      // line carrying the marker.
      const line = (stdout ?? '').split('\n').find((l) => l.startsWith(MARK)) ?? '';
      resolve({ ok: !error, out: line.slice(MARK.length), err: stderr ?? '', role });
    });
    child.stdin?.end(script);
  });
}

function pgError(err: string): { code: string; message: string } {
  const message = (/ERROR:\s+(.*)/.exec(err)?.[1] ?? err).trim();
  const code = /permission denied|row-level security/i.test(message) ? '42501'
    : /violates not-null/i.test(message) ? '23502'
    : /duplicate key/i.test(message) ? '23505'
    : 'XX000';
  return { code, message };
}

export async function handlePostgrest(route: Route, pgUrl: string) {
  const req = route.request();
  const url = new URL(req.url());
  const m = /^\/rest\/v1\/([a-z_][a-z0-9_]*)$/.exec(url.pathname);
  const json = (status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  if (req.method() === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      },
    });
  }
  if (!m) return json(200, []);
  const table = m[1];
  const claims = decodeClaims(req.headers()['authorization']);
  const single = /vnd\.pgrst\.object/.test(req.headers()['accept'] ?? '');

  if (req.method() === 'GET' || req.method() === 'HEAD') {
    const t = translateQuery(url.searchParams);
    if (!t) return json(200, single ? null : []);
    const stmt = `SELECT '${MARK}' || coalesce(jsonb_agg(r), '[]'::jsonb)::text FROM (SELECT ${t.select} FROM public.${table}${t.where}${t.order}${t.limit}) r;`;
    const res = await runAs(pgUrl, claims, stmt);
    if (!res.ok) {
      const e = pgError(res.err);
      // An unknown table/column is "nothing here" to every caller.
      if (e.code === 'XX000') return json(200, single ? null : []);
      return json(res.role === 'anon' ? 401 : 403, e);
    }
    const rows = JSON.parse(res.out || '[]');
    if (single) {
      if (rows.length !== 1) return json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
      return json(200, rows[0]);
    }
    return json(200, rows);
  }

  if (req.method() === 'POST') {
    let body: unknown;
    try { body = JSON.parse(req.postData() ?? 'null'); } catch { return json(400, { code: 'PGRST102', message: 'bad json' }); }
    const rows = Array.isArray(body) ? body : [body];
    const cols = Object.keys((rows[0] ?? {}) as object);
    if (!cols.length || !cols.every((c) => IDENT.test(c))) return json(400, { code: 'PGRST204', message: 'bad columns' });
    const stmt = `INSERT INTO public.${table} (${cols.join(', ')})
      SELECT ${cols.join(', ')} FROM json_populate_recordset(NULL::public.${table}, :'body'::json)
      RETURNING '${MARK}1';`;
    const res = await runAs(pgUrl, claims, stmt, { body: JSON.stringify(rows) });
    if (!res.ok) {
      const e = pgError(res.err);
      return json(e.code === '42501' && res.role === 'anon' ? 401 : e.code === '42501' ? 403 : 400, e);
    }
    return route.fulfill({ status: 201, headers: { 'access-control-allow-origin': '*' }, body: '' });
  }

  // PATCH / DELETE: not used by any portal path under test.
  return json(405, { code: 'PGRST105', message: `${req.method()} not supported by the e2e shim` });
}

/** Route every `*.supabase.co/rest/v1/*` call of a page or context to the
 *  harness DB; everything else on `*.supabase.co` (realtime, auth) aborts. */
export async function routeSupabaseToHarness(target: BrowserContext | Page, pgUrl: string) {
  await target.route(/^https:\/\/[a-z0-9]+\.supabase\.co\//, (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/rest/v1/')) return handlePostgrest(route, pgUrl);
    return route.abort();
  });
}
