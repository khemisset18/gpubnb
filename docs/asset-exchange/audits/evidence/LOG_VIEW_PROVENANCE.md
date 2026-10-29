# Lossless raw evidence and normalized log views

Two newly retained text logs contained trailing whitespace emitted by their
original processes. The strict P2P diff gate correctly rejected five lines.
No gate or whitespace policy is changed. The original bytes are retained in
`.log.original.gz` (deterministic gzip, mtime 0); the `.log` is explicitly a
normalized reading view. `log-normalization.json` records original and view
SHA-256, changed line numbers and the exact rule. Decompression must recover
the original digest, not merely two equal normalized outputs.

D1's original artifact manifest is retained byte-for-byte as
`doge-d1-20261029/SHA256SUMS.original-artifact`. Its daemon-console.log entry
is checked against the decompressed original. Other original entries remain
unchanged. The new SHA256SUMS covers current persisted representations and
includes the original manifest. This is an explicit representation update,
not a replacement of an official D0 hash or trust manifest. The original
GitHub D1 ZIP digest and all RPC/identity evidence are unchanged.

The offline regression test verifies each conversion and the complete original
D1 member manifest. No Dogecoin binary or blockchain operation is executed.
