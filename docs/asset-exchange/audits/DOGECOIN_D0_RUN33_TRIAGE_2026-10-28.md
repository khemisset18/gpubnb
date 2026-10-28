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

| Component | Official attested manifest | Built Gitian manifest |
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
