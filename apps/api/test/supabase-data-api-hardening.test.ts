import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (relative: string) => readFile(new URL(`../../../${relative}`, import.meta.url), 'utf8');

test('browser Supabase usage is auth-only and never queries Prisma application tables directly', async () => {
  const auth = await read('apps/web/auth.js');
  assert.match(auth, /\.auth\.(?:getSession|signInWithOAuth|signInWithPassword|signUp)/);
  assert.doesNotMatch(auth, /\.from\s*\(/, 'browser code must not bypass the Fastify authorization layer with Supabase Data API table access');
  assert.doesNotMatch(auth, /\/rest\/v1\//, 'browser code must not call PostgREST application tables directly');
  assert.doesNotMatch(auth, /\/graphql\/v1/, 'browser code must not call Supabase GraphQL application tables directly');
});

test('rejected Supabase sessions are cleared locally instead of retried forever', async () => {
  const auth = await read('apps/web/auth.js');
  assert.match(auth, /error\\.code=data\\.error/);
  assert.match(auth, /error\\?\\.code===['"]invalid_supabase_session['"]/);
  assert.match(auth, /auth\\.signOut\\(\\{scope:'local'\\}\\)/);
  assert.match(auth, /error\\?\\.code===['"]rate_limited['"]/);
});

test('database migration revokes current and future Data API privileges from browser roles', async () => {
  const sql = await read('apps/api/prisma/migrations/20260907013500_lock_down_supabase_data_api/migration.sql');

  assert.match(sql, /ARRAY\['anon', 'authenticated'\]/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public/);
  assert.match(sql, /REVOKE USAGE ON SCHEMA public/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM authenticated/);
  assert.doesNotMatch(sql, /FROM service_role/, 'server/service integrations are outside this browser-role hardening migration');
});
