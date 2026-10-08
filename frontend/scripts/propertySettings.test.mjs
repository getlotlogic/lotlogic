// Tests for lib/propertySettings.js and db.updateProperty's unwrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EDITABLE_PROPERTY_KEYS, changedSettings, settingsSaveErrorMessage,
} from '../src/lib/propertySettings.js';

const loaded = { property_type: 'truck_plaza', name: 'Plaza', policy_text: 'No overnight.', policy_phone: '+17045550199' };

test('an unchanged form yields an empty diff', () => {
  assert.deepEqual(changedSettings(loaded, { ...loaded }), {});
});

test('property_type is never in the diff, even when it changed', () => {
  assert.deepEqual(changedSettings(loaded, { ...loaded, property_type: 'apartment' }), {});
  assert.ok(!EDITABLE_PROPERTY_KEYS.includes('property_type'));
});

test('a policy edit yields exactly {policy_text}', () => {
  assert.deepEqual(changedSettings(loaded, { ...loaded, policy_text: 'Tow after 1 hour.' }), { policy_text: 'Tow after 1 hour.' });
});

test('null and empty compare equal; unknown keys are ignored', () => {
  assert.deepEqual(changedSettings({ policy_phone: null }, { policy_phone: '', bogus: 'x' }), {});
});

test('backend codes become readable sentences', () => {
  const e = (code, body) => Object.assign(new Error(code), { code, body });
  for (const c of ['read_only_field', 'unknown_field', 'no_changes', 'invalid_field']) {
    assert.doesNotMatch(settingsSaveErrorMessage(e(c, { field: 'policy_phone' })), /_/);
  }
  assert.match(settingsSaveErrorMessage(e('invalid_field', { field: 'policy_phone' })), /phone/i);
  assert.equal(settingsSaveErrorMessage(new Error('boom')), 'Failed to save settings. Try again.');
});

test('db.updateProperty unwraps {property}', async () => {
  // db.js pulls in browser-only modules, so assert on its source and on the
  // unwrap expression's behavior.
  const src = readFileSync(new URL('../src/lib/db.js', import.meta.url), 'utf8');
  const m = src.match(/async updateProperty\(id, updates\) \{([\s\S]*?)\n  \},/);
  assert.ok(m, 'updateProperty found');
  const body = m[1];
  const requestsApi = { updateApartmentProperty: async () => ({ property: { id: 'p1', name: 'X' } }) };
  const fn = new Function('requestsApi', 'id', 'updates', `return (async () => {${body}})();`);
  assert.deepEqual(await fn(requestsApi, 'p1', {}), { id: 'p1', name: 'X' });
});
