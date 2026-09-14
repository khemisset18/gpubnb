#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function buildReleaseSupportManifest(input) {
  const version = String(input.version ?? '').trim();
  const commit = String(input.commit ?? '').trim().toLowerCase();
  const sha256 = String(input.sha256 ?? '').trim().toLowerCase();
  const rollbackTag = String(input.rollbackTag ?? '').trim();
  const compatibilityProtocol = Number(input.compatibilityProtocol);
  const signed = input.signed === true;
  const channel = String(input.channel ?? '').trim();
  const artifact = String(input.artifact ?? '').trim();

  if (!version || version === 'dev') throw new Error('release_support_version_invalid');
  if (!SHA40.test(commit)) throw new Error('release_support_commit_invalid');
  if (!SHA256.test(sha256)) throw new Error('release_support_sha256_invalid');
  if (!rollbackTag) throw new Error('release_support_rollback_tag_required');
  if (!Number.isSafeInteger(compatibilityProtocol) || compatibilityProtocol < 1) {
    throw new Error('release_support_compatibility_protocol_invalid');
  }
  if (!channel) throw new Error('release_support_channel_required');
  if (!artifact) throw new Error('release_support_artifact_required');

  return {
    schemaVersion: 1,
    version,
    commit,
    artifact,
    sha256,
    signed,
    compatibilityProtocol,
    channel,
    rollback: {
      tag: rollbackTag,
      automaticAllowed: false,
      reason: 'rollback_requires_verified_previous_release_and_post_install_health_failure',
    },
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('release_support_arguments_invalid');
    result[key.slice(2)] = value;
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const manifest = buildReleaseSupportManifest({
    version: args.version,
    commit: args.commit,
    sha256: args.sha256,
    signed: args.signed === 'true',
    compatibilityProtocol: Number(args.compatibilityProtocol),
    channel: args.channel,
    artifact: args.artifact,
    rollbackTag: args.rollbackTag,
  });
  const output = args.output || 'release-support-manifest.json';
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${output}\n`);
}
