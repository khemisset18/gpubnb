# CI diagnostic

Commit: `7466695426204c0a3073400cf93874628bc47662`

- ✅ API npm ci
- ✅ Prisma generate
- ✅ Prisma migrate deploy
- ❌ API tests (exit 1)

```text
  duration_ms: 0.127197
  type: 'test'
  ...
# Subtest: invariant over sample durations
ok 41 - invariant over sample durations
  ---
  duration_ms: 3.476242
  type: 'test'
  ...
# Subtest: zero usage refunds the full amount
ok 42 - zero usage refunds the full amount
  ---
  duration_ms: 0.174807
  type: 'test'
  ...
# Subtest: 89.9 percent remains proportional
ok 43 - 89.9 percent remains proportional
  ---
  duration_ms: 0.172364
  type: 'test'
  ...
# Subtest: rejects invalid durations
ok 44 - rejects invalid durations
  ---
  duration_ms: 0.412136
  type: 'test'
  ...
# Subtest: one lamport never creates money
ok 45 - one lamport never creates money
  ---
  duration_ms: 0.186594
  type: 'test'
  ...
# Subtest: escrow expires one hour after booking end
ok 46 - escrow expires one hour after booking end
  ---
  duration_ms: 0.19693
  type: 'test'
  ...
# Subtest: booking digest is deterministic and domain separated
ok 47 - booking digest is deterministic and domain separated
  ---
  duration_ms: 1.803001
  type: 'test'
  ...
# Subtest: escrow PDA is deterministic
ok 48 - escrow PDA is deterministic
  ---
  duration_ms: 4.629599
  type: 'test'
  ...
# Subtest: heartbeat accepts NVIDIA with cudaVersion
ok 49 - heartbeat accepts NVIDIA with cudaVersion
  ---
  duration_ms: 2.673323
  type: 'test'
  ...
# Subtest: heartbeat accepts AMD without cudaVersion
ok 50 - heartbeat accepts AMD without cudaVersion
  ---
  duration_ms: 1.547987
  type: 'test'
  ...
# Subtest: heartbeat accepts Intel with gpuVendor INTEL
ok 51 - heartbeat accepts Intel with gpuVendor INTEL
  ---
  duration_ms: 0.35341
  type: 'test'
  ...
# Subtest: inventory accepts without nvidiaRuntimeAvailable
ok 52 - inventory accepts without nvidiaRuntimeAvailable
  ---
  duration_ms: 0.456902
  type: 'test'
  ...
# Subtest: inventory accepts with nvidiaRuntimeAvailable false
ok 53 - inventory accepts with nvidiaRuntimeAvailable false
  ---
  duration_ms: 0.228306
  type: 'test'
  ...
# Subtest: high-end machine receives an explainable AI score
ok 54 - high-end machine receives an explainable AI score
  ---
  duration_ms: 1.107669
  type: 'test'
  ...
# Subtest: missing requirements produce explicit incompatibility
ok 55 - missing requirements produce explicit incompatibility
  ---
  duration_ms: 0.182438
  type: 'test'
  ...
# Subtest: catalogue contains exactly thirteen unique workspaces
ok 56 - catalogue contains exactly thirteen unique workspaces
  ---
  duration_ms: 0.406328
  type: 'test'
  ...
# Subtest: counts only available intervals backed by a workload proof
ok 57 - counts only available intervals backed by a workload proof
  ---
  duration_ms: 0.703054
  type: 'test'
  ...
# Subtest: never validates more usage than the booking duration
ok 58 - never validates more usage than the booking duration
  ---
  duration_ms: 0.127177
  type: 'test'
  ...
1..58
# tests 58
# suites 0
# pass 57
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3731.961912

```
- ✅ API build
- ✅ API typecheck
- ✅ Agent install
- ✅ Agent compile
- ✅ Agent tests
- ✅ Rust contract tests
- ✅ Web syntax
- ✅ Devnet doctor
- ✅ Workspace manifest
- ✅ Shell syntax
