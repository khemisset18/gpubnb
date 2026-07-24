# CI diagnostic

Commit: `81ad0de747d2118ab908edaec74929e51306c805`

- ✅ API npm ci
- ✅ Prisma generate
- ✅ Prisma migrate deploy
- ❌ API tests (exit 1)

```text
  duration_ms: 0.134962
  type: 'test'
  ...
# Subtest: invariant over sample durations
ok 36 - invariant over sample durations
  ---
  duration_ms: 3.457887
  type: 'test'
  ...
# Subtest: zero usage refunds the full amount
ok 37 - zero usage refunds the full amount
  ---
  duration_ms: 0.190055
  type: 'test'
  ...
# Subtest: 89.9 percent remains proportional
ok 38 - 89.9 percent remains proportional
  ---
  duration_ms: 0.186668
  type: 'test'
  ...
# Subtest: rejects invalid durations
ok 39 - rejects invalid durations
  ---
  duration_ms: 0.421054
  type: 'test'
  ...
# Subtest: one lamport never creates money
ok 40 - one lamport never creates money
  ---
  duration_ms: 0.202377
  type: 'test'
  ...
# Subtest: escrow expires one hour after booking end
ok 41 - escrow expires one hour after booking end
  ---
  duration_ms: 0.216324
  type: 'test'
  ...
# Subtest: booking digest is deterministic and domain separated
ok 42 - booking digest is deterministic and domain separated
  ---
  duration_ms: 1.825494
  type: 'test'
  ...
# Subtest: escrow PDA is deterministic
ok 43 - escrow PDA is deterministic
  ---
  duration_ms: 5.044345
  type: 'test'
  ...
# Subtest: heartbeat accepts NVIDIA with cudaVersion
ok 44 - heartbeat accepts NVIDIA with cudaVersion
  ---
  duration_ms: 4.254453
  type: 'test'
  ...
# Subtest: heartbeat accepts AMD without cudaVersion
ok 45 - heartbeat accepts AMD without cudaVersion
  ---
  duration_ms: 0.732977
  type: 'test'
  ...
# Subtest: heartbeat accepts Intel with gpuVendor INTEL
ok 46 - heartbeat accepts Intel with gpuVendor INTEL
  ---
  duration_ms: 0.551779
  type: 'test'
  ...
# Subtest: inventory accepts without nvidiaRuntimeAvailable
ok 47 - inventory accepts without nvidiaRuntimeAvailable
  ---
  duration_ms: 0.749277
  type: 'test'
  ...
# Subtest: inventory accepts with nvidiaRuntimeAvailable false
ok 48 - inventory accepts with nvidiaRuntimeAvailable false
  ---
  duration_ms: 0.437165
  type: 'test'
  ...
# Subtest: high-end machine receives an explainable AI score
ok 49 - high-end machine receives an explainable AI score
  ---
  duration_ms: 1.457478
  type: 'test'
  ...
# Subtest: missing requirements produce explicit incompatibility
ok 50 - missing requirements produce explicit incompatibility
  ---
  duration_ms: 0.197739
  type: 'test'
  ...
# Subtest: catalogue contains exactly thirteen unique workspaces
ok 51 - catalogue contains exactly thirteen unique workspaces
  ---
  duration_ms: 0.419943
  type: 'test'
  ...
# Subtest: counts only available intervals backed by a workload proof
ok 52 - counts only available intervals backed by a workload proof
  ---
  duration_ms: 0.85803
  type: 'test'
  ...
# Subtest: never validates more usage than the booking duration
ok 53 - never validates more usage than the booking duration
  ---
  duration_ms: 0.138698
  type: 'test'
  ...
1..53
# tests 53
# suites 0
# pass 52
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3758.49681

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
