#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [root, output, sourceSha, created] = process.argv.slice(2);
if (!root || !output || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
  console.error("usage: generate-sbom.mjs <root> <output> <source-sha> <created-iso>");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created ?? "")) {
  throw new Error("created timestamp must be deterministic UTC ISO-8601");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else if (st.isFile()) out.push(path);
    else throw new Error(`unsupported artifact entry: ${path}`);
  }
  return out;
}

function hash(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
}

const files = walk(root).map((path) => {
  const bytes = readFileSync(path);
  const name = "./" + relative(root, path).replaceAll("\\", "/");
  return {
    name,
    id: "SPDXRef-File-" + hash("sha256", Buffer.from(name)).slice(0, 24),
    sha1: hash("sha1", bytes),
    sha256: hash("sha256", bytes)
  };
});

const verificationInput = files.map((f) => f.sha1).sort().join("");
const packageVerificationCode = hash("sha1", Buffer.from(verificationInput));
const packageId = "SPDXRef-Package-gpu-k-p2p-recovery-tool-v1";

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "gpu.k.p2p-recovery-tool-v1",
  documentNamespace: `https://github.com/khemisset18/gpubnb/spdx/recovery-tool/${sourceSha}`,
  creationInfo: { created, creators: ["Tool: gpu.k.p2p deterministic SPDX generator v1"] },
  packages: [{
    name: "gpu.k.p2p-recovery-tool-v1",
    SPDXID: packageId,
    versionInfo: sourceSha.slice(0, 12),
    downloadLocation: "NOASSERTION",
    filesAnalyzed: true,
    packageVerificationCode: { packageVerificationCodeValue: packageVerificationCode },
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [{
      referenceCategory: "OTHER",
      referenceType: "source-commit",
      referenceLocator: `https://github.com/khemisset18/gpubnb/commit/${sourceSha}`
    }]
  }],
  files: files.map((f) => ({
    fileName: f.name,
    SPDXID: f.id,
    checksums: [
      { algorithm: "SHA1", checksumValue: f.sha1 },
      { algorithm: "SHA256", checksumValue: f.sha256 }
    ],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION"
  })),
  relationships: [
    { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: packageId },
    ...files.map((f) => ({ spdxElementId: packageId, relationshipType: "CONTAINS", relatedSpdxElement: f.id }))
  ]
};

writeFileSync(output, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
