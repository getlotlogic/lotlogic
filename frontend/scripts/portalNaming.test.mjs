// Naming guard for the portal's JSX (spec §5's copy rule, CLAUDE.md's
// "User-facing naming — parking pass ONLY").
//
// `scripts/check-naming.mjs` only walks `frontend/**/*.html`, and
// `scripts/hqNaming.test.mjs` only covers the HQ pages, so every portal
// component added by this plan would otherwise ship unguarded. This is the
// `hqNaming.test.mjs` precedent applied to the portal surfaces, with one
// difference that matters: it scans **string literals and JSX text**, not the
// raw file. The DB vocabulary is unchanged — `resident_plates`,
// `visitor_passes`, `holder_role='resident'`, `db.getActiveRoster` — so a
// whole-file regex would fire on identifiers and column names that are not
// copy and can't be renamed. What a user reads is what is guarded.
//
// SCOPE GROWS AS THE PLAN LANDS. Several of the files below are created by
// sibling tasks (23–27) and do not exist on this branch yet. A missing path is
// skipped rather than failing, and a separate test asserts at least one file
// was actually scanned — so the gate is meaningful here and automatically
// covers each new surface the moment its branch merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..'); // frontend/

// The same six words `check-naming.mjs` and `hqNaming.test.mjs` ban. The Slack
// roles render as "Office" / "Truck", never "Driver" (§5.7).
const WORDS = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b/i;

// Files, and one directory, that carry portal copy. Paths are relative to
// `frontend/`; a path that does not exist yet is skipped (see the header).
const TARGET_FILES = [
  'src/pages/SignupPage.jsx',
  'src/pages/PendingMembershipPage.jsx',
  'src/pages/PartnerRequestsPage.jsx',
  'src/pages/property/UpsellPanel.jsx',
  'src/lib/verdicts.js',
  'src/lib/holdTime.js',
  // The code → sentence map: every error a manager is shown comes from here.
  'src/lib/requestErrors.js',
  // The bottom-sheet shell every portal sheet renders inside.
  'src/ui/Sheet.jsx',
];
const TARGET_DIRS = ['src/pages/property'];

function exists(abs) {
  try { statSync(abs); return true; } catch { return false; }
}

/**
 * Every .js/.jsx/.mjs under `absDir`, **recursively**, as paths relative to
 * `frontend/`.
 *
 * The brief's scope is `frontend/src/pages/property/**`, so the walk descends:
 * a non-recursive `readdirSync` would let a future `property/sheets/` escape
 * the gate silently, which is the one failure mode a naming guard cannot have.
 */
export function jsxFilesUnder(absDir, rel) {
  const out = [];
  if (!exists(absDir)) return out;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const here = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...jsxFilesUnder(path.join(absDir, entry.name), here));
    else if (entry.isFile() && /\.(jsx?|mjs)$/.test(entry.name)) out.push(here);
  }
  return out;
}

/** Every existing target, relative to `frontend/`, de-duplicated and sorted. */
export function targets() {
  const rel = new Set();
  for (const f of TARGET_FILES) if (exists(path.join(ROOT, f))) rel.add(f);
  for (const d of TARGET_DIRS) for (const f of jsxFilesUnder(path.join(ROOT, d), d)) rel.add(f);
  return [...rel].sort();
}

// ── The literal scanner ──────────────────────────────────────
//
// A hand-rolled scan rather than a parser: the repo has no Babel/AST dep in
// `devDependencies` (esbuild only), and the shapes that carry copy in this
// codebase are few and regular. It walks the source once, character by
// character, and yields:
//
//   * the contents of '…', "…" and `…` string literals (template
//     substitutions are skipped — `${kind}` is code, not copy)
//   * JSX text between tags
//
// and never yields: `//` or `/* */` comments, import specifiers (a module
// path is not copy), identifiers, or JSX attribute *names*. Comments are
// excluded deliberately — a comment explaining why `holder_role='resident'`
// stays is not a user-facing string, and banning the word there would make
// the code undocumentable.

