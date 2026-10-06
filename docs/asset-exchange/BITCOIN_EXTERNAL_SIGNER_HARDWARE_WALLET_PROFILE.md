# Bitcoin External Signer & Hardware Wallet Security Profile

Status: G6 PRE-INTEGRATION / REGTEST ONLY / NO REAL FUNDS

This profile defines the security boundary for signing Bitcoin settlement transactions with an external signer or hardware wallet.

## Architecture

The Asset Exchange server MUST NOT:
- hold the user's Bitcoin private keys;
- hold the hardware-wallet seed;
- invoke a hardware wallet attached to the production server;
- silently alter a PSBT after the user has approved its intent;
- treat HWI or another driver as an authority for settlement terms.

The signer boundary belongs in the user-controlled client / Wallet Agent / hardware-wallet environment.

Bitcoin Core 31.1 supports external signers through PSBT. Its external signer command is given a network and a master-key fingerprint, and Core checks that the fingerprint matches at least one PSBT input before invoking the signer.

## HWI status

HWI is an optional interoperability adapter, not a trust anchor.

Bitcoin Core documentation explicitly describes HWI as experimental and less reviewed than Bitcoin Core itself. Therefore:
- HWI MUST NOT be installed as a server custody component;
- version and artifact pinning are required before any packaged Wallet Agent integration;
- device-specific compatibility must be separately tested;
- vendor support does not imply gpu.k.p2p production approval.

## Pre-signer policy gate

Before a PSBT is handed to any external signer, the Wallet Agent/client MUST independently bind and validate:

- deployment ID;
- trade ID;
- settlement-terms digest;
- network;
- signer master fingerprint;
- transaction version;
- locktime;
- every input txid/vout;
- every input amount;
- every input scriptPubKey;
- every sequence;
- every output amount;
- every output scriptPubKey;
- output purpose (principal/change/refund/redeem/platform fee);
- exact fee;
- maximum authorized fee;
- SIGHASH_ALL;
- digest of the decoded PSBT representation.

Any mismatch is fail-closed before invoking the external signer.

## WYSIWYS

For funding/redeem/refund, the user-facing approval screen MUST show at minimum:
- action type;
- asset/network;
- principal amount;
- destination/refund address or script fingerprint;
- fee and maximum fee;
- refund height where applicable;
- trade ID;
- signer/device identity.

The visible values must be derived from the same validated signer intent that is compared to the decoded PSBT.

## Fingerprint rules

V1 uses the 4-byte master key fingerprint as an allow-listed identifier.

A fingerprint:
- is not a secret;
- is not sufficient by itself for authorization;
- MUST be combined with the authenticated local pairing and expected descriptor/key-origin policy;
- MUST be matched against PSBT derivation metadata by the signing stack.

Changing the expected fingerprint requires a new local administrative pairing/approval flow.

## Signer invocation

External signer invocation MUST:
- pass PSBT over stdin or another non-shell-constructed safe channel;
- avoid shell interpolation of user-controlled values;
- bind the target network explicitly;
- use an executable allow-list / pinned path in Wallet Agent;
- run without administrator privileges;
- have no generic shell command capability.

## Failure behavior

Signing MUST fail closed if:
- no signer is connected;
- multiple unexpected signers are connected;
- signer fingerprint mismatches;
- device rejects or user cancels;
- PSBT changes after approval;
- output or fee substitution is detected;
- sighash differs from ALL;
- network differs;
- refund locktime/sequence differs;
- signer returns an invalid or non-finalizable PSBT.

Failure to sign MUST NOT remove or weaken the refund/recovery path.

## Production evidence still required

Before hardware-wallet support can advance:
1. pinned HWI or vendor-adapter build, if used;
2. device support matrix by exact firmware/version;
3. BTC regtest signing on at least two independent device families where feasible;
4. cancel/reject/disconnect tests;
5. malicious/modified PSBT tests;
6. address-display verification;
7. upgrade/rollback tests for the Wallet Agent signer adapter;
8. external security review.

No hardware wallet is considered supported merely because HWI lists the vendor.
