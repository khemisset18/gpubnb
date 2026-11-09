# Dogecoin native policy probes — 9 November 2026

D2 remains BLOCKED. These are newly compiled diagnostic tests, not the D0-qualified executable, not a production node and not a network-load benchmark.

The existing pinned 1.14.9 source e0a1c157791544e818c901bd9341896965afbf9d contains GetDogecoinDustFee (dogecoin-fees.cpp), CTxMemPool::TrimToSize/GetMinFee (txmempool.cpp), and the actual admission gate (validation.cpp). prepare.py verifies the exact clean commit plus four upstream file digests, adds one test file and one Makefile test registration. It never changes these implementations.

The first test calls the real GetDogecoinDustFee at zero, threshold minus one, equality and plus one; checks additive per-output surcharge and OP_RETURN exemption. Threshold is explicitly checked against the native default 0.01 DOGE. This is necessary because sendrawtransaction disables the free-relay limiter; admission alone is not proof of this surcharge.

The second test uses upstream TestChain240Setup on private Regtest. It generates one ephemeral test key, mines 240 synthetic blocks in memory/local temporary data, signs one mature coinbase spend and proves normal standardness-enforced admission. It removes that spend, adds exactly one explicitly unchecked synthetic pressure entry, and invokes actual TrimToSize(0). It measures the exact rolling floor including incremental relay fee, then requires the same previously admitted signed spend to fail actual AcceptToMemoryPool with `mempool min fee not met`, not missing input or signature error. The pressure entry itself is not an admitted transaction and no realistic network saturation is claimed.

Native execution occurs only inside a new Linux network namespace with a single UP loopback interface, before loading the executable. No daemon, RPC server, P2P threads or wallet is launched. Build disables wallet, GUI, UPnP and ZMQ. Runner verifies executable SHA256, caps CPU at 180 seconds, address space at 2 GiB, file size at 64 MiB and wall time at 240 seconds. The workflow has a separate bounded build timeout. Environment is cleared. Only configuration/tool provenance and summarized Boost test output/metrics are artifacts; no keys, signed transaction hex, RPC dumps or node data are uploaded.

Five offline guards PASS before build: wrong commit, dirty source, altered implementation digest, same namespace and wrong executable digest. Exact test registration also applied successfully to a clean pinned worktree. Native result remains NOT_TESTED until the workflow completes; compilation is not execution evidence.

These probes add evidence for the two policy inventory items but cannot themselves promote full D2. They require review alongside original signed D0 runtime evidence and the remaining adversarial completion-plan requirements. No mainnet, real assets, financial activation, deployment or merge is authorized by this file.
