// Tests for frontend/src/lib/requestErrors.js — the code → sentence map.
//
// The plan's Global Constraints: "Every portal route answers an error as
// `{"detail": "<code>", ...extra}` — `detail` is always the short code
// string". `api.js:errorFromResponse` therefore sets BOTH `err.code` and
// `err.message` to that code, which makes `err.message` a machine identifier
// and not copy. The one thing these tests exist to guarantee is that no
// surface can print one: every §8.3 code has a sentence, and anything
// unrecognised falls back to the caller's own sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { GENERIC_ERROR, REQUEST_ERROR_COPY, requestErrorMessage } from '../src/lib/requestErrors.js';

/** What `api.js` actually builds from a `{"detail": "<code>"}` body. */
function apiError(code, status = 422, extra = null) {
  const err = new Error(code);           // ← message IS the code. That is the bug.
  err.status = status;
  err.code = code;
  err.body = { detail: code, ...(extra || {}) };
  return err;
}

// Every code §8.3 lists for the routes this section calls.
const CODES = [
  'hold_window', 'email_unverified', 'pending_hold_limit', 'attestation_required',
  'note_required', 'active_hold_exists', 'extension_limit', 'not_active',
  'reinstate_window', 'photo_required', 'unsupported_type',
];

test('every §8.3 code has a sentence, and none of them is the code', () => {
  for (const code of CODES) {
    const msg = requestErrorMessage(apiError(code));
    assert.equal(typeof msg, 'string', code);
    assert.ok(msg.length > 12, `${code} → ${JSON.stringify(msg)}`);
    assert.ok(!msg.includes(code), `${code} leaked its own identifier`);
    assert.ok(!/_/.test(msg), `${code} → ${JSON.stringify(msg)} still reads like an identifier`);
    assert.ok(/[A-Z]/.test(msg[0]), `${code} → ${JSON.stringify(msg)} does not start a sentence`);
  }
});

test('the three codes the spec writes out are verbatim', () => {
  assert.equal(
    requestErrorMessage(apiError('pending_hold_limit')),
    'Unconfirmed properties can keep 3 holds at a time. N Style usually confirms the same day.',
  );
  assert.equal(requestErrorMessage(apiError('note_required')), 'Tell N Style why — they act on this.');
  assert.equal(
    requestErrorMessage(apiError('extension_limit', 409)),
    'All 4 extensions used. Place a new hold after this one ends, or ask about parking passes.',
  );
  assert.equal(requestErrorMessage(apiError('unsupported_type', 400)), 'Use a JPEG or PNG');
});

test('an unknown code falls back to the caller’s sentence, never to err.message', () => {
  const err = apiError('some_new_code_from_a_later_release');
  assert.equal(requestErrorMessage(err, 'Could not remove that hold.'), 'Could not remove that hold.');
  assert.equal(requestErrorMessage(err), GENERIC_ERROR);
});

test('a Pydantic 422 (detail is an array) falls back too', () => {
  // `errorFromResponse` leaves `code` undefined and joins the messages into
  // `message` — readable, but field-level and not addressed to this user.
  const err = new Error('value is not a valid integer');
  err.status = 422;
  err.body = { detail: [{ msg: 'value is not a valid integer' }] };
  assert.equal(requestErrorMessage(err, 'Could not send that request. Try again.'),
    'Could not send that request. Try again.');
});

test('a network failure with no body at all still gets a sentence', () => {
  assert.equal(requestErrorMessage(new TypeError('Failed to fetch')), GENERIC_ERROR);
  assert.equal(requestErrorMessage(null), GENERIC_ERROR);
  assert.equal(requestErrorMessage(undefined, 'Could not load this request.'), 'Could not load this request.');
});

test('no sentence in the map is a bare code', () => {
  for (const [code, copy] of Object.entries(REQUEST_ERROR_COPY)) {
    assert.ok(/\s/.test(copy), `${code} → ${JSON.stringify(copy)}`);
    assert.ok(!copy.includes(code), code);
  }
});

// ── The regression guard ─────────────────────────────────────
//
// The map only helps if nothing reaches for `err.message` instead. Six call
// sites did before this round, so the gate is a source scan rather than a
// comment: no file under `src/pages/property/` may read `.message` off a
// caught error at all.

const PROPERTY_DIR = path.join(path.resolve(import.meta.dirname, '..'), 'src/pages/property');

/** Every .jsx/.js under src/pages/property, recursively. */
function propertySources(dir = PROPERTY_DIR, rel = 'src/pages/property') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const here = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...propertySources(abs, here));
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push({ rel: here, src: readFileSync(abs, 'utf8') });
  }
  return out;
}

test('no Requests component reads .message off an error', () => {
  const files = propertySources();
  assert.ok(files.length >= 6, 'the scan found nothing to scan');
  const offenders = [];
  for (const { rel, src } of files) {
    src.split('\n').forEach((line, i) => {
      if (/\berr(or)?\s*\??\.\s*message\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `err.message is the route's error code, not copy — use requestErrorMessage():\n${offenders.join('\n')}`);
});

test('every Requests component that reports a failure imports the map', () => {
  for (const { rel, src } of propertySources()) {
    if (!/addToast\?\.\(|className="req-error"/.test(src)) continue;
    if (!/\bcatch\s*\(/.test(src)) continue;
    assert.match(src, /requestErrorMessage/, `${rel} reports failures without the code → copy map`);
  }
});
