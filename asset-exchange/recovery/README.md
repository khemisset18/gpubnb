# asset-exchange-recovery

Status: G3/G5 PRE-MAINNET / NO REAL FUNDS.

This module implements a portable encrypted recovery-bundle foundation that can be used outside the main gpu.k.p2p frontend/API.

## Security properties

- AES-256-GCM using Node/OpenSSL standard implementation;
- random 96-bit nonce per encryption;
- fixed domain-separated authenticated data;
- 128-bit authentication tag;
- versioned envelope and payload;
- deployment ID bound inside authenticated ciphertext;
- explicit artifact allow-list;
- wallet seed/private key/spend key/mnemonic/password fields rejected;
- recovery key is supplied by the caller and never serialized;
- no password-based KDF is invented here.

## Key ownership

The 32-byte recovery encryption key MUST remain user-side, for example in a hardware-backed client/Wallet Agent or a user-controlled secure export flow.

The Asset Exchange server MUST NOT:
- generate a wallet seed;
- receive the user's wallet private keys;
- escrow the recovery encryption key as a substitute for the user;
- log bundle plaintext or the encryption key.

A production UX for backing up the recovery key requires a separate reviewed design.

## Allowed artifacts

Current bundle artifact types are limited to recovery/public transaction material:
- SIGNED_REFUND_TX
- REFUND_PSBT
- LOCK_TX
- LOCK_TXID
- LOCK_SCRIPT
- REDEEM_TX_TEMPLATE
- CHAIN_RECOVERY_RECIPE

These formats do not authorize settlement by themselves. Chain-specific validation remains mandatory.

## Not yet authorized

- Mainnet recovery;
- final Bitcoin HTLC byte templates;
- secret-preimage storage;
- wallet private-key storage;
- password-derived recovery keys;
- server-side custody.

The bundle is a cryptographic container, not proof that the enclosed recovery transaction is safe.
