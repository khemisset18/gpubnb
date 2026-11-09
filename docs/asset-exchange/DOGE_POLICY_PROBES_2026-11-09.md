# Dogecoin native policy probes — 9 November 2026

D2 remains BLOCKED. These are newly compiled diagnostic tests, not the D0-qualified executable, not a production node and not a network-load benchmark.

The existing pinned 1.14.9 source e0a1c157791544e818c901bd9341896965afbf9d contains GetDogecoinDustFee (dogecoin-fees.cpp), CTxMemPool::TrimToSize/GetMinFee (txmempool.cpp), and the actual admission gate (validation.cpp). prepare.py verifies the exact clean commit plus four upstream file digests, adds one test file and one Makefile test registration. It never changes these implementations.

The first test calls the real GetDogecoinDustFee at zero, threshold minus one, equality and plus one; checks additive per-output surcharge and OP_RETURN exemption. Threshold is explicitly checked against the native default 0.01 DOGE. This is necessary because sendrawtransaction disables the free-relay limiter; admission alone is not proof of this surcharge.

The second test uses upstream TestChain240Setup on private Regtest. It generates one ephemeral test key, mines 240 synthetic blocks in memory/local temporary data, signs one mature coinbase spend and proves normal standardness-enforced admission. It removes that spend, adds exactly one explicitly unchecked synthetic pressure entry, and invokes actual TrimToSize(0). It measures the exact rolling floor including incremental relay fee, then requires the same previously admitted signed spend to fail actual AcceptToMemoryPool with `mempool min fee not met`, not missing input or signature error. The pressure entry itself is not an admitted transaction and no realistic network saturation is claimed.

Native execution occurs only inside a new Linux network namespace with a single UP loopback interface, before loading the executable. No daemon, RPC server, P2P threads or wallet is launched. Build disables wallet, GUI, UPnP and ZMQ. Runner verifies executable SHA256, caps CPU at 180 seconds, address space at 2 GiB, file size at 64 MiB and wall time at 240 seconds. The workflow has a separate bounded build timeout. Environment is cleared. Only configuration/tool provenance and summarized Boost test output/metrics are artifacts; no keys, signed transaction hex, RPC dumps or node data are uploaded.

Five offline guards PASS before build: wrong commit, dirty source, altered implementation digest, same namespace and wrong executable digest. Exact test registration also applied successfully to a clean pinned worktree. Native result remains NOT_TESTED until the workflow completes; compilation is not execution evidence.

These probes add evidence for the two policy inventory items but cannot themselves promote full D2. They require review alongside original signed D0 runtime evidence and the remaining adversarial completion-plan requirements. No mainnet, real assets, financial activation, deployment or merge is authorized by this file.

## Verified native result: PASS for both probes

Run 42543052508 at e6bf021bded14f15b91fcb6dbc8e5137b4d60f21 completed successfully. Frozen harness 6e36f21539301519e8900f8c4d8af0db6efed699. Artifact 13642317311 SHA256 f9458f8bcb3e30a8771f924f20e22030880dda83490a768c90338acdc3a32766 independently matches upload digest; all internal observation hashes verified. Diagnostic executable SHA256 9d673ae720f6ebcb8d26cb6ee787c2418460735917a00037e3927a9f5c8bb8ce. The three implementation source hashes after compilation exactly match the original pinned source. GCC 11.4.0, Boost 1.74, OpenSSL 3.0.2 package 0ubuntu1.30 recorded.

Two selected cases and 26 assertions PASS. The other 246 upstream cases were intentionally not selected and are NOT_TESTED by this run. Soft-dust surcharge is 1,000,000 koinu below threshold, zero at/above it; two small spendable outputs charge 2,000,000 total, while OP_RETURN adds zero. The pressure entry occupies 960 bytes before forced eviction; native floor becomes 117,647,068,823 koinu/kB, requiring 18,470,589,805 koinu for the candidate that paid 100,000,000. The previously admitted signed candidate is rejected specifically with `mempool min fee not met` and no missing-input indication.

Namespace remains loopback-only before/after; exit code zero. This supplies measured native diagnostic evidence for soft_dust_reserve and dynamic_mempool_fee_floor. Forced eviction of one unchecked entry is deliberately bounded and is not organically accumulated 5-MB mempool pressure or a relay benchmark. The diagnostic build has distinct provenance from D0. Full D2 remains BLOCKED pending consolidated semantic evidence review and remaining broader adversarial cases. No original qualification gate or financial capability changed.

Bounded metric logs, source/binary hashes and toolchain record are committed under audits/evidence/doge-policy-20261109. The complete small build artifact remains locally and in original Actions storage. The temporary push trigger is removed; exact-branch manual dispatch retains the frozen harness comparison.
