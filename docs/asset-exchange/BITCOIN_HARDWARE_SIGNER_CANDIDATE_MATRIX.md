# Bitcoin Hardware Signer Candidate Matrix

Status: RESEARCH / CANDIDATES ONLY / NO PRODUCTION SUPPORT

Checked: 2026-10-06

This matrix records hardware-wallet families that are candidates for future gpu.k.p2p Asset Exchange interoperability testing.

A device appearing here is **not** a gpu.k.p2p supported or endorsed device.

## Research basis

Current HWI documentation lists implementations for:
- Ledger Nano X;
- Ledger Nano S;
- Trezor One;
- Trezor Model T / Safe 3 / Safe 5;
- BitBox01;
- BitBox02;
- KeepKey;
- Coldcard;
- Blockstream Jade.

HWI's own documentation warns that inclusion does not imply endorsement.

Bitcoin Core documentation also describes HWI as experimental and less reviewed than Bitcoin Core.

In August 2026, HWI issue #850 stated that the project had largely entered maintenance mode and plans to move to minimal maintenance after remaining MuSig2 work, pending a suitable replacement.

For gpu.k.p2p, this means HWI is an optional adapter candidate, never a permanent protocol dependency.

## Candidate matrix

| Device family | HWI reports implementation | gpu.k.p2p status | Required before support |
|---|---:|---|---|
| Ledger Nano S / X | Yes | UNVERIFIED CANDIDATE | exact firmware matrix, P2WSH HTLC PSBT test, display/WYSIWYS, cancel/disconnect, upgrade rollback |
| Trezor One | Yes | UNVERIFIED CANDIDATE | exact firmware matrix, P2WSH HTLC PSBT test, display/WYSIWYS, cancel/disconnect |
| Trezor Model T / Safe 3 / Safe 5 | Yes | UNVERIFIED CANDIDATE | exact firmware matrix, P2WSH HTLC PSBT test, display/WYSIWYS, cancel/disconnect |
| BitBox02 | Yes | UNVERIFIED CANDIDATE | exact firmware matrix, P2WSH HTLC PSBT test, display/WYSIWYS, cancel/disconnect |
| Coldcard | Yes | UNVERIFIED CANDIDATE | exact firmware matrix, PSBT transport workflow, P2WSH HTLC test, display/WYSIWYS where available |
| Blockstream Jade | Yes | UNVERIFIED CANDIDATE | exact firmware matrix, P2WSH HTLC PSBT test, display/WYSIWYS, cancel/disconnect |
| KeepKey | Yes | UNVERIFIED CANDIDATE | exact firmware matrix, P2WSH HTLC PSBT test, display/WYSIWYS, cancel/disconnect |
| BitBox01 | Yes | RESEARCH ONLY | lifecycle/security review first; no production assumption |

## Minimum test contract per device/firmware

No device may move from UNVERIFIED CANDIDATE to SUPPORTED until all applicable tests pass:

1. enumerate device and bind expected master fingerprint;
2. derive/read only public descriptor material;
3. display receiving/change address on device where supported;
4. sign exact funding PSBT after policy-gate validation;
5. sign exact redeem PSBT after policy-gate validation;
6. sign exact refund PSBT with CLTV locktime + sequence;
7. reject modified destination;
8. reject modified amount;
9. reject modified fee;
10. reject modified locktime/sequence;
11. reject non-SIGHASH_ALL;
12. reject wrong network;
13. reject wrong fingerprint/key origin;
14. user cancel produces no fallback signing;
15. disconnect during signing fails closed;
16. malformed signer response fails closed;
17. signer returns PSBT only; seed/private key is never exported;
18. recovery remains executable if the normal UI is unavailable;
19. exact firmware and adapter versions are recorded in evidence;
20. repeated test after firmware/adapter upgrade.

## Adapter policy

Preferred abstraction:

gpu.k.p2p Wallet Agent/client
→ signer policy gate
→ narrow external-signer adapter
→ HWI, vendor software, or future compatible adapter
→ hardware wallet

The settlement protocol MUST NOT depend specifically on HWI.

The adapter must be replaceable without changing:
- signed settlement terms;
- recovery bundle format;
- Bitcoin witness script;
- trade state machine;
- server APIs that do not need signer-specific data.

## Security boundaries

The Asset Exchange server never receives:
- device seed;
- private key;
- raw secret export;
- device PIN/passphrase;
- generic hardware-device command access.

Device fingerprints and public descriptors are not secrets, but they are still privacy-sensitive metadata and should not be logged unnecessarily.

## Current conclusion

No hardware-wallet family is production-supported yet.

The next evidence step is a mock external-signer protocol test followed by physical-device regtest tests on selected device/firmware combinations.
