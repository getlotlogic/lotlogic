// Unit tests for resolvePolicySrc() in src/shared/register.js — the posted
// policy image src used by visit.js's truck-plaza form (Wave 2.3, Task 12).
// Prefers properties.policy_image_url; falls back to the legacy committed
// /policy/<qr>.jpg for sites that predate the stored-URL rollout.
// register.js reads `document.querySelector(...)` at MODULE SCOPE (the
// RECAPTCHA_SITE_KEY constant) -- same reason resolveCameraSnapshot.test.mjs
// dynamically imports db.js after stubbing globals: a static top-level
// `import` is hoisted and evaluated before any of THIS file's own top-level
// code runs, so the stub has to be set and the import made dynamic, in that
// order. resolvePolicySrc itself touches no DOM API; the stub exists only so
// the module doesn't throw while loading under plain `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { querySelector: () => null };
const { resolvePolicySrc } = await import('../src/shared/register.js');

test('resolvePolicySrc prefers property.policy_image_url when present', () => {
  const property = { policy_image_url: 'https://cdn.example/policy/abc12345.jpg' };
  assert.equal(resolvePolicySrc(property, 'some-qr-id'), 'https://cdn.example/policy/abc12345.jpg');
});

test('resolvePolicySrc falls back to /policy/<qr>.jpg when the row has no image', () => {
  const property = { policy_image_url: null };
  assert.equal(resolvePolicySrc(property, 'charlotte-travel-plaza'), '/policy/charlotte-travel-plaza.jpg');
});

test('resolvePolicySrc falls back when policy_image_url is an empty string', () => {
  const property = { policy_image_url: '' };
  assert.equal(resolvePolicySrc(property, 'some-qr-id'), '/policy/some-qr-id.jpg');
});

test('resolvePolicySrc falls back when the property has no such field at all', () => {
  const property = { name: 'A Lot With No Policy Column Selected' };
  assert.equal(resolvePolicySrc(property, 'some-qr-id'), '/policy/some-qr-id.jpg');
});
