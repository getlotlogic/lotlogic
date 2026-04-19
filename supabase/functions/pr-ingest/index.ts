import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  return new Response(
    JSON.stringify({ ok: false, error: "not implemented" }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
});
