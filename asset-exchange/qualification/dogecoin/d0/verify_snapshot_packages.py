"""Verify a complete D0 package cohort against signature-checked APT indexes.

Read-only: no package installation, snapshot promotion or binary execution.
The caller supplies the existing Ubuntu trust keyring, never a fetched new key.
APT index files must be uncompressed (as in the D0 rootfs/probe).
"""
import argparse
import hashlib
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote

SUITES = ("focal", "focal-updates", "focal-security", "focal-backports")
COMPONENTS = ("main", "restricted", "universe", "multiverse")


def signed_hashes(release):
    sections = release.split("\nSHA256:\n")
    if len(sections) != 2:
        raise ValueError("missing/duplicate signed SHA256 section")
    result = {}
    for line in sections[1].splitlines():
        if not line.startswith(" "):
            break
        match = re.fullmatch(r" ([a-f0-9]{64})\s+(\d+)\s+(\S+)", line)
        if not match or match[3] in result:
            raise ValueError("invalid/duplicate signed index hash")
        result[match[3]] = (match[1], int(match[2]))
    return result


def package_records(data):
    records = {}
    for paragraph in data.decode("utf-8").split("\n\n"):
        fields = {}
        for line in paragraph.splitlines():
            if line.startswith((" ", "\t")):
                continue
            key, sep, value = line.partition(":")
            if not sep or key in fields:
                raise ValueError("malformed/duplicate package field")
            fields[key] = value.lstrip()
        if not fields:
            continue
        if not all(k in fields for k in ("Package", "Version", "Architecture", "SHA256")):
            raise ValueError("incomplete package identity/hash")
        if not re.fullmatch(r"[a-f0-9]{64}", fields["SHA256"]):
            raise ValueError("invalid package SHA256")
        # APT cache names encode epochs; archive Filename often omits them.
        name = "{Package}_{Version}_{Architecture}.deb".format(**fields)
        records.setdefault(name, set()).add(fields["SHA256"])
    return records


def require_manifest(manifest, records):
    names = set()
    for line in manifest.splitlines():
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch(r"[a-f0-9]{64}", parts[0]):
            raise ValueError("invalid manifest entry")
        digest, name = parts
        name = unquote(name)
        if name in names:
            raise ValueError("duplicate manifest package")
        names.add(name)
        if digest not in records.get(name, set()):
            raise ValueError(f"package missing or hash mismatch: {name}")
    if not names:
        raise ValueError("empty manifest")
    return len(names)


def verify(lists, keyring, snapshot, manifest):
    if not re.fullmatch(r"20\d{6}T\d{6}Z", snapshot):
        raise ValueError("invalid snapshot identifier")
    prefix = f"snapshot.ubuntu.com_ubuntu_{snapshot}_dists_"
    records = {}
    index_count = 0
    for suite in SUITES:
        release = lists / f"{prefix}{suite}_InRelease"
        subprocess.run(["gpgv", "--keyring", str(keyring.resolve()), str(release)], check=True)
        hashes = signed_hashes(release.read_text())
        components = ("main", "universe") if suite == "focal-backports" else COMPONENTS
        for component in components:
            name = f"{component}/binary-amd64/Packages"
            path = lists / f"{prefix}{suite}_{component}_binary-amd64_Packages"
            data = path.read_bytes()
            if (hashlib.sha256(data).hexdigest(), len(data)) != hashes.get(name):
                raise ValueError(f"signed index digest/size mismatch: {suite}/{name}")
            for package, digests in package_records(data).items():
                records.setdefault(package, set()).update(digests)
            index_count += 1
    count = require_manifest(manifest.read_text(), records)
    print(f"SNAPSHOT_MANIFEST_AVAILABILITY_PASS snapshot={snapshot} indexes={index_count} packages={count}")
    print("Availability only: installed-manifest and final archive equality remain mandatory.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lists", type=Path, required=True)
    parser.add_argument("--keyring", type=Path, required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    verify(args.lists, args.keyring, args.snapshot, args.manifest)
