// Naming-rule guard for the marketing site (Wave 2.6 Task 19).
//
// The product's user-facing naming rule is: the only user-facing term is
// "parking pass". Never Resident / Visitor / Permanent / Temporary / Guest /
// Driver in copy a prospect or user reads. That rule already holds inside
// the product (dashboard, registration forms); this script stops the
// marketing pages from drifting back into the old vocabulary.
//
// It checks user-facing copy — not tag names, hrefs/URLs, or script/style
// contents — because DB names, file names, and URLs (`resident.html`,
// `/temp/<qr>`, `qr_code_id`) are explicitly allowed to keep the banned
// words. That includes: text nodes, <title> and meta description/OG/
// Twitter tags, AND alt=/aria-label=/placeholder=/title= attribute values
// — all of those are things a prospect or screen reader actually reads,
// even though some live inside an attribute.
//
// Scope (Ruling T19b): the rule only governs what LotLogic calls its
// passes (UI labels, pass categories, product copy naming a pass type) —
// not plain-English or industry nouns for people or occupations. A small
// allow-list (`frontend/.naming-allowlist`) carries those exceptions: not
// just legal terms of art in privacy.html/policy pages, but also
// plain-English nouns (a tow truck driver, a census figure) and quoted
// speech, so the guard can stay a hard failure with zero manual overrides
// in CI.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..'); // frontend/
const WORDS = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b/i;

// Product surfaces are out of scope here — they're not marketing copy, and
// the dashboard/registration forms carry their own (already-clean) naming
// rule per CLAUDE.md. Listed explicitly so a new marketing page ships
// covered by default (deny-list, not allow-list).
const EXCLUDE_FILES = new Set([
  'visit.html',        // registration form (Task 17 surface)
  'resident.html',     // registration form (Task 17 surface)
  'apt.html',           // registration form (Task 17 surface)
  'admin.html',         // internal admin console
  'dashboard.html',     // ~10k-line product SPA, own naming rule already
  'lookup.html',        // internal pass-lookup tool
  'set-password.html',  // internal account tool
  'tuner.html',         // internal camera-tuning tool
]);

const MARKETING_DIRS = ['blog', 'policy'];

function targetFiles() {
  const files = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html') && !EXCLUDE_FILES.has(entry.name)) {
      files.push(entry.name);
    }
  }
  for (const dir of MARKETING_DIRS) {
    const dirPath = path.join(ROOT, dir);
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.html')) {
        files.push(path.posix.join(dir, entry.name));
      }
    }
  }
  return files.sort();
}

// Allow-list format: one entry per line, `<file relative to frontend/>: <exact
// phrase or substring>  # reason`. Blank lines and lines starting with `#`
// are ignored.
function loadAllowlist() {
  const p = path.join(ROOT, '.naming-allowlist');
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const hashIdx = trimmed.indexOf('#');
    const body = (hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)).trim();
    const colonIdx = body.indexOf(':');
    if (colonIdx === -1) continue;
    entries.push({
      file: body.slice(0, colonIdx).trim(),
      phrase: body.slice(colonIdx + 1).trim(),
    });
  }
  return entries;
}

const META_DESCRIPTION_RE =
  /<meta\b[^>]*\b(?:name|property)\s*=\s*"(?:description|og:description|og:title|twitter:description|twitter:title)"[^>]*>/gi;

// Attributes that carry user-facing copy even though they're attribute
// values, not text nodes: alt text and aria-labels are read by screen
// readers, placeholders and title tooltips are read by everyone else.
const USER_FACING_ATTR_RE = /\b(?:alt|aria-label|placeholder|title)\s*=\s*"([^"]*)"/gi;

function extractTextNodes(html) {
  // Drop script/style contents entirely — code and CSS class names aren't
  // user-facing copy.
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  const nodes = [];

  // Meta description / OG / Twitter tags: user-facing (a prospect reads
  // these in search results and link previews) even though they live in an
  // attribute value, so they get pulled out explicitly.
  for (const m of body.matchAll(META_DESCRIPTION_RE)) {
    const contentMatch = m[0].match(/\bcontent\s*=\s*"([^"]*)"/i);
    if (contentMatch) nodes.push(contentMatch[1]);
  }

  // alt / aria-label / placeholder / title attribute values: also
  // user-facing despite living inside a tag.
  for (const m of body.matchAll(USER_FACING_ATTR_RE)) {
    nodes.push(m[1]);
  }

  // Everything else: text strictly between two tags. This naturally covers
  // <title>...</title> and every visible paragraph/heading/list item, and
  // naturally excludes hrefs and other non-user-facing tag internals.
  for (const m of body.matchAll(/>([^<]+)</g)) {
    nodes.push(m[1]);
  }
  return nodes;
}

function main() {
  const allowlist = loadAllowlist();
  const files = targetFiles();
  const failures = [];

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const html = readFileSync(abs, 'utf8');
    const allowedForFile = allowlist.filter((a) => a.file === rel);

    for (const rawNode of extractTextNodes(html)) {
      if (!WORDS.test(rawNode)) continue;
      const text = rawNode.trim();
      if (!text) continue;
      const isAllowed = allowedForFile.some((a) => text.includes(a.phrase));
      if (!isAllowed) failures.push(`${rel}: "${text.slice(0, 160)}"`);
    }
  }

  if (failures.length) {
    console.error(
      'Naming guard failed: the marketing site must say "parking pass," never ' +
        'Resident / Visitor / Permanent / Temporary / Guest / Driver.\n',
    );
    for (const f of failures) console.error('  ' + f);
    console.error(
      '\nThe rule only governs what LotLogic calls its passes (CLAUDE.md\'s ' +
        '"User-facing naming — parking pass ONLY" rule) — it does not reach ' +
        'plain-English nouns for people or occupations. If this sentence is ' +
        'naming a pass type, rewrite it to say "parking pass" naturally. If ' +
        'it\'s a plain-English noun (a tow truck driver, a census figure, ' +
        'quoted speech) or a genuine legal term of art, add it to ' +
        'frontend/.naming-allowlist with a reason.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Naming guard passed: ${files.length} marketing page(s) checked, ` +
      `${allowlist.length} allow-listed phrase(s).`,
  );
}

main();
