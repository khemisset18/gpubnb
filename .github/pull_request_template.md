## Summary

Describe the user-visible or operational change and the trust boundary it affects.

## Validation

- [ ] Relevant unit/integration tests pass.
- [ ] New failure paths are fail-closed.
- [ ] No secret, token, credential, signing material or renter/provider data is logged.
- [ ] Database migrations are backward-safe and authority-preserving.
- [ ] GitHub Actions remain pinned to immutable commit SHAs.
- [ ] Release/build changes preserve provenance, checksums and signature verification.
- [ ] Windows-native changes preserve UUID -> LUID -> display -> capture -> NVENC fencing.
- [ ] Cleanup/reconnect behavior was considered and tested where applicable.

## Security review

State explicitly whether this changes authentication, authorization, session isolation, billing, update/release trust, GPU identity, input/media access, or privileged Windows code.
