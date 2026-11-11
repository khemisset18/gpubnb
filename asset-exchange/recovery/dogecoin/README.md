# Standalone DOGE private-Regtest recovery

This component verifies and retransmits an already-signed refund without an Exchange API, database or signing key. It supports only the pinned Dogecoin1.14.9 legacy P2SH Regtest profile. Financial activation remains disabled.

Build one reproducible Python zipapp:

```bash
python3 asset-exchange/recovery/dogecoin/package.py /new/path/doge-recovery.pyz
python3 -I /new/path/doge-recovery.pyz inspect --bundle /safe/bundle.json --bundle-sha256 TRUSTED_RECEIPT_SHA256
```

The bundle receipt must be retained independently before funding. A digest taken only from an attacker-controlled bundle is not authentication. Bundle creation is exclusive, fsyncs file and parent directory, and reads back verified bytes before returning its receipt.

The zipapp includes only named public source modules and a SHA256 inventory. It imports no Exchange backend. OpenSSL performs public-key signature verification; no private key generation or signing operation is exposed by the recovery CLI. The pinned D0 RPC client executable and a private local-node configuration are supplied separately for online operations.

`observe` and `rebroadcast` require the exact authorization AUTHORIZE_DOGE_RECOVERY_PRIVATE_REGTEST, an already-created distinct loopback-only Linux namespace, the original parent namespace identifier, the verified D0 dogecoin-cli executable, a private RPC data directory and a bounded RPC port. The CLI checks network/genesis/version/BIP65 and private peers before trusting observations.

Each bundle binds actual serialized funding outputs, strict HTLC roles, one to eight signed SIGHASH_ALL refunds, destination, retained value, fee ceiling, lock and sequence. The common refund policy module always verifies ECDSA signatures and rejects noncanonical encodings. All monetary JSON fields are canonical decimal strings in koinu. No wallet seed/private key is an allowed bundle field.

Before rebroadcast, all ladder transaction IDs are checked. A confirmed refund is idempotent. If a refund is already pending and covers the current fee floor, the CLI re-relays those exact bytes even when the floor has fallen and a cheaper variant would now qualify. It never switches a pending variant because sequence0xfffffffe is not opt-in RBF. If all previous variants are absent and the funding UTXO is available, the CLI selects the cheapest pre-signed variant covering the observed local floor. Beyond the finite ladder ceiling it refuses; it cannot create a signature without the signatory.

Active block hashes are rechecked rather than trusting a confirmation count alone. Observations are journalled atomically and a confirmed-to-pending transition is labelled REORGED. Every result keeps automaticSettlement=false. A single trusted node observation does not establish an adversarial multi-source quorum or permanent finality.

`cleanroom.py` is a laboratory adapter, not a runtime dependency of the zipapp. It copies only the package, public bundle/receipt, pinned RPC client and ephemeral node-B RPC credentials into a separate directory. A distinct mount namespace hides the Exchange repository, node-A state and original signing-key directory before the child Python process starts. Only the original Actions artifact may retain detailed public experiment logs; credentials and private directories are excluded. This demonstrates a distinct isolated environment, not a second physical machine.

Local validation:16 recovery tests, including a reproduced-and-fixed falling-fee pending-refund regression, real public-signature verification, corrupted/missing bundle refusal, fee coverage, pending non-RBF refusal, confirmation/reorg state, durability errors and a reproducible standalone -I zipapp from an empty working directory. Native runs43052066409 and43054425427 proved backend-hidden recovery, multi-node confirmation/reorg restoration and fee selection after native rejection without signing keys. The additional native re-relay of a higher-fee pending refund through the lower-fee node is prepared for the next manual run.
