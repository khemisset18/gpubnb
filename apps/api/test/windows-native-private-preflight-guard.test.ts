import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const api = readFileSync(new URL('../src/desktop-workspace-routes.ts', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../web/stage3-windows-native.js', import.meta.url), 'utf8');

test('private preflight is authenticated read-only and requires beta bypass AND disabled escrow', () => {
  assert.match(api, /function windowsNativePrivateQualificationEnabled\(\): boolean \{[\s\S]*?BETA_TEST_DEV_BYPASS === 'true'[\s\S]*?ESCROW_PROGRAM_ID === 'NOT_DEPLOYED_YET'/);
  const start = api.indexOf("app.get('/qualification/windows-native/preflight'");
  const end = api.indexOf("app.post('/qualification/windows-native/booking'", start);
  assert.ok(start > 0 && end > start, 'private preflight must precede the booking mutation route');
  const route = api.slice(start, end);
  assert.match(route, /await requireSession\(request, reply, redis\)/);
  assert.match(route, /Cache-Control', 'no-store'/);
  assert.match(route, /windowsNativePrivateQualificationEnabled\(\)/);
  assert.match(route, /nativeDesktopStreamingAvailable: true/);
  assert.match(route, /WINDOWS_NATIVE_GPU_UUID_RE\.test\(uuid\)/);
  assert.match(route, /lastHeartbeatAt/);
  assert.match(route, /windowsNativePrivateQualificationListingStatuses/);
  assert.doesNotMatch(route, /\.create\(|\.update\(|\.delete\(|\$transaction\(|runBookingTransaction\(/);
  assert.doesNotMatch(route, /ListingStatus\.ACTIVE/);
});

type PrivatePreflight = { privateNoPaymentMode: boolean; allowed: boolean; code: string };

async function exerciseBrowser(preflight: PrivatePreflight): Promise<{ calls: string[]; message: string }> {
  const calls: string[] = [];
  let click: (() => void) | undefined;
  const button = {
    disabled: false,
    addEventListener: (_name: string, handler: () => void) => { click = handler; },
  };
  const status = { textContent: '', style: { color: '' } };
  const browserContext = {
    window: { GPUBNB_API_URL: 'https://private.test.invalid', location: { origin: 'https://private.test.invalid' } },
    document: { querySelector: (selector: string) => selector === '#stage3-start' ? button : status },
    fetch: async (url: string, options: { method?: string }) => {
      const path = new URL(url).pathname;
      calls.push(`${options.method ?? 'GET'} ${path}`);
      const data = path === '/qualification/windows-native/preflight'
        ? preflight
        : path === '/auth/me'
          ? { id: 'test-user' }
          : { error: 'test_halt_before_mutation' };
      return {
        ok: path === '/auth/me' || path === '/qualification/windows-native/preflight',
        status: path === '/auth/me' || path === '/qualification/windows-native/preflight' ? 200 : 409,
        json: async () => data,
      };
    },
    setTimeout,
  };
  vm.runInNewContext(browser, browserContext, { timeout: 1000 });
  assert.ok(click, 'browser did not attach the private test button');
  click();
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  return { calls, message: status.textContent };
}

test('PC2 refuses to create booking when private beta no-payment mode is off', async () => {
  const result = await exerciseBrowser({ privateNoPaymentMode: false, allowed: false, code: 'PRIVATE_BETA_NO_PAYMENT_DISABLED' });
  assert.deepEqual(result.calls, ['GET /auth/me', 'GET /qualification/windows-native/preflight']);
  assert.match(result.message, /Aucune réservation créée/);
});

test('PC2 refuses to create booking when PC1 is not ready or occupied', async () => {
  for (const code of ['PRIVATE_WINDOWS_HOST_NOT_READY', 'PRIVATE_WINDOWS_HOST_RESERVED']) {
    const result = await exerciseBrowser({ privateNoPaymentMode: true, allowed: false, code });
    assert.deepEqual(result.calls, ['GET /auth/me', 'GET /qualification/windows-native/preflight']);
    assert.match(result.message, /Aucune réservation créée/);
  }
});

test('PC2 may only attempt the booking after positive private readiness proof', async () => {
  const result = await exerciseBrowser({ privateNoPaymentMode: true, allowed: true, code: 'PRIVATE_WINDOWS_TEST_ATTEMPT_ALLOWED' });
  assert.deepEqual(result.calls, [
    'GET /auth/me',
    'GET /qualification/windows-native/preflight',
    'POST /qualification/windows-native/booking',
  ]);
  assert.match(result.message, /test_halt_before_mutation/);
});
