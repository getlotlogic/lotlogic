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

// Directories that never hold marketing copy. Everything else under
// frontend/ is walked recursively — a hard-coded ['blog', 'policy'] list
// silently skipped any new marketing subdirectory, which is the failure mode
// a guard can least afford.
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'src', 'styles', 'scripts', '.git']);
const isBuildDir = (name) => EXCLUDE_DIRS.has(name) || name.startsWith('.test-dist-');

function targetFiles(dir = ROOT, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (isBuildDir(entry.name)) continue;
      files.push(...targetFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith('.html') && !EXCLUDE_FILES.has(rel)) {
      files.push(rel);
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

// Attribute values may be single- OR double-quoted; matching only `"..."`
// let `alt='...'` through unchecked.
const META_DESCRIPTION_RE =
  /<meta\b[^>]*\b(?:name|property)\s*=\s*["'](?:description|og:description|og:title|twitter:description|twitter:title)["'][^>]*>/gi;
const META_CONTENT_RE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

// Attributes that carry user-facing copy even though they're attribute
// values, not text nodes: alt text and aria-labels are read by screen
// readers, placeholders and title tooltips are read by everyone else.
const USER_FACING_ATTR_RE =
  /\b(?:alt|aria-label|placeholder|title)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

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
    const contentMatch = m[0].match(META_CONTENT_RE);
    if (contentMatch) nodes.push(contentMatch[1] ?? contentMatch[2]);
  }

  // alt / aria-label / placeholder / title attribute values: also
  // user-facing despite living inside a tag.
  for (const m of body.matchAll(USER_FACING_ATTR_RE)) {
    nodes.push(m[1] ?? m[2]);
  }

  // Everything else: text strictly between two tags. This naturally covers
  // <title>...</title> and every visible paragraph/heading/list item, and
  // naturally excludes hrefs and other non-user-facing tag internals.
  for (const m of body.matchAll(/>([^<]+)</g)) {
    nodes.push(m[1]);
  }
  return nodes;
}

// An allow-listed phrase exempts THAT PHRASE, not the whole text node it
// happens to sit in. Masking the phrase out and re-testing the remainder is
// what makes that true: previously one allow-listed sentence blessed every
// other banned word in the same paragraph, so a real regression could hide
// behind a legitimate exception a few clauses away.
function maskPhrases(text, phrases) {
  let out = text;
  for (const phrase of phrases) {
    if (!phrase) continue;
    let idx = out.indexOf(phrase);
    while (idx !== -1) {
      out = out.slice(0, idx) + ' '.repeat(phrase.length) + out.slice(idx + phrase.length);
      idx = out.indexOf(phrase, idx + phrase.length);
    }
  }
  return out;
}

function main() {
  const allowlist = loadAllowlist();
  const files = targetFiles();
  const failures = [];
  const used = new Set();

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const html = readFileSync(abs, 'utf8');
    const allowedForFile = allowlist.filter((a) => a.file === rel);
    const phrases = allowedForFile.map((a) => a.phrase);

    for (const rawNode of extractTextNodes(html)) {
      if (!WORDS.test(rawNode)) continue;
      const text = rawNode.trim();
      if (!text) continue;
      for (const a of allowedForFile) {
        if (text.includes(a.phrase)) used.add(`${a.file}\u0000${a.phrase}`);
      }
      // Re-test what is LEFT after every allow-listed phrase is blanked out.
      if (WORDS.test(maskPhrases(text, phrases))) {
        failures.push(`${rel}: "${text.slice(0, 160)}"`);
      }
    }
  }

  // A stale entry is a silent hole: the phrase it was written for is gone,
  // so it exempts nothing today but would quietly bless the text if it ever
  // came back. Fail on it so the allow-list stays an accurate record.
  const stale = allowlist.filter((a) => !used.has(`${a.file}\u0000${a.phrase}`));
  if (stale.length) {
    console.error(
      'Naming guard failed: stale entries in frontend/.naming-allowlist — the ' +
        'phrase is not present in the file it names (moved, reworded, or the ' +
        'file was renamed). Delete the entry, or fix the phrase to match:\n',
    );
    for (const a of stale) console.error(`  ${a.file}: "${a.phrase}"`);
    if (failures.length) console.error('');
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
  }

  if (failures.length || stale.length) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `Naming guard passed: ${files.length} marketing page(s) checked, ` +
      `${allowlist.length} allow-listed phrase(s), 0 stale.`,
  );
}

main();
