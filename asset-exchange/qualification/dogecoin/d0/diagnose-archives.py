#!/usr/bin/env python3
"""Read archives as data only. This report can never qualify D0."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile

from validate_evidence import OFFICIAL_SHA256


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect(path):
    members = {}
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            if len(members) >= 128 or member.size > 64 * 1024 * 1024:
                raise ValueError("diagnostic archive bounds exceeded")
            if member.name in members:
                raise ValueError("duplicate member")
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise ValueError("unsafe member path")
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError("unsupported member type")
            # Never extract or follow a link, even a relative one.
            data = archive.extractfile(member).read() if member.isfile() else b""
            members[member.name] = {
                "metadata": {key: getattr(member, key) for key in
                             ("mode", "uid", "gid", "size", "mtime", "linkname", "uname", "gname", "pax_headers")},
                "type": member.type.decode("ascii"),
                "sha256": digest(data) if member.isfile() else None,
                "versionStrings": [{"offset": match.start(), "value": match.group().decode("ascii")}
                                   for match in re.finditer(rb"v1\.14\.9[^\x00\s]{0,40}", data)]
                                  if member.isfile() and "/bin/" in member.name else [],
            }
    return members


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: diagnose-archives.py <official> <replica-a> <replica-b>")
    paths = [Path(value) for value in sys.argv[1:]]
    if any(p.is_symlink() or not p.is_file() or p.stat().st_size > 128 * 1024 * 1024 for p in paths):
        raise ValueError("invalid diagnostic input")
    blobs = [path.read_bytes() for path in paths]
    hashes = [digest(data) for data in blobs]
    if hashes[0] != OFFICIAL_SHA256:
        raise ValueError("reference is not the unchanged pinned official archive")
    records = [inspect(path) for path in paths]
    names = [list(record) for record in records]
    report = {
        "status": "DIAGNOSTIC_ONLY",
        "binaryExecuted": False,
        "archives": {label: {"sha256": hashes[i], "bytes": len(blobs[i])}
                     for i, label in enumerate(("official", "replicaA", "replicaB"))},
        "replicasByteIdentical": blobs[1] == blobs[2],
        "officialByteIdentical": blobs[0] == blobs[1] == blobs[2],
        "memberOrderIdentical": names[0] == names[1] == names[2],
        "members": {name: {label: records[i].get(name)
                           for i, label in enumerate(("official", "replicaA", "replicaB"))}
                    for name in sorted(set().union(*[set(record) for record in records]))},
    }
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
