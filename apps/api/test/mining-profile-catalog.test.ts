import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMiningProfileApproved,
  miningProfileById,
} from '../src/mining-profile-catalog.js';

describe('mining profile catalog', () => {
  it('approves only enabled profiles for the expected resource kind', () => {
    assert.equal(isMiningProfileApproved('trex_rvn_kawpow', 'GPU'), true);
    assert.equal(isMiningProfileApproved('trex_rvn_kawpow', 'CPU'), false);
    assert.equal(isMiningProfileApproved('xmrig_randomx', 'CPU'), true);
    assert.equal(isMiningProfileApproved('xmrig_randomx', 'GPU'), false);
  });

  it('rejects disabled and unknown profiles', () => {
    assert.equal(isMiningProfileApproved('lolminer_beam_beamhashiii', 'GPU'), false);
    assert.equal(isMiningProfileApproved('powershell', 'GPU'), false);
    assert.equal(miningProfileById('missing_profile'), undefined);
  });
});
