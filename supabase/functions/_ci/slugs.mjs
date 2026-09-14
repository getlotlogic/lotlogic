// The edge-function deploy matrix, computed from the import graph.
//
// Why this exists: camera-snapshot imports ../pr-ingest/r2.ts, and
// cron-no-reg-sweep imports ../camera-snapshot/no_reg_violations.ts. A
// hand-maintained `paths:` list has to encode those edges and has no way to
// notice when a new one appears — which is how cron-no-reg-sweep ended up with
// no deploy workflow at all while depending on a file that has one.
//
// No dependencies: this runs on the runner's stock Node.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FUNCTIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(FUNCTIONS_DIR, "../..");

/** Files that force a full redeploy of every slug when they change. */
const GLOBAL_PATHS = [
  "supabase/config.toml",
  ".github/workflows/edge-functions.yml",
];

const rel = (abs) => relative(REPO_ROOT, abs).split(/[\\/]/).join(posix.sep);

export function slugs() {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter((n) => existsSync(join(FUNCTIONS_DIR, n, "index.ts")))
    .sort();
}

// Matches `import … from "x"`, `export … from "x"`, and bare `import "x"`.
const FROM_RE = /(?:^|[\s;])(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const BARE_RE = /(?:^|[\s;])import\s*["']([^"']+)["']/g;

function resolveLocal(fromFile, spec) {
  // Only relative specifiers are ours. Everything else is a remote URL
  // (https://deno.land/…, https://esm.sh/…) or a deno.json alias that maps to
  // one; assertGuards() below makes the alias case an error rather than a
  // silent miss.
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new Error(`unresolved local import ${spec} from ${rel(fromFile)}`);
}

function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith(".ts")) continue;          // .json leaves have no imports
    const src = readFileSync(file, "utf8");
    for (const re of [FROM_RE, BARE_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const next = resolveLocal(file, m[1]);
        if (next) stack.push(next);
      }
    }
  }
  return seen;
}

export function filesFor(slug) {
  const dir = join(FUNCTIONS_DIR, slug);
  const out = new Set([...closure(join(dir, "index.ts"))].map(rel));
  // Non-TS siblings the runtime or the gate reads (deno.json import map,
  // deno.lock, auto-fuzzy-config.json). They are inputs to the deploy even
  // though no import statement in a .ts file has to mention them — a changed
  // deno.lock IS a changed dependency and must redeploy the slug.
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isFile() && !d.name.endsWith(".ts")) out.add(rel(join(dir, d.name)));
  }
  return [...out].sort();
}

/**
 * Guard against three ways this walker could silently under-report.
 * Throws — a deploy matrix that quietly misses a slug is worse than a red build.
 */
export function assertGuards() {
  // 1. A deno.json alias pointing at a local path would be an import edge the
  //    regex cannot see.
  for (const slug of slugs()) {
    const cfg = join(FUNCTIONS_DIR, slug, "deno.json");
    if (!existsSync(cfg)) continue;
    const imports = JSON.parse(readFileSync(cfg, "utf8")).imports ?? {};
    for (const [alias, target] of Object.entries(imports)) {
      if (target.startsWith(".") || target.startsWith("/")) {
        throw new Error(
          `${slug}/deno.json maps "${alias}" to a local path (${target}). ` +
          `The deploy matrix resolves imports textually and cannot follow it. ` +
          `Import the file by relative path instead.`,
        );
      }
    }
  }
  // 2. Every slug must carry a committed deno.lock, or `deno check --frozen`
  //    in the workflow silently degrades to an unpinned resolve and the gate
  //    stops being deterministic (Task 1, decision D2).
  for (const slug of slugs()) {
    if (!existsSync(join(FUNCTIONS_DIR, slug, "deno.lock"))) {
      throw new Error(
        `${slug} has no deno.lock. Run: (cd supabase/functions/${slug} && ` +
        `deno cache --lock=deno.lock --frozen=false index.ts) and commit it.`,
      );
    }
  }
  // 3. A deno.json above a slug would change how `deno check` resolves inside
  //    it, so the CI gate and a developer's local run would disagree.
  for (const p of ["supabase/functions/deno.json", "deno.json", "deno.jsonc"]) {
    if (existsSync(join(REPO_ROOT, p))) {
      throw new Error(
        `${p} exists. Deno resolves config by walking up from the CWD, so this ` +
        `would silently override a slug's own deno.json. Remove it or teach ` +
        `_ci/slugs.mjs about it.`,
      );
    }
  }
}

/**
 * The `only` input of a manual workflow_dispatch: a comma-separated slug list,
 * or the literal `all`.
 *
 * Deliberately strict in both directions. A blank input is an error, not a
 * silent no-op and not an implicit deploy-everything: the staged first run
 * names its batches explicitly, and a stray dispatch that quietly deployed all
 * 16 functions (or quietly deployed none and went green) is the failure mode
 * this whole task exists to remove. A typo'd slug is an error too — otherwise
 * `supabase functions deploy` happily creates a brand-new empty function.
 */
export function slugsForOnly(spec) {
  const wanted = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) {
    throw new Error(
      "workflow_dispatch needs `only`: a comma-separated slug list, or `all`.",
    );
  }
  const known = slugs();
  if (wanted.length === 1 && wanted[0] === "all") return known;
  const unknown = wanted.filter((s) => !known.includes(s));
  if (unknown.length) {
    throw new Error(
      `unknown slug(s): ${unknown.join(", ")}. Known: ${known.join(", ")}`,
    );
  }
  return known.filter((s) => wanted.includes(s));
}

export function slugsForChanged(changed) {
  const paths = changed.map((p) => p.trim()).filter(Boolean);
  if (paths.some((p) => GLOBAL_PATHS.includes(p))) return slugs();
  const touched = new Set(paths);
  return slugs().filter((s) => filesFor(s).some((f) => touched.has(f)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertGuards();
  const cmd = process.argv[2];
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(slugs()));
  } else if (cmd === "changed") {
    const stdin = readFileSync(0, "utf8").split("\n");
    process.stdout.write(JSON.stringify(slugsForChanged(stdin)));
  } else if (cmd === "only") {
    process.stdout.write(JSON.stringify(slugsForOnly(process.argv[3])));
  } else {
    console.error(
      "usage: slugs.mjs list | slugs.mjs changed < file-list | slugs.mjs only <spec>",
    );
    process.exit(2);
  }
}
