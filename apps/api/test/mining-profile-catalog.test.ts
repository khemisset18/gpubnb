import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMiningProfileApproved,
  miningProfileById,
} from '../src/mining-profile-catalog.js';

describe('mining profile catalog', () => {
  it('approves only enabled profiles for the expected resource kind and GPU vendor', () => {
    assert.equal(isMiningProfileApproved('trex_rvn_kawpow', 'GPU', 'NVIDIA'), true);
    assert.equal(isMiningProfileApproved('trex_rvn_kawpow', 'GPU', 'AMD'), false);
    assert.equal(isMiningProfileApproved('trex_rvn_kawpow', 'GPU'), false);
    assert.equal(isMiningProfileApproved('trex_rvn_kawpow', 'CPU'), false);
    assert.equal(isMiningProfileApproved('xmrig_randomx', 'CPU'), true);
    assert.equal(isMiningProfileApproved('xmrig_randomx', 'GPU', 'NVIDIA'), false);
  });

  it('rejects disabled and unknown profiles', () => {
    assert.equal(isMiningProfileApproved('lolminer_beam_beamhashiii', 'GPU', 'NVIDIA'), false);
    assert.equal(isMiningProfileApproved('powershell', 'GPU', 'NVIDIA'), false);
    assert.equal(miningProfileById('missing_profile'), undefined);
  });
});
