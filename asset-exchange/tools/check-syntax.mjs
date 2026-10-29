// Check every source file: node --check accepts only one script per invocation.
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['core', 'api', 'worker', 'chain-watchers', 'recovery', 'settlement', 'release', 'research'];
let count = 0;
for (const directory of directories) {
  const base = join(root, directory, 'src');
  for (const name of readdirSync(base, {recursive: true}).filter(name => /\.m?js$/.test(name)).sort()) {
    const result = spawnSync(process.execPath, ['--check', join(base, name)], {stdio: 'inherit'});
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    count++;
  }
}
console.log(`Syntax PASS: ${count} source files checked independently`);
