# Isolated osslsigncode HTTPS hardening study

This directory is a reviewed, source-pinned build recipe, not an approved signing
tool or a change to GPUbnb's release policy. It runs only on the public repository's
GitHub-hosted Windows test runner and a dedicated work branch. No GPUbnb private
key or executable is supplied. No certificate store is imported or modified.

## Demonstrated upstream defect

Run 38658787497 used upstream osslsigncode 2.14, commit
`beec94e308d1a1e03ca17b05fe089d93c6303e90`, with the Windows x64 release binary.
On the OpenSSL >=3 transport, `http_tls_cb` configured only
`SSL_set_tlsext_host_name`. SNI selects a certificate but does not validate its
hostname. The SSL object had no expected hostname. Windows independently found
`RemoteCertificateNameMismatch` for `wrong.host.badssl.com`, while osslsigncode
received HTTP 405 from that server. This was an actual TLS authentication defect,
even though the HTTP error prevented a timestamp in that particular test.

Two additional fail-open paths existed: a missing/failed CA load let the request
continue without `SSL_VERIFY_PEER`, and `verify_callback` waived a missing CRL.
The build recipe removes both paths. Merely upgrading OpenSSL cannot repair an
application that never sets the expected hostname.

## Audited patch boundary

`tls-fail-closed.patch` changes the upstream transport and build configuration:

- Expected DNS SAN configured on the actual SSL connection with `SSL_set1_host`;
  SNI and hostname configuration return values checked before any handshake.
- No partial wildcard or Common Name fallback.
- Explicit CA and CRL files required; any load failure aborts before HTTP.
- Mandatory peer verification, TLS >=1.2 and a 30-second HTTP/TLS deadline.
- Certificate verification callback never overrides an error.
- Timestamp requests require HTTPS; disabling peer checks is rejected by the CLI.
- Maintained OpenSSL 3.5.9 LTS and zlib 1.3.2 built from pinned upstream sources;
  static linking, MSVC security flags preserved, fork version identified.

Full TLS certification-path, purpose, validity and hostname checks are enabled.
The existing `X509_V_FLAG_CRL_CHECK` policy is retained and made strict: it checks
the TLS leaf's revocation, and missing, inapplicable or expired CRLs fail. This
must not be described as native CRL checking of every certificate in the path.
The RFC 3161 TSA path is separately validated under the initial Windows roots,
with online revocation for all non-root certificates and no error waivers.

OpenSSL's portable C implementation (`no-asm`) avoids installing an additional
assembler. It changes optimization only; it does not turn off a protocol,
certificate, hostname, validity or revocation check. Upstream OpenSSL and zlib
tests must pass before the public-fixture probe starts. The upstream osslsigncode
signing suite is not claimed as executed: it uses its own signing keys and HTTP
fixture server. The targeted regression suite uses an already signed Microsoft
executable, then Windows, SignTool and the unchanged GPUbnb verifier.

## Test gates and provenance

Required negative controls are self-signed/wrong CA, wrong DNS name, expired peer
and HTTP 200 with `application/timestamp-reply` but invalid DER. A timeout,
HTTP 405 or an unrelated parsing error cannot satisfy a TLS rejection gate.
Additional gates reject missing CA, missing CRL, HTTP timestamps and modified PE
content. A successful HTTPS response is not sufficient to accept the artifact.

The positive probe checks the RFC 3161 imprint binding and SHA-256 algorithm,
exclusive critical TSA EKU, trusted TSA root, revocation, timestamp interval,
Windows `Valid`, SignTool `/pa /all /v /tw` exit 0, and unchanged primary signer,
signature bytes, signed content and signed attributes.

The workflow emits the source lock, patch digest, compiler versions and hashes,
actual OpenSSL version, PE architecture/security flags, dependency list, tool
SHA-256 and fixture before/after hashes. GitHub release hashes and pinned Git
objects are checked. Upstream PGP authentication and reproducible binary builds
are not claimed. The built tool is unsigned, isolated and deleted after testing.
No new artifacts or caches are uploaded by this workflow.

No standard GPUbnb verifier, worker/helper pin, gateway, Agent, lease,
authentication, isolation, suspension, billing or production setting is changed.
Technical proof is not authorization to sign, install, deploy, merge or test on
PC1/PC2. Provider approval and signing-key isolation remain independent gates.
