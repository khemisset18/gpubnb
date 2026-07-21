# Mainnet evidence bundle

Populate with independently verifiable evidence:
- `external-audit.pdf` and remediation report;
- `multisig.json`: vault address, owners' public keys, threshold, setup transactions;
- `program.json`: program ID, deployment transaction, upgrade authority, audited `.so` SHA-256;
- `pentest.pdf`: API, host and sandbox scope/results;
- `ci.json`: release commit and successful CI run URL/identifier;
- `incident-drill.md`: dated recovery exercise.

The gate must remain NO-GO when evidence is absent. Never fabricate these files.
