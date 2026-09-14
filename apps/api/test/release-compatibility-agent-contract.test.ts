import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  RELEASE_COMPATIBILITY_PROTOCOL,
  RELEASE_FEATURE_PROTOCOLS,
} from '../src/release-compatibility.js';

const agentContractUrl = new URL(
  '../../../agent/gpubnb_agent/release_compatibility.py',
  import.meta.url,
);
const telemetryUrl = new URL('../../../agent/gpubnb_agent/telemetry.py', import.meta.url);

function integerConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`${name}[^=]*=\\s*(\\d+)`));
  assert.ok(match, `missing Agent constant ${name}`);
  return Number(match[1]);
}

function featureValue(source: string, feature: string): number {
  const match = source.match(new RegExp(`['"]${feature}['"]\\s*:\\s*(\\d+)`));
  assert.ok(match, `missing Agent feature protocol ${feature}`);
  return Number(match[1]);
}

test('Python Agent and TypeScript API require exactly the same release protocols', async () => {
  const source = await readFile(agentContractUrl, 'utf8');
  assert.equal(
    integerConstant(source, 'RELEASE_COMPATIBILITY_PROTOCOL'),
    RELEASE_COMPATIBILITY_PROTOCOL,
  );
  for (const [feature, required] of Object.entries(RELEASE_FEATURE_PROTOCOLS)) {
    assert.equal(featureValue(source, feature), required, `${feature} protocol drifted`);
  }
});

test('real Agent telemetry carries the compatibility descriptor on the signed v2 heartbeat path', async () => {
  const telemetry = await readFile(telemetryUrl, 'utf8');
  assert.match(telemetry, /"releaseCompatibility"\s*:\s*release_compatibility_descriptor\(\)/);
});
