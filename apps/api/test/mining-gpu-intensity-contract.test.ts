import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routesSource = readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');

test('mining routes never consume or expose fake GPU intensity', async () => {
  const source = await routesSource;
  assert.doesNotMatch(source, /input\.gpuIntensityPercent/);
  assert.doesNotMatch(source, /c\."gpuIntensityPercent"/);
  assert.doesNotMatch(source, /gpuIntensityPercent: number \| null/);
  assert.match(source, /"gpuIntensityPercent" = NULL/);
  assert.match(
    source,
    /\$\{input\.cpuThreadLimit \?\? null\},\s+NULL, \$\{feeBps\}/,
  );
});

test('historical gpuIntensityPercent column is retained only for non-destructive cleanup', async () => {
  const source = await routesSource;
  assert.match(source, /"cpuThreadCount", "gpuIntensityPercent", "platformFeeBasisPoints"/);
  assert.match(source, /"gpuIntensityPercent" = NULL/);
});
