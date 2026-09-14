import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const reportPath = path.join(repoRoot, 'apps/host-desktop/src/support-report.ts');
const source = fs.readFileSync(reportPath, 'utf8');

const outputSection = source.slice(source.indexOf('export const buildPrivacySafeSupportReport'));

const forbiddenOutputReads = [
  '.browserUrl',
  '.email',
  '.wallet',
  '.password',
  '.token',
  '.cookie',
  '.privateKey',
  '.publicKey',
  '.sourceUrl',
  '.executablePath',
  '.logFile',
  '.environment',
];

test('support report is explicitly implemented as an allowlisted privacy boundary', () => {
  assert.match(source, /Deliberately omitted:/);
  assert.match(source, /machineRef: identifierRef\(status\.agent\.machineId\)/);
  assert.match(source, /gpuRef: identifierRef\(gpu\.uuid\)/);
});

test('support report output never reads known secret/private source fields', () => {
  for (const forbidden of forbiddenOutputReads) {
    assert.equal(
      outputSection.includes(forbidden),
      false,
      `privacy-safe report unexpectedly reads ${forbidden}`,
    );
  }
});

test('support report does not serialize full machine or GPU identifiers', () => {
  assert.doesNotMatch(outputSection, /machineId\s*:/);
  assert.doesNotMatch(outputSection, /\buuid\s*:/);
  assert.match(source, /slice\(-8\)/);
});

test('support report uses bounded collection sizes', () => {
  assert.match(outputSection, /\.slice\(0, 16\)/);
  assert.match(outputSection, /\.slice\(0, 32\)/);
});

test('privacy contract documents fail-closed isolation rather than host-access fallback', () => {
  const document = fs.readFileSync(
    path.join(repoRoot, 'docs/HOST_PRIVACY_AND_ISOLATION.md'),
    'utf8',
  );
  assert.match(document, /must remain fail-closed/i);
  assert.match(document, /not your Windows desktop/i);
  assert.match(document, /must never become a general-purpose TCP proxy/i);
});
