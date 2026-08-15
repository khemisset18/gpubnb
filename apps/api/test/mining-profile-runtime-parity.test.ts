import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MINING_PROFILE_CATALOG } from '../src/mining-profile-catalog.js';

test('every enabled mining profile has pinned Host runtime provenance', () => {
  const manifestPath = path.resolve(
    process.cwd(),
    '../host-desktop/src-tauri/src/approved_miner_manifest.rs',
  );
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const enabled = MINING_PROFILE_CATALOG.filter((profile) => profile.enabled);
  assert.ok(enabled.length > 0);
  for (const profile of enabled) {
    assert.match(
      manifest,
      new RegExp(`"${profile.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      `enabled profile ${profile.id} must exist in approved_miner_manifest.rs`,
    );
  }
});

test('unqualified GPU miners remain disabled', () => {
  for (const id of ['trex_rvn_kawpow', 'teamredminer_rvn_kawpow', 'lolminer_erg_autolykos2']) {
    assert.equal(MINING_PROFILE_CATALOG.find((profile) => profile.id === id)?.enabled, false);
  }
});
