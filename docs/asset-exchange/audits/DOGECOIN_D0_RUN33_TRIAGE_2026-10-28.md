# Dogecoin D0 — independent Gitian run #33 failure triage (2026-10-28)

Status: **BLOCKED**. Evidence-only update. No Mainnet, no funds, no binary execution, no settlement activation, and no relaxation of the strict manifest comparator.

## Reproduction reviewed

- Workflow: https://github.com/khemisset18/gpubnb/actions/runs/40757273650
- Source head tested: `9396fed2e2b469aff96bf8886b79989f5f8deacc`
- Replica A job: `123059433225`, FAILED at "Reproduce Dogecoin Core v1.14.9 Linux x86_64".
- Replica B job: `123059433645`, FAILED at the same step.
- Both Gitian jobs completed Linux target builds and printed the same x86_64 SHA-256 `b0aab5a024db9e1c0df09df716581d41b543fd2fee92be9cef4a981a4130e1b7`.
- Required official SHA-256: `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`. **MISMATCH.**
- The comparison job was SKIPPED because both build jobs failed.
- Independent smoke workflow `40757137535` passed its Focal installed-package check, FreeType download check and fail-closed evidence tests. Those passes do not satisfy full D0.

## Exact immediate failure in both logs

`Gitian base manifest does not match either official Dogecoin 1.14.9 attestation`.

Both replica logs include the same manifest diff in the Linux package group:

| Component | KunNw0n official manifest | Built Gitian manifest |
| --- | --- | --- |
| `linux-image` | `5.4.0-202-generic / 5.4.0-202.222` | `5.4.0-200-generic / 5.4.0-200.220` |
| `linux-image-generic` | `5.4.0.202.198` | `5.4.0.200.196` |
| `linux-libc-dev` | `5.4.0-202.222` | `5.4.0-200.220` |
| `linux-modules` and `linux-modules-extra` | `5.4.0-202.222` | `5.4.0-200.220` |

The displayed archive/package checksums differ accordingly. This is a confirmed manifest mismatch, **not** proof that these are the only inputs behind the release archive SHA-256 mismatch.

The current harness uses immutable snapshot `20241212T000000Z`, runs `dist-upgrade`, installs `linux-image-generic` and clears cached `*.deb` before Gitian import. Its installed-package pin list does **not** currently assert the expected kernel meta-package, kernel image, modules and `linux-libc-dev` versions. Changing the snapshot blindly, editing the official manifests, or allowing a self-reported manifest would invalidate the security objective.

## Safe next technical work

1. Establish using authenticated snapshot metadata which Ubuntu snapshot timestamp exposes the exact **official** kernel package versions *and all other pinned historical package versions*. Preserve source, signing metadata and package hashes as evidence.
2. Add an isolated read-only candidate/package probe for this kernel group, including exact package name/version/hash checks; do not use an unverified snapshot candidate as a new build trust root.
3. Only after that evidence, update the Focal bootstrap pin and the fail-closed installed-package checks in a separate reviewed change. Preserve the exact 323-entry official manifests.
4. Repeat independent A/B Gitian builds and require full manifest equality, binary output equality, official archive hash equality, verified provenance and SBOM before considering a D0 pass.

No assertion here authorizes D1-D9, registry promotion, BCH progression, Mainnet or real funds.


## Correction after direct artifact/upstream comparison (2026-10-29)

The kernel table above describes **KunNw0n only**, not both accepted variants.
The checked-in manifests match upstream byte-for-byte at
`dogecoin/gitian.sigs@9d1be4fb0effc4c2e97750e0763b92f39d474a17` (323 lines each).
The slightlyskepticalpotat variant uses kernel 5.4.0-200, but requires
`intel-microcode=3.20240910.0ubuntu0.20.04.1` and `libexpat1=2.2.9-1ubuntu0.7`.
The run #33 manifests differ from that variant in those **two** packages.
They differ from KunNw0n in the **five** kernel packages listed above.
Thus the build environment mixes cohorts; neither entire manifest matches.
The existing newer microcode/expat pins and PR #311 kernel guards target KunNw0n.

Both diagnostic ZIPs were downloaded and matched their GitHub artifact digests.
Their result YAML files declare the same non-official output hash, but neither
ZIP contains the release archive. This review therefore does **not** prove
byte-for-byte equality of the two binaries. Full Actions console log retrieval
failed with `Transport closed`; complete Gitian build/install logs were available
inside the diagnostic ZIPs. See the 2026-10-29 follow-up for exact evidence.
