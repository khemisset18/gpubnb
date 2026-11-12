# Gitian signed assertion check — offline only

`verify_gitian.py` does **not** compile or execute Litecoin, access a
network, generate a wallet, sign a transaction or activate settlement.

It requires two complete local Gitian assertions, their binary detached
OpenPGP signatures, an isolated public-key keyring and two independently
authenticated full 40-hex fingerprints. It checks:
- each detached GPG signature, including explicit expiration/revocation
  statuses (even if GPG returns exit code zero);
- exact source Git commit `ec1b6489a900d09cf5991e220dce089c77a232a2`;
- exact Linux release profile and archive SHA-256;
- full output-manifest equality between the two signed assertions.

The Gitian repository ref is fixed to
`257e8c5e128c40091b9fcd0f7d2327587d04742d`.
The two claims were published under `davidburkett38` and `losh11`.
The public security policy at `litecoin-project/litecoin/SECURITY.md`
lists fingerprints:
- David Burkett: `D35621D53A1CC6A3456758D03620E9D387E55666`;
- Loshan T: `C0921846FED0BF4CF28BE1D73B2A6315CD51A673`.

An official-source key is not independently authenticated. Both signed
assertions matching a hash is **not** proof that two independent rebuilds
were performed by independent hosts/operators. Missing trust roots,
expired keys, or divergent output manifests MUST fail closed. Even two
cryptographically valid assertions remain `L0_PARTIAL`, never L0 PASS.

Run independently of native Litecoin:

```bash
python3 asset-exchange/qualification/litecoin/l0/verify_gitian.py \
  --david-assertion /read-only/david/litecoin-core-linux-0.21-build.assert \
  --david-sig /read-only/david/litecoin-core-linux-0.21-build.assert.sig \
  --losh-assertion /read-only/losh/litecoin-core-linux-0.21-build.assert \
  --losh-sig /read-only/losh/litecoin-core-linux-0.21-build.assert.sig \
  --trusted-keyring /read-only/builders.gpg \
  --david-fingerprint D35621D53A1CC6A3456758D03620E9D387E55666 \
  --losh-fingerprint C0921846FED0BF4CF28BE1D73B2A6315CD51A673
```

This is candidate Gitian attestation evidence, not a substitute for a
separately reproduced source build.

## Observed current public key candidate (2026-11-12)

Earlier Gitian run 43125743269 rejected the archived Loshan key
(`KEYEXPIRED`, `EXPKEYSIG`). A second *public distribution service*,
`keys.openpgp.org`, supplied an OpenPGP certificate with the **same
full 40-hex fingerprint**, and GnuPG imported five additional key
signatures into its isolated keyring. The final GPG statuses for
both detached builder assertions became `GOODSIG` and `VALIDSIG`
without expiration/revocation rejects.

Exact observed downloaded candidate bytes SHA-256:
`027f0165865fcbcc53e3d09ee80251cca7da7a29b198fb31ea5b2c357bbbc3bf`.
Independent Gitian assertion verification passed in run 43127645875,
artifact 13903636677. The CI now requires this exact key file digest
and the six input digests; changes are BLOCKED pending human review.

A keyserver is a **delivery channel, not an authority vouching for the
builder's human identity**. No out-of-band authentication, independent
source rebuild or audit happened. Result is
`L0_PARTIAL_SIGNED_GITIAN_ASSERTIONS_ONLY` and
`l0Qualified=false`; never permit financial activation.
