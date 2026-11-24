"""Check the pinned Pearl release with signed GitHub TUF roots, OpenSSL and cryptography."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID

REPO = "pearl-research-labs/pearl"
PIN = "3db05e0de0ca90c3a043abd927b968cf53bcd4c8"
TAG = "v1.5.8"


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def cert(blob):
    return x509.load_der_x509_certificate(base64.b64decode(blob["rawBytes"], validate=True))


def openssl(*args):
    return subprocess.run(["openssl", *args], capture_output=True, text=True, check=True).stdout


def verify(archive, manifest, bundle, roots, tmp):
    envelope = bundle["dsseEnvelope"]
    signature, = envelope["signatures"]
    sig = base64.b64decode(signature["sig"], validate=True)
    payload = base64.b64decode(envelope["payload"], validate=True)
    kind = envelope["payloadType"].encode()
    require(kind == b"application/vnd.in-toto+json", "wrong payload type")
    vm = bundle["verificationMaterial"]
    timestamp, = vm["timestampVerificationData"]["rfc3161Timestamps"]
    stamp, sigfile = tmp / "timestamp.der", tmp / "sig.bin"
    stamp.write_bytes(base64.b64decode(timestamp["signedTimestamp"], validate=True))
    sigfile.write_bytes(sig)
    stamp_text = openssl("ts", "-reply", "-in", stamp, "-text")
    raw_time = next(line.removeprefix("Time stamp: ") for line in stamp_text.splitlines() if line.startswith("Time stamp: "))
    observed = datetime.strptime(raw_time, "%b %d %H:%M:%S %Y GMT").replace(tzinfo=timezone.utc)
    signer = cert(vm["certificate"])
    leaf = tmp / "leaf.pem"
    leaf.write_bytes(signer.public_bytes(serialization.Encoding.PEM))
    for group, uri in [("timestampAuthorities", "timestamp.githubapp.com"), ("certificateAuthorities", "fulcio.githubapp.com")]:
        for authority in (a for root in roots for a in root[group] if a.get("uri") == uri):
            valid = authority["validFor"]
            if observed < datetime.fromisoformat(valid["start"]) or ("end" in valid and observed > datetime.fromisoformat(valid["end"])):
                continue
            chain = [cert(c).public_bytes(serialization.Encoding.PEM) for c in authority["certChain"]["certificates"]]
            root_file, intermediates = tmp / "root.pem", tmp / "inter.pem"
            root_file.write_bytes(chain[-1])
            intermediates.write_bytes(b"".join(chain[:-1]))
            options = ["-attime", str(int(observed.timestamp())), "-CAfile", root_file, "-untrusted", intermediates]
            try:
                if group == "timestampAuthorities":
                    openssl("ts", "-verify", "-in", stamp, "-data", sigfile, *options)
                else:
                    openssl("verify", *options, leaf)
            except subprocess.CalledProcessError:
                continue
            break
        else:
            raise ValueError("unverified chain or timestamp for " + uri)
    issuer = "https://dotcom.releases.github.com"
    san = signer.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    require(san.get_values_for_type(x509.UniformResourceIdentifier) == [issuer], "wrong release identity")
    require(ExtendedKeyUsageOID.CODE_SIGNING in signer.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value, "wrong key usage")
    pae = b" ".join([b"DSSEv1", str(len(kind)).encode(), kind, str(len(payload)).encode(), payload])
    signer.public_key().verify(sig, pae, ec.ECDSA(hashes.SHA256()))
    st = json.loads(payload)
    p = st["predicate"]
    require(st["_type"] == "https://in-toto.io/Statement/v1" and st["predicateType"] == "https://in-toto.io/attestation/release/v0.2", "wrong attestation")
    require((p["repository"], p["repositoryId"], p["tag"], p["purl"]) == (REPO, "1214991373", TAG, f"pkg:github/{REPO}@{TAG}"), "wrong release")
    for artifact, name in [(archive, "pearl-linux-amd64-v1.5.8.tar.gz"), (manifest, "checksums.txt")]:
        with artifact.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        require(sum(s.get("name") == name and s["digest"].get("sha256") == digest for s in st["subject"]) == 1, "unexpected artifact")
        print(name, digest)
    require(sum(s.get("uri") == p["purl"] and s["digest"].get("sha1") == PIN for s in st["subject"]) == 1, "incorrect tag commit")
    print("PASS GitHub release signing chain and SAN, RFC3161 timestamp, ECDSA DSSE, tag, commit and artifact hashes")
    print(observed.isoformat(), issuer, REPO, TAG, PIN)


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    for arg in ("archive", "manifest", "bundle", "trusted_roots"):
        cli.add_argument(arg, type=Path)
    args = cli.parse_args()
    with TemporaryDirectory() as directory:
        verify(args.archive, args.manifest, json.loads(args.bundle.read_text()),
               [json.loads(s) for s in args.trusted_roots.read_text().splitlines()], Path(directory))
