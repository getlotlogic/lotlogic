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

// --- G5: the save must merge the PATCH response, never replace state -------
import { mergeSavedProperty, buildSettingsPatch } from '../src/lib/propertySettings.js';

const pageState = {
  id: 'p1', property_type: 'truck_plaza', qr_code_id: 'qr-real-1', pay_to_park_enabled: true,
  role: 'owner', partner_name: 'Acme', tow_company_name: 'Tow Co',
  name: 'Plaza', policy_text: 'No overnight.', policy_phone: '+17045550199',
};
// property_json shape: no property_type / qr_code_id / role / partner_name ...
const patchResponse = { id: 'p1', name: 'Plaza', policy_text: 'Tow after 1 hour.', policy_phone: '+17045550199' };

test('mergeSavedProperty keeps fields the PATCH response lacks', () => {
  const next = mergeSavedProperty(pageState, patchResponse);
  assert.equal(next.policy_text, 'Tow after 1 hour.');
  for (const k of ['property_type', 'qr_code_id', 'role', 'pay_to_park_enabled', 'partner_name', 'tow_company_name']) {
    assert.equal(next[k], pageState[k], k);
  }
  assert.equal(`/temp/${next.qr_code_id}`, '/temp/qr-real-1');
  assert.notEqual(next, pageState);
});

test('mergeSavedProperty tolerates a missing response or previous state', () => {
  assert.deepEqual(mergeSavedProperty(pageState, null), pageState);
  assert.deepEqual(mergeSavedProperty(null, patchResponse), patchResponse);
});

test('buildSettingsPatch never carries property_type', () => {
  const patch = buildSettingsPatch(pageState, { ...pageState, property_type: 'apartment', policy_text: 'X' });
  assert.deepEqual(patch, { policy_text: 'X' });
});

test('handleSaveSettings uses the helpers and a functional merge', () => {
  const src = readFileSync(new URL('../src/pages/ALPRPropertyDetailPage.jsx', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function handleSaveSettings'), src.indexOf('async function handleRemovePlate'));
  assert.match(body, /buildSettingsPatch\(/);
  assert.match(body, /setProperty\(\s*prev\s*=>\s*mergeSavedProperty\(prev,\s*updated\)\s*\)/);
  assert.doesNotMatch(body, /setProperty\(updated\)/);
});

test('RequestActionPage has a no-token view distinct from the expired one', () => {
  const src = readFileSync(new URL('../src/pages/RequestActionPage.jsx', import.meta.url), 'utf8');
  assert.match(src, /Open the link from your email again\./);
  assert.match(src, /kind: 'no_token'/);
});
