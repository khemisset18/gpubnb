# Anchor SDK compatibility qualification

This candidate selects the published `anchor-lang 1.2.2` and its Solana SDK
interfaces. It removes Borsh 0.10.4 from all five original dependency parents.
The financial program source remains byte-identical; its SHA256 is
`ffaa27c11cc7873282a85b05f2cfc0bcd8a6b8baba3154575596225b5faa8b41`.
No instruction, account, financial term, deployment or network is added.

`source-pins.json` binds the complete financial dependency closure, source and
test files, the existing independently reconstructed recovery backport, and the
separate private VM tool. The old Anchor module no longer re-exports the recovery
wrapper, so the existing public recovery test now names that same vetted SDK
wrapper explicitly. Borsh 1 reports the same pre-element ZST refusal with
`InvalidData`; the regression still requires zero element-deserializer calls.

The host comparison checks 38 exact receipts against Anchor 0.31.1, covering all
instruction/account/event bytes, account privileges/order, discriminators, PDA
derivation, error codes and the System transfer encoding. The candidate runs
17 host tests, including the unchanged 1,636 public recovery cases. Rust harness
prefixes and Windows line endings do not remove receipts from qualification.

The private runtime loads the actual SBF ELF and requires its SHA256. Six cases
exercise all 11 GPUbnb instructions, actual System Program CPI with execution
logs/compute units, rent checked independently, full account snapshots on
refusal, funding/refund, full/partial settlement, dispute/admin authority, pause,
invalid signatures, expired blockhashes and identical signed-transaction replay.
Every value and keypair is synthetic and stays in an in-memory VM. Signature and
blockhash verification remain active and are challenged by negative tests.

The VM uses LiteSVM 0.18.2's standard builtins/sysvars and pinned feature snapshot.
GPUbnb does not call the optional precompile extension. That extension is not
added to this qualification tool, and **precompiles are NOT QUALIFIED**. Its
historical experimental profile pulled legacy Dalek/Rand dependencies; those
findings were preserved and investigated. Transaction signature verification
uses the separate maintained Solana verification path. No scanner ignore,
severity reduction, dependency rename or removed lockfile is used.

Run with Rust 1.97.1, Python 3.12 and fresh output directories:

```sh
python prototypes/anchor-sdk-migration/qualify.py /path/to/new-host-evidence --mode host
python prototypes/anchor-sdk-migration/qualify.py /path/to/new-sbf-evidence --mode sbf
```

The SBF mode verifies both official tool archive hashes, builds baseline and
candidate with the same pinned SBF v0 tools, and executes the six VM cases against
each. Its output contains ELF hashes, source/lock identities and native logs.
The unused build helper keypair is deleted and never selected for artifact
upload. The workflow runs on the explicit private qualification branch and has
read-only repository permissions. These are internal compatibility results;
network consensus, hardware, optional precompiles and external certification are
outside this procedure.