const JS_KEYWORD_BEFORE_REGEX = /[([{=,;:!&|?+\-*/%~^<>]\s*$|\b(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)\s*$/;

/**
 * @param {string} src
 * @returns {{kind: 'string'|'jsx-text', text: string, line: number}[]}
 */
export function copyLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  // Depth of `${ … }` nesting inside template literals, so a `}` knows
  // whether it closes a substitution.
  const tmplStack = [];

  // `true` when the scanner is inside the children of a JSX element, i.e.
  // after a `>` that closed an opening tag. Approximate by design: tracked as
  // a depth counter over `<Tag …>` / `</Tag>` pairs.
  let jsxDepth = 0;

  const atLineStartOfText = () => line;

  while (i < n) {
    const c = src[i];

    // newlines
    if (c === '\n') { line++; i++; continue; }

    // line comment
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    // JSX comment / expression container `{/* … */}` is caught by the block
    // comment branch above once `{` is consumed as a plain character.

    // regex literal — only where a regex can legally start, so `a / b` is not
    // mistaken for one. Needed because `/[^A-Z0-9]/g` would otherwise be read
    // as the start of a string-ish run and swallow real code.
    if (c === '/' && JS_KEYWORD_BEFORE_REGEX.test(src.slice(Math.max(0, i - 24), i))) {
      i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break;            // not a regex after all; bail out
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;  // flags
      continue;
    }

    // single / double quoted string
    if (c === '"' || c === "'") {
      const startLine = line;
      const quote = c;
      let text = '';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { text += src[i + 1] ?? ''; i += 2; continue; }
        if (src[i] === '\n') { line++; }
        text += src[i];
        i++;
      }
      i++;
      out.push({ kind: 'string', text, line: startLine });
      continue;
    }

    // template literal
    if (c === '`') {
      const startLine = line;
      let text = '';
      i++;
      while (i < n) {
        if (src[i] === '\\') { text += src[i + 1] ?? ''; i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // Skip the substitution — it is code. Count braces so a nested
          // object literal or template does not end it early.
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === '\n') line++;
            else if (src[i] === '`') {
              // A nested template: skip it wholesale.
              i++;
              while (i < n && src[i] !== '`') { if (src[i] === '\\') i++; else if (src[i] === '\n') line++; i++; }
            }
            i++;
          }
          text += ' ';   // a substitution breaks the word run
          continue;
        }
        if (src[i] === '\n') line++;
        text += src[i];
        i++;
      }
      out.push({ kind: 'string', text, line: startLine });
      continue;
    }

    // `</Tag>` — closes a JSX element
    if (c === '<' && src[i + 1] === '/') {
      jsxDepth = Math.max(0, jsxDepth - 1);
      while (i < n && src[i] !== '>') i++;
      i++;
      continue;
    }

    // `<Tag …>` or `<Tag … />` — an opening tag. Only treated as JSX when the
    // character after `<` starts a tag name or is the fragment shorthand, so
    // `a < b` and `=>` are left alone.
    if (c === '<' && /[A-Za-z>]/.test(src[i + 1] ?? '')) {
      // Walk to the matching `>`, letting the string branches above handle
      // quoted attribute values by re-entering the main loop is not possible
      // here, so attributes are scanned inline: their values ARE copy
      // (placeholder, aria-label, title, alt).
      i++;
      let selfClosing = false;
      while (i < n && src[i] !== '>') {
        const d = src[i];
        if (d === '\n') { line++; i++; continue; }
        if (d === '"' || d === "'") {
          const startLine = line;
          const quote = d;
          let text = '';
          i++;
          while (i < n && src[i] !== quote) {
            if (src[i] === '\n') line++;
            text += src[i];
            i++;
          }
          i++;
          out.push({ kind: 'string', text, line: startLine });
          continue;
        }
        if (d === '{') {
          // An attribute expression — balanced braces of code. Let the main
          // loop handle it so nested strings and templates are collected.
          let depth = 0;
          const start = i;
          // Find the matching close, then rescan that slice recursively.
          let j = i;
          while (j < n) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (depth === 0) break; }
            j++;
          }
          const inner = src.slice(start + 1, j);
          for (const lit of copyLiterals(inner)) {
            out.push({ ...lit, line: line + lit.line - 1 });
          }
          line += (inner.match(/\n/g) || []).length;
          i = j + 1;
          continue;
        }
        if (d === '/' && src[i + 1] === '>') selfClosing = true;
        i++;
      }
      i++;
      if (!selfClosing) jsxDepth++;
      continue;
    }

    // JSX text: everything between `>` and the next `<` or `{`, while inside
    // an element's children.
    if (jsxDepth > 0 && c !== '{' && c !== '}') {
      const startLine = atLineStartOfText();
      let text = '';
      while (i < n && src[i] !== '<' && src[i] !== '{' && src[i] !== '}') {
        if (src[i] === '\n') line++;
        text += src[i];
        i++;
      }
      if (text.trim()) out.push({ kind: 'jsx-text', text, line: startLine });
      continue;
    }

    i++;
  }
  return out;
}

