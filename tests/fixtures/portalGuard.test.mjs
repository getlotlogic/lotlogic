// node --test (Node 22+ strips the types): `npm run test:unit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackUrl } from './portalGuard.ts';

test('loopback API and harness DB URLs are allowed', () => {
  for (const u of [
    'http://localhost:8010',
    'http://127.0.0.1:8010/',
    'http://[::1]:8010',
    'postgresql://postgres:postgres@localhost:5432/postgres_portal',
    'postgresql://gabe@127.0.0.1:51151/lotlogic_portal',
    'postgres:///lotlogic_portal',
    'postgresql:///db?host=/var/folders/x/lotlogic-pgtest-abc',
  ]) assert.equal(isLoopbackUrl(u), true, u);
});

test('anything that can reach another machine is refused', () => {
  for (const u of [
    '',
    undefined,
    'not a url',
    'https://lotlogic-backend-production.up.railway.app',
    'postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres',
    'postgresql://postgres:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
    'postgresql://localhost/db?host=db.example.com',
    'postgresql://localhost,db.example.com/db',
    'postgresql://localhost.example.com/db',
    'http://127.0.0.1.nip.io:8010',
    'file:///etc/passwd',
  ]) assert.equal(isLoopbackUrl(u), false, String(u));
});
