import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../src');
const authorityFile = path.join(srcDir, 'quarantine-service.ts');

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

test('quarantine-service remains the only production authority for quarantine state writes', async () => {
  const violations: string[] = [];

  for (const file of await listTsFiles(srcDir)) {
    if (file === authorityFile) continue;
    const source = await readFile(file, 'utf8');
    const relative = path.relative(srcDir, file);

    if (/moderationStatus\s*:\s*ModerationStatus\.QUARANTINED/.test(source)) {
      violations.push(`${relative}: direct QUARANTINED assignment`);
    }
    if (/quarantinedAt\s*:\s*null/.test(source)) {
      violations.push(`${relative}: direct quarantine timestamp clear`);
    }
    if (/quarantineReasonCode\s*:\s*null/.test(source)) {
      violations.push(`${relative}: direct quarantine reason clear`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    'all production quarantine enter/clear writes must go through quarantine-service.ts',
  );
});

test('quarantine-service writes machine state and durable event history together', async () => {
  const source = await readFile(authorityFile, 'utf8');
  assert.match(source, /moderationStatus:\s*ModerationStatus\.QUARANTINED/);
  assert.match(source, /moderationStatus:\s*ModerationStatus\.CLEAR/);
  assert.match(source, /machineQuarantineEvent\.create/);
  assert.match(source, /accelerator\.updateMany/);
});
