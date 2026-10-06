import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [root, sourceCommit, sourceTree, sourceEpochRaw, archiveSha256] = process.argv.slice(2);
if (!root || !/^[0-9a-f]{40}$/.test(sourceCommit ?? "") || !/^[0-9a-f]{40}$/.test(sourceTree ?? "")) {
  throw new Error("usage: generate-sbom.mjs <root> <sourceCommit> <sourceTree> <sourceEpoch> <archiveSha256>");
}
if (!/^[0-9]+$/.test(sourceEpochRaw ?? "") || !/^[0-9a-f]{64}$/.test(archiveSha256 ?? "")) {
  throw new Error("invalid source epoch or archive sha256");
}

const sourceEpoch = Number(sourceEpochRaw);
if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 1) throw new Error("invalid source epoch");

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink forbidden: ${full}`);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
    else throw new Error(`unsupported file type: ${full}`);
  }
  return out.sort();
}

const files = walk(root);
if (files.length === 0) throw new Error("empty source bundle");

const spdxFiles = [];
const sha1Values = [];
for (let i = 0; i < files.length; i++) {
  const relative = files[i];
  const bytes = fs.readFileSync(path.join(root, relative));
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  sha1Values.push(sha1);
  spdxFiles.push({
    fileName: `./${relative}`,
    SPDXID: `SPDXRef-File-${i + 1}`,
    checksums: [
      { algorithm: "SHA1", checksumValue: sha1 },
      { algorithm: "SHA256", checksumValue: sha256 }
    ],
    licenseConcluded: "NOASSERTION",
    licenseInfoInFiles: ["NOASSERTION"],
    copyrightText: "NOASSERTION"
  });
}

const verificationCode = createHash("sha1")
  .update([...sha1Values].sort().join(""))
  .digest("hex");

const created = new Date(sourceEpoch * 1000).toISOString().replace(".000Z","Z");
const packageId = "SPDXRef-Package";
const relationships = [
  { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: packageId },
  ...spdxFiles.map((f) => ({
    spdxElementId: packageId,
    relationshipType: "CONTAINS",
    relatedSpdxElement: f.SPDXID
  }))
];

const doc = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "gpu.k.p2p-asset-exchange-source-v1",
  documentNamespace: `https://github.com/khemisset18/gpubnb/spdx/asset-exchange-source/${sourceCommit}`,
  creationInfo: {
    created,
    creators: ["Tool: gpu.k.p2p-source-audit-sbom-v1"]
  },
  packages: [{
    name: "gpu.k.p2p-asset-exchange-source-v1",
    SPDXID: packageId,
    versionInfo: sourceCommit.slice(0, 12),
    downloadLocation: "NOASSERTION",
    filesAnalyzed: true,
    checksums: [{ algorithm: "SHA256", checksumValue: archiveSha256 }],
    packageVerificationCode: { packageVerificationCodeValue: verificationCode },
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "OTHER",
        referenceType: "source-commit",
        referenceLocator: `https://github.com/khemisset18/gpubnb/commit/${sourceCommit}`
      },
      {
        referenceCategory: "OTHER",
        referenceType: "git-tree",
        referenceLocator: sourceTree
      }
    ]
  }],
  files: spdxFiles,
  relationships
};

process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
