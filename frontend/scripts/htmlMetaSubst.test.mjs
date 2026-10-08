// Unit tests for the `{{PLACEHOLDER}}` substitution build.mjs uses to put
// VITE_GOOGLE_MAPS_KEY into dashboard.html's <meta name="google-maps-key">.
import test from 'node:test';
import assert from 'node:assert/strict';

import { injectMetaContent } from './htmlMetaSubst.mjs';

test('substitutes the placeholder with the given value', () => {
  const html = '<meta name="google-maps-key" content="{{GOOGLE_MAPS_KEY}}">';
  assert.equal(
    injectMetaContent(html, 'GOOGLE_MAPS_KEY', 'AIzaFAKE123'),
    '<meta name="google-maps-key" content="AIzaFAKE123">'
  );
});

test('substitutes with an empty string when value is unset', () => {
  const html = '<meta name="google-maps-key" content="{{GOOGLE_MAPS_KEY}}">';
  assert.equal(
    injectMetaContent(html, 'GOOGLE_MAPS_KEY', undefined),
    '<meta name="google-maps-key" content="">'
  );
  assert.equal(
    injectMetaContent(html, 'GOOGLE_MAPS_KEY', ''),
    '<meta name="google-maps-key" content="">'
  );
});

test('leaves html with no placeholder untouched', () => {
  const html = '<title>Dashboard</title>';
  assert.equal(injectMetaContent(html, 'GOOGLE_MAPS_KEY', 'x'), html);
});

test('replaces every occurrence of the placeholder', () => {
  const html = '{{X}}-{{X}}';
  assert.equal(injectMetaContent(html, 'X', 'y'), 'y-y');
});

test('never substitutes a different placeholder name', () => {
  const html = '{{GOOGLE_MAPS_KEY}} {{RECAPTCHA_SITE_KEY}}';
  assert.equal(injectMetaContent(html, 'GOOGLE_MAPS_KEY', 'k'), 'k {{RECAPTCHA_SITE_KEY}}');
});
