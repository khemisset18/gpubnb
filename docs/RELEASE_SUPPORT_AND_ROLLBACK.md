# GPUbnb release support, provenance and rollback contract

Every promoted Host candidate must be supportable by identity, not by filename or recollection.

## Required support identity

A release-support manifest binds:

- product/Agent version;
- exact 40-character source commit;
- exact artifact filename;
- SHA-256 of the bytes distributed to owners;
- whether the promoted artifact is Authenticode-signed;
- release-compatibility protocol version;
- release channel;
- a previously verified rollback tag.

`dev`, short SHAs, missing hashes, missing compatibility versions and missing rollback targets are invalid release identities.

## Signing and hashing order

For signed Windows releases the final Authenticode signature is applied before the published SHA-256 is calculated. Support must verify the same final bytes that owners download. Re-signing an already-published binary creates a different artifact and therefore requires a new manifest/hash identity.

## Rollback

A rollback is not a generic way to silence an error. The target must be an already verified release with known provenance. Automatic rollback is allowed only after update policy proves the new installation failed its post-install health/identity gates; this manifest alone never authorizes automatic mutation.

The frozen physical baseline may remain a reference/last-resort qualification point, but a future production rollback target should normally be the immediately previous promoted, signed and verified release.

## Support workflow

When diagnosing an installation, support should first collect the privacy-safe Host report and release-support identity. These should answer, without collecting user files or secrets:

1. what exact software bytes were intended;
2. what source commit produced them;
3. whether code-signing was expected/present;
4. which component compatibility generation they belong to;
5. which known-good release is the rollback target.

Raw logs are a separate escalation path and require the privacy/redaction rules defined by the Host privacy contract.

## Promotion gate

Before public real-money promotion, release automation should generate and publish the support manifest alongside the checksums and independently verify it after publication. Until that workflow integration is complete, this tool is a contract/building block and must not be presented as proof that a public artifact has already passed signing or physical qualification.
