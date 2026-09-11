import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ListingStatus,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';

import {
  buildHostPowerPolicy,
  deriveHostPowerPolicy,
  KEEP_AWAKE_LISTING_STATUSES,
  KEEP_AWAKE_SESSION_STATUSES,
} from '../src/host-power-policy.js';

describe('host power policy', () => {
  it('keeps an owner-available idle Host awake without a live rental', () => {
    assert.deepEqual(deriveHostPowerPolicy(0, 1), {
      protocolVersion: 1,
      keepAwake: true,
      reason: 'marketplace_available',
      liveSessionCount: 0,
      availabilityListingCount: 1,
    });
  });

  it('live rental/session always keeps the Host awake', () => {
    assert.deepEqual(deriveHostPowerPolicy(1, 0), {
      protocolVersion: 1,
      keepAwake: true,
      reason: 'live_session',
      liveSessionCount: 1,
      availabilityListingCount: 0,
    });
  });

  it('returns Windows sleep control only when no availability intent or live session remains', () => {
    assert.deepEqual(deriveHostPowerPolicy(0, 0), {
      protocolVersion: 1,
      keepAwake: false,
      reason: 'not_available',
      liveSessionCount: 0,
      availabilityListingCount: 0,
    });
  });

  it('treats owner availability and offline-recovery states as keep-awake states', () => {
    assert.deepEqual(KEEP_AWAKE_LISTING_STATUSES, [
      ListingStatus.PENDING_GPU_VERIFICATION,
      ListingStatus.ACTIVE,
      ListingStatus.RESERVED,
      ListingStatus.HIDDEN_OFFLINE,
    ]);
    assert.deepEqual(KEEP_AWAKE_SESSION_STATUSES, [
      WorkspaceSessionStatus.RESERVED,
      WorkspaceSessionStatus.PREPARING,
      WorkspaceSessionStatus.READY,
      WorkspaceSessionStatus.RUNNING,
      WorkspaceSessionStatus.STOP_REQUESTED,
      WorkspaceSessionStatus.STOPPING,
    ]);
  });

  it('queries only the target machine and derives the signed policy counts', async () => {
    const calls: unknown[] = [];
    const db = {
      workspaceSession: {
        count: async (args: unknown) => {
          calls.push(args);
          return 0;
        },
      },
      gpuListing: {
        count: async (args: unknown) => {
          calls.push(args);
          return 1;
        },
      },
    } as unknown as PrismaClient;

    const policy = await buildHostPowerPolicy(db, 'machine_00000001');
    assert.equal(policy.keepAwake, true);
    assert.equal(policy.reason, 'marketplace_available');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => JSON.stringify(call).includes('machine_00000001')));
  });
});
