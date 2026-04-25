import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// On-demand SIMbase usage pull. Returns current-month per-SIM costs + data
// usage so the operator can see live cellular spend without leaving the
// dashboard. No persistence — just a wrapper around SIMbase's /v2/usage
// endpoint with formatted output.
//
// Auth: relies on Supabase's default JWT requirement (Authorization: Bearer
// <anon_key>). Treat as internal-only.

const SIMBASE_API_KEY = Deno.env.get("SIMBASE_API_KEY") ?? "";
const SIMBASE_BASE = "https://api.simbase.com";

type RawSim = {
  iccid: string;
  costs: {
    total: string;
    data: string;
    sms: string;
    sms_mo: string;
    sms_mt: string;
    voice: string;
    other: string;
    line_rental: string;
  };
  usage: {
    total_sessions: number;
    data_sessions: number;
    zero_sessions: number;
    data: number; // bytes
    sms_mo: number;
    sms_mt: number;
    voice: number;
    line_rental: number;
  };
};

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
  if (!SIMBASE_API_KEY) return json(500, { ok: false, error: "SIMBASE_API_KEY missing" });

  const sims: RawSim[] = [];
  let cursor: string | null = null;
  let month = "";
  let pages = 0;

  // Page through results — SIMbase paginates if you have many SIMs.
  // For 4 SIMs we'll get a single page, but build the loop properly anyway.
  while (true) {
    const url = new URL("/v2/usage/simcards", SIMBASE_BASE);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${SIMBASE_API_KEY}` },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return json(502, { ok: false, error: "simbase_upstream_error", status: res.status, body: bodyText.slice(0, 500) });
    }
    const data = await res.json() as { simcards: RawSim[]; cursor: string | null; month: string; has_more: boolean };
    sims.push(...data.simcards);
    month = data.month;
    pages++;
    if (!data.has_more || pages > 20) break;
    cursor = data.cursor;
    if (!cursor) break;
  }

  // Format output. Sort by data usage descending so the heaviest SIM is first.
  const formatted = sims
    .map((s) => ({
      iccid_last4: s.iccid.slice(-4),
      iccid: s.iccid,
      cost_total_usd: parseFloat(s.costs.total),
      cost_data_usd: parseFloat(s.costs.data),
      cost_line_rental_usd: parseFloat(s.costs.line_rental),
      data_bytes: s.usage.data,
      data_pretty: formatBytes(s.usage.data),
      sessions: s.usage.total_sessions,
    }))
    .sort((a, b) => b.data_bytes - a.data_bytes);

  const totals = sims.reduce(
    (acc, s) => ({
      cost_usd: acc.cost_usd + parseFloat(s.costs.total),
      data_bytes: acc.data_bytes + s.usage.data,
      sessions: acc.sessions + s.usage.total_sessions,
    }),
    { cost_usd: 0, data_bytes: 0, sessions: 0 },
  );

  return json(200, {
    ok: true,
    month,
    sim_count: sims.length,
    totals: {
      cost_usd: totals.cost_usd.toFixed(2),
      data_pretty: formatBytes(totals.data_bytes),
      data_bytes: totals.data_bytes,
      sessions: totals.sessions,
      cost_per_gb_usd: totals.data_bytes > 0
        ? (totals.cost_usd / (totals.data_bytes / 1_000_000_000)).toFixed(2)
        : null,
    },
    sims: formatted,
  });
});
