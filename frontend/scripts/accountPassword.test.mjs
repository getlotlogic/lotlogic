// AccountPage's self-service "Change password" must use the shared 12-char
// floor from lib/signupValidation.js, not its own literal (Task H7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { passwordError, PASSWORD_MIN } from '../src/lib/signupValidation.js';

const SRC = readFileSync(path.resolve(import.meta.dirname, '../src/pages/AccountPage.jsx'), 'utf8');

test('the shared helper rejects 9 characters and accepts 12', () => {
  assert.equal(PASSWORD_MIN, 12);
  assert.notEqual(passwordError('a'.repeat(9)), null);
  assert.equal(passwordError('a'.repeat(12)), null);
});

test('AccountPage validates through the shared helper', () => {
  assert.match(SRC, /from '\.\.\/lib\/signupValidation\.js'/);
  assert.match(SRC, /passwordError\(next\)/);
});

test('AccountPage carries no 8-character password floor', () => {
  assert.doesNotMatch(SRC, /next\.length\s*<\s*\d+/);
  assert.doesNotMatch(SRC, /at least 8 characters/i);
  assert.doesNotMatch(SRC, /\(8\+ characters\)/);
  assert.match(SRC, /\$\{PASSWORD_MIN\}\+ characters/);
});
