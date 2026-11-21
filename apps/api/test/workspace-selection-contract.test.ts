import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const api = new URL('../src/', import.meta.url);

test('booking creation stores one server-approved Workspace selection', async () => {
  const server = await readFile(new URL('server.ts', api), 'utf8');
  assert.match(server, /workspaceSlug:z\.enum\(executableWorkspaceSlugs\)(?=[,}])/);
  assert.match(server, /requestedWorkspaceSlug:b\.workspaceSlug(?=[,}])/);
  assert.match(server, /booking_workspace_mismatch/);
  assert.match(server, /else if\(!linuxHost\)\{[\s\S]*workspace_platform_unsupported/);
});

test('every Linux container Workspace start binds to the booking selection and active lease inside its transaction', async () => {
  const routes = await readFile(new URL('workspace-renter-routes.ts', api), 'utf8');
  const helper = routes.slice(routes.indexOf('async function findSelectedWorkspaceBooking'), routes.indexOf('export function preparationPhase'));
  assert.match(helper, /endsAt: \{ gt: new Date\(\) \}/);
  assert.match(helper, /OR: \[\{ requestedWorkspaceSlug: null \}, \{ requestedWorkspaceSlug: slug \}\]/);
  assert.match(helper, /endsAt: \{ gt: new Date\(\) \}/);

  for (const slug of ['developer', 'data', 'ai', 'video', 'audio', 'api', 'mobile', 'security-lab']) {
    assert.ok(routes.includes(`lockSelectedWorkspaceBooking(tx,bookingId,session.userId,'${slug}')`), `${slug} must recheck selection and lease expiry in its creation transaction`);
  }
  const desktop = await readFile(new URL('desktop-workspace-routes.ts', api), 'utf8');
  assert.match(desktop, /requestedWorkspaceSlug: slug/);
  assert.match(desktop, /OR: \[\{ requestedWorkspaceSlug: null \}, \{ requestedWorkspaceSlug: slug \}\]/);
  assert.match(desktop, /requestedWorkspaceSlug: booking\.requestedWorkspaceSlug/);
});

test('status, access and legacy session-start routes cannot switch from the booking selection', async () => {
  const routes = await readFile(new URL('workspace-renter-routes.ts', api), 'utf8');
  for (const slug of ['developer', 'data', 'ai', 'video', 'audio', 'api', 'mobile', 'security-lab']) {
    assert.ok((routes.match(new RegExp(`selectedWorkspaceSessionScope\\('${slug}'\\)`, 'g')) || []).length >= 2,
      `${slug} status and access queries must verify the booking selection`);
  }
  const desktop = await readFile(new URL('desktop-workspace-routes.ts', api), 'utf8');
  assert.ok((desktop.match(/selectedWorkspaceSessionScope\(slug\)/g) || []).length >= 2,
    'desktop status and access must verify the selected or legacy booking scope');
  const server = await readFile(new URL('server.ts', api), 'utf8');
  assert.match(server, /workspace_not_selected_for_booking/);
});

test('Compute proof creation cannot redirect a selected Workspace or start after expiry', async () => {
  const server = await readFile(new URL('server.ts', api), 'utf8');
  const start = server.indexOf('async function ensureComputePreparation');
  const end = server.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  const body = server.slice(start, end).replace(/\s+/g, '');
  assert.match(body, /endsAt:\{gt:newDate\(\)\}/);
  assert.match(body, /OR:\[\{requestedWorkspaceSlug:null\},\{requestedWorkspaceSlug:'compute'\}\]/);
  assert.match(body, /tx\.booking\.updateMany\(\{where:\{id:bookingId,buyerId:renterId,status:\{in:activeJobBookings\},endsAt:\{gt:newDate\(\)\},OR:/);
});

test('stale GPU proof cannot replace an explicit selection with Developer', async () => {
  const completion = await readFile(new URL('gpu-proof-completion.ts', api), 'utf8');
  assert.match(completion, /selected\?\.requestedWorkspaceSlug\s*&&\s*selected\.requestedWorkspaceSlug !== 'compute'/);
  assert.match(completion, /if \(!selected\?\.requestedWorkspaceSlug\) \{[\s\S]*ensureCompatibleMachineWorkspace\(db, machineId, 'developer'\)/);
});