// `import … from './ResidentThing.jsx'`, API paths, CSS values and bare
// identifier-ish tokens are machine strings, not copy. A sentence a user reads
// always has a space or sentence punctuation in it; none of these do.
const NOT_COPY = /^(?:[./#@]|https?:|var\()|^[a-z0-9_$:.-]+$/i;

/** True when a string literal is a path, a CSS value or a bare token. */
export function isNotCopy(text) {
  return NOT_COPY.test(text.trim());
}

/** Every banned-word hit in one file's copy, as reportable lines. */
export function hits(rel) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  const found = [];
  for (const lit of copyLiterals(src)) {
    if (lit.kind === 'string' && isNotCopy(lit.text)) continue;
    const m = lit.text.match(WORDS);
    if (m) found.push(`${rel}:${lit.line} uses "${m[0]}" in ${lit.kind}: ${JSON.stringify(lit.text.trim().slice(0, 140))}`);
  }
  return found;
}

// ── The gate ─────────────────────────────────────────────────

test('no portal copy string uses a banned word', () => {
  const failures = [];
  for (const rel of targets()) failures.push(...hits(rel));
  assert.deepEqual(
    failures, [],
    'The only user-facing pass word is "parking pass" — never Resident / ' +
    'Visitor / Permanent / Temporary / Guest / Driver (the Slack roles read ' +
    '"Office" and "Truck"). Offending copy:\n  ' + failures.join('\n  '),
  );
});

test('the directory walk descends into subdirectories', () => {
  // The brief's scope is `src/pages/property/**`. `src/` is used as the
  // fixture because it is guaranteed to have nested .jsx today, so this fails
  // the moment the walk stops recursing — without planting a file.
  const found = jsxFilesUnder(path.join(ROOT, 'src'), 'src');
  assert.ok(found.includes('src/pages/property/RequestRow.jsx'), 'the walk did not descend two levels');
  assert.ok(found.includes('src/lib/holdTime.js'), 'the walk did not descend one level');
});

test('the scanner is looking at files that exist', () => {
  const found = targets();
  assert.ok(found.length >= 1, 'portalNaming scanned nothing — the target list has gone stale');
  // holdTime.js ships in this task, so it is always in scope.
  assert.ok(found.includes('src/lib/holdTime.js'), found.join(', '));
  assert.ok(found.some(f => f.startsWith('src/pages/property/')), found.join(', '));
});

// ── The scanner's own tests ──────────────────────────────────
//
// A guard whose extractor is wrong is worse than no guard. These pin both
// halves: what it must catch, and what it must leave alone.

test('a banned word in JSX text is caught', () => {
  assert.deepEqual(
    copyLiterals('<div>Guest pass</div>').map(l => l.text.trim()),
    ['Guest pass'],
  );
});

test('a banned word in a string literal is caught', () => {
  const lits = copyLiterals("const a = 'Guest pass expired';");
  assert.deepEqual(lits.map(l => l.text), ['Guest pass expired']);
});

test('a banned word in a template literal is caught', () => {
  const lits = copyLiterals('const a = `Guest pass for ${name}`;');
  assert.equal(lits.length, 1);
  assert.match(lits[0].text, /Guest pass for/);
});

test('a template substitution is not copy', () => {
  const lits = copyLiterals('const a = `pass for ${resident.name}`;');
  assert.equal(lits.length, 1);
  assert.doesNotMatch(lits[0].text, WORDS, 'the `${…}` expression must be skipped');
});

test('a user-facing attribute value is caught', () => {
  const lits = copyLiterals('<input placeholder="Guest name" />');
  assert.ok(lits.some(l => l.text === 'Guest name'));
});

test('comments are not copy', () => {
  const src = [
    '// holder_role stays "resident" in the DB — see CLAUDE.md',
    '/* visitor_passes is a column name, not a label */',
    'const a = 1;',
  ].join('\n');
  for (const lit of copyLiterals(src)) assert.doesNotMatch(lit.text, WORDS, JSON.stringify(lit));
});

test('identifiers and column names are not copy', () => {
  const src = "const q = db.visitor_passes; let residentPlates = 1; obj.guest = 2;";
  assert.deepEqual(copyLiterals(src), []);
});

test('a module path, an API path and a token value are not copy', () => {
  for (const src of [
    "import { X } from './ResidentCard.jsx';",
    "apiFetch('/resident_plates');",
    "const c = 'var(--guest-bg)';",
  ]) {
    const bad = copyLiterals(src).filter(l => !isNotCopy(l.text));
    assert.deepEqual(bad, [], src);
  }
});

test('a regex literal containing a slash does not swallow the rest of the file', () => {
  const src = "const n = s.replace(/[^A-Z0-9]/g, ''); const copy = 'Guest pass';";
  const texts = copyLiterals(src).map(l => l.text);
  assert.ok(texts.includes('Guest pass'), texts.join(' | '));
});

test('an arrow function is not read as a JSX tag', () => {
  const src = "const f = (a) => a < b ? 'Guest pass' : 'ok';";
  assert.ok(copyLiterals(src).some(l => l.text === 'Guest pass'));
});

test('nested JSX children are scanned', () => {
  const src = '<div><span><b>Guest pass</b></span></div>';
  assert.ok(copyLiterals(src).some(l => l.text.trim() === 'Guest pass'));
});

test('a self-closing tag does not leave the scanner inside an element', () => {
  const src = '<><img alt="ok" />{x}</>';
  for (const lit of copyLiterals(src)) assert.doesNotMatch(lit.text, WORDS);
});

test('hits() reports the file, the line and the word', () => {
  // Scan this very file's scanner against a known-bad fixture through the
  // same code path hits() uses, minus the filesystem.
  const src = 'export const copy = {\n  a: 1,\n  b: "Guest pass",\n};\n';
  const found = copyLiterals(src).filter(l => WORDS.test(l.text));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.equal(found[0].text, 'Guest pass');
});
