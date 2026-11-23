import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ignoredDirectories = new Set([".git", ".test-tmp", "node_modules"]);

async function collectModules(directory) {
  const modules = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        modules.push(...await collectModules(join(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      modules.push(join(directory, entry.name));
    }
  }
  return modules;
}

const modules = (await collectModules(root)).sort();
let failed = false;
for (const modulePath of modules) {
  const result = spawnSync(process.execPath, ["--check", modulePath], { stdio: "inherit" });
  if (result.error) {
    console.error(`Could not check ${relative(root, modulePath)}: ${result.error.message}`);
    failed = true;
  } else if (result.status !== 0) {
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log(`JavaScript syntax PASS (${modules.length} .mjs files)`);
