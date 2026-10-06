# gpu.k.p2p — Linux, Containers and Supply Chain Security Baseline v0

Status: SECURITY ARCHITECTURE / PRE-DEVELOPMENT / NO REAL FUNDS

## 1. Purpose

This document defines the baseline for Linux hosts, containers, CI/CD, build pipelines, artifact
integrity and software supply-chain security for gpu.k.p2p.

It complements:
- NETWORK_AND_DEPLOYMENT_ARCHITECTURE.md
- G0_ISOLATION_IAM_DATA_RECOVERY_PLAN.md
- WINDOWS_SECURITY_BASELINE.md
- THREAT_REGISTER.md

No Mainnet capability is authorized by this document.

## 2. Core security principle

Assume any single workload, dependency, CI step or third-party service can fail or be compromised.

The architecture must prevent one compromise from becoming:
- host root;
- Core compromise;
- production secret theft;
- signing-key theft;
- arbitrary production deployment;
- silent artifact substitution.

## 3. Host baseline

Production Linux hosts must use:
- supported distribution;
- automatic security updates or managed patching;
- minimal installed packages;
- no desktop environment;
- no unnecessary compilers/interpreters in production;
- hardened SSH policy;
- firewall;
- time synchronization;
- centralized security logging;
- file-system protections;
- monitored privileged access.

Direct production shell access should be exceptional and audited.

## 4. Root access

Normal application administration must not require direct root login.

Requirements:
- disable direct remote root login;
- use named operator identities;
- sudo only for explicit approved commands where practical;
- MFA/strong upstream access;
- short-lived privileged sessions;
- audit privileged operations.

Shared root passwords are forbidden.

## 5. SSH

If SSH exists:
- keys only;
- password login disabled for production where operationally possible;
- no root login;
- strong modern algorithms;
- source restrictions/VPN/bastion where applicable;
- idle timeout;
- audit logs;
- rotation/revocation procedure.

If managed infrastructure removes need for SSH, prefer no SSH exposure.

## 6. Container user model

Containers must run as non-root by default.

Requirements:
- explicit USER in Dockerfile;
- fixed application UID/GID where practical;
- no UID 0 runtime except reviewed exception;
- no setuid binaries unless explicitly required;
- no sudo inside application containers.

Any root exception requires written threat review.

## 7. Rootless runtime

Where the platform permits, prefer rootless container runtime or an equivalent non-root isolation
model.

Reason:
a compromised container-runtime control path should have less host privilege.

Rootless mode does not remove the need for:
- capability reduction;
- seccomp;
- AppArmor/SELinux;
- filesystem restrictions;
- network isolation.

## 8. Linux capabilities

Default target:
drop all capabilities.

Then add only capabilities proven necessary.

Typical web/API/worker services should not require:
- CAP_SYS_ADMIN;
- CAP_SYS_PTRACE;
- CAP_NET_ADMIN;
- CAP_SYS_MODULE;
- CAP_MKNOD;
- raw socket capabilities.

CAP_SYS_ADMIN is treated as near-root and forbidden for normal services.

## 9. Privileged containers

Forbidden in production:
- privileged: true;
- --privileged;
- host PID namespace;
- host IPC namespace;
- host network unless independently reviewed;
- mounting / as writable;
- mounting Docker socket;
- arbitrary host device access.

Any exception is a G0/G1 security review blocker.

## 10. Docker socket

Never mount:
- /var/run/docker.sock

into:
- web services;
- API services;
- settlement services;
- workers;
- watchers;
- admin UI.

Docker daemon control is equivalent to host-level compromise in many deployment models.

## 11. Filesystem

Preferred:
- read-only root filesystem;
- explicit writable tmp/cache mounts only;
- no writable application binary directories;
- no shared writable volume between unrelated services;
- no host filesystem mounts unless essential.

Writable paths must be documented.

## 12. Temporary storage

Use dedicated tmpfs/ephemeral storage where practical.

Requirements:
- size limits;
- no secrets written by default;
- cleanup on restart;
- no executable temp path where avoidable.

## 13. Seccomp

Use the container runtime default seccomp profile or a stricter reviewed profile.

Do not disable seccomp for convenience.

Sensitive services such as:
- ax-settlement;
- ax-rpc-gateway;
- ax-recovery

should be candidates for tailored syscall profiles after implementation stabilizes.

## 14. AppArmor / SELinux

Where the host platform supports it:
- enable mandatory access control;
- use confined profiles;
- prohibit unconfined sensitive workloads where avoidable.

Policy must restrict:
- filesystem;
- process execution;
- network;
- device access.

## 15. Process model

One primary responsibility per container.

Avoid:
- SSH daemon;
- cron daemon unless specifically needed;
- debugging tools;
- package managers used at runtime;
- multiple unrelated services.

Operational functions should be externalized.

## 16. Base images

Use minimal trusted base images.

Requirements:
- official/vendor-trusted source;
- pinned version;
- preferably pinned immutable digest for sensitive production builds;
- minimal packages;
- regular vulnerability scanning;
- documented update policy.

Do not use :latest in production.

## 17. Multi-stage builds

Use multi-stage builds to exclude:
- compilers;
- package caches;
- source credentials;
- test tools;
- build-only dependencies.

Final image contains only runtime requirements.

## 18. Build secrets

Never bake secrets into:
- Dockerfile;
- image layers;
- build args;
- source archive;
- npm config committed to repo;
- container labels.

Use supported ephemeral secret mounts / CI secret mechanisms.

After build, scan image history for accidental secrets.

## 19. Image signing

Production images should be signed.

Release metadata should bind:
- source commit;
- image digest;
- SBOM;
- provenance;
- build workflow identity;
- signature.

Deployment should verify immutable digest, not mutable tag alone.

## 20. SBOM

Every production release should generate an SBOM.

It should include:
- direct dependencies;
- transitive dependencies;
- system packages;
- container base image components where tooling supports it.

Archive SBOM with release evidence.

## 21. Provenance

Build provenance should record:
- repository;
- commit SHA;
- workflow identity;
- build time;
- builder;
- artifact digest.

Goal:
prove what source produced the deployed artifact.

## 22. Reproducibility

For fund-critical binaries/services, improve reproducibility where practical.

At minimum:
- locked dependencies;
- pinned toolchain versions;
- documented build environment;
- immutable artifact hashes.

If reproducible builds are not achievable, document sources of nondeterminism.

## 23. Dependency locking

Required:
- committed lockfiles;
- deterministic dependency resolution;
- no floating major versions in production;
- no install-from-unreviewed-git branch;
- no remote scripts piped to shell.

Examples forbidden:
curl URL | sh
wget URL -O- | bash

## 24. Package lifecycle review

Before adding a dependency review:
- license;
- publisher/maintainer;
- release cadence;
- open security issues;
- package age;
- transitive tree;
- install scripts;
- native-code usage;
- network behavior.

Fund-critical components should minimize dependencies aggressively.

## 25. npm lifecycle scripts

Treat package install scripts as code execution.

Requirements:
- review dependencies with postinstall/preinstall hooks;
- use CI policies to surface unexpected lifecycle changes;
- avoid unnecessary packages executing install-time scripts.

## 26. Rust/Cargo dependencies

For Rust components:
- Cargo.lock committed;
- audit advisories;
- inspect build.rs/proc macros for sensitive code;
- minimize unsafe code;
- document cryptographic crates and exact versions.

Crypto code requires separate expert review.

## 27. Python dependencies

If Python is used:
- exact version pinning;
- hashes where practical;
- isolated virtual environment/container;
- no production install from arbitrary git branches;
- vulnerability scanning.

## 28. GitHub Actions permissions

Every workflow must declare explicit permissions.

Default target:
contents: read

Add only required permissions per job.

Avoid repository-wide:
write-all.

No deployment job gets unrelated write permissions.

## 29. Third-party Actions

Third-party GitHub Actions must be pinned to full commit SHA.

Tags such as:
- @v1
- @v2
- @main

are not accepted for sensitive workflows.

Verify pinned SHA belongs to expected upstream repository.

## 30. GitHub Actions allowlist

Prefer an organization/repository policy restricting allowed Actions.

Categories:
- GitHub-owned;
- verified vendor actions;
- explicitly reviewed third-party actions.

New action requires supply-chain review.

## 31. OIDC for cloud deployment

Prefer GitHub OIDC federation over long-lived cloud access keys where supported.

Trust policy must constrain:
- repository;
- branch/tag;
- protected environment;
- workflow/job identity;
- expected event type where provider supports it.

OIDC permission alone does not authorize deployment; provider trust policy decides access.

## 32. Long-lived deployment credentials

If unavoidable:
- dedicated Asset Exchange credential;
- no Core deployment rights;
- short rotation interval;
- secret manager storage;
- protected environment;
- no PR exposure.

Compromise must not grant Core deploy capability.

## 33. Pull request security

Untrusted pull requests must not receive:
- production secrets;
- signing keys;
- cloud credentials;
- Mainnet RPC credentials;
- privileged service tokens.

Never use dangerous pull_request_target patterns without explicit review.

PR code is attacker-controlled input.

## 34. Fork security

Fork-based PRs:
- no secrets;
- read-only token;
- no production environment access;
- no artifact promotion without trusted post-merge rebuild.

Never promote an artifact built in an untrusted fork context directly to production.

## 35. Protected environments

Production deployment requires a protected environment.

Recommended:
- allowed branches/tags;
- manual approval for critical deployments;
- environment-specific OIDC conditions;
- environment-specific secrets;
- deployment audit.

Asset Exchange production environment must be independent from Core production environment.

## 36. Branch protection

For protected branches:
- required reviews;
- required CI;
- no force push;
- no branch deletion;
- signed commits/tags where policy supports it;
- CODEOWNERS for critical paths.

Sensitive paths include:
- settlement;
- recovery;
- CI workflows;
- deployment;
- cryptography;
- wallet agent;
- policy/admin.

## 37. Workflow file protection

Changes under .github/workflows are security-sensitive.

Require:
- dedicated review;
- permission diff review;
- action SHA review;
- secret/environment access review.

A benign application PR must not silently add deployment exfiltration.

## 38. Build once, promote same artifact

Preferred release model:
- trusted build produces immutable artifact;
- same digest promoted staging -> production;
- do not rebuild from source separately in production.

This reduces build-environment drift.

## 39. Artifact repository

Artifact registry must support:
- immutable digest;
- access control;
- retention;
- vulnerability metadata;
- signing/provenance attachments.

Delete/overwrite permissions should be restricted.

## 40. Vulnerability scanning

Scan:
- source dependencies;
- container images;
- base OS packages;
- IaC;
- secrets;
- licenses.

High/critical findings require triage before release.

Severity alone is not enough; assess exploitability and fund-impact.

## 41. Secret scanning

Use automated secret scanning in:
- commits;
- PRs;
- build logs;
- container layers where possible.

Any exposed production credential:
- revoke first;
- then investigate;
- do not merely delete from Git history and assume safe.

## 42. SAST

Static analysis should cover:
- injection;
- SSRF;
- path traversal;
- unsafe deserialization;
- authentication/authorization;
- cryptographic misuse;
- dangerous child-process execution.

SAST findings do not replace manual review.

## 43. DAST / API testing

Before production:
- API fuzzing;
- auth bypass attempts;
- BOLA/IDOR matrix;
- malformed payloads;
- rate-limit tests;
- WebSocket origin tests;
- SSRF tests.

Settlement endpoints require separate adversarial test corpus.

## 44. Container runtime network isolation

Use separate networks/security groups for:
- public edge;
- application;
- settlement;
- RPC/watchers;
- data;
- admin;
- recovery.

Default deny between zones.

A shared Docker network for all services is not acceptable for production.

## 45. No public databases

PostgreSQL and Redis must not be internet-accessible.

Access only from approved private workloads.

If managed provider exposes public endpoint technically:
- IP/firewall restriction;
- TLS;
- strong auth;
- provider private networking preferred.

## 46. Resource limits

Every workload should define:
- CPU limit/request;
- memory limit/request;
- file descriptor limits where relevant;
- queue bounds;
- timeout policy.

Resource exhaustion must not take down unrelated components.

## 47. OOM behavior

Define what happens if:
- API OOMs;
- watcher OOMs;
- settlement worker OOMs.

Crash recovery must be safe.

For settlement:
restart cannot duplicate fund-critical actions.

## 48. Health checks

Health endpoints must not leak:
- secrets;
- DB URLs;
- internal hostnames unnecessarily;
- stack traces;
- wallet data.

Separate:
- liveness;
- readiness;
- dependency status where needed.

## 49. Debug interfaces

Production must not expose:
- pprof;
- debug consoles;
- Node inspector;
- Python debugger;
- metrics endpoints without access control if sensitive.

Debug modes off by default.

## 50. Core dump policy

Core dumps may contain secrets.

For sensitive production services:
- disable or tightly control core dumps;
- encrypt/restrict diagnostic artifacts;
- no automatic public upload.

## 51. Environment variables

Environment variables are not inherently secret storage.

Use provider secret store/workload injection.

Never expose env dumps in:
- health output;
- error pages;
- CI logs;
- support bundles.

## 52. Shell access inside containers

Production application containers should not require interactive shell.

If emergency exec is available through platform:
- restricted operators;
- audited;
- time-bounded;
- no normal operational dependency.

## 53. Backup supply-chain risk

Backups and exported artifacts must be scanned and access-controlled.

Restoring an old vulnerable binary/configuration is a rollback risk.

Recovery procedures must restore data without silently reverting security controls.

## 54. Time synchronization

Fund-critical systems require reliable time.

Use trusted NTP/time source.

Monitor skew.

Expiry, challenge validation and timelock policy must not assume local clock is always correct.

## 55. Host firewall

Host/provider firewall:
- default deny inbound;
- only explicit service ports;
- no DB/Redis public ports;
- admin ingress restricted;
- RPC egress controlled.

Container network policy is additional, not replacement.

## 56. Kernel hardening

Where self-managed hosts exist, evaluate:
- current kernel;
- ASLR;
- protected symlinks/hardlinks;
- ptrace restrictions;
- unprivileged user namespace policy according to runtime model;
- kernel module restrictions;
- sysctl hardening;
- auditd.

Managed platforms may abstract host controls; document provider responsibility.

## 57. CIS benchmark use

Use CIS Docker Benchmark and relevant Linux/cloud/container benchmarks as hardening references.

Do not claim formal CIS compliance unless actually assessed and evidenced.

Benchmark controls may require tailoring to deployment architecture.

## 58. Kubernetes future rule

Do not introduce Kubernetes unless operational scale justifies it.

If introduced:
- separate namespaces/security boundaries;
- Pod Security;
- NetworkPolicy;
- workload identity;
- secrets manager;
- admission control;
- signed image verification;
- CIS Kubernetes benchmark review.

Complexity itself is attack surface.

## 59. Minimal orchestration preference

Early phases should prefer simpler isolated managed services over an unnecessarily complex cluster.

Security objective:
small understandable blast radius.

Do not adopt Kubernetes merely to appear enterprise.

## 60. Release manifest

Every release should have a manifest containing:
- release version;
- commit SHA;
- artifacts;
- artifact hashes;
- image digests;
- SBOM location/hash;
- provenance;
- signatures;
- test report IDs;
- security gate state.

## 61. Release blocker rules

Block release if:
- unpinned third-party Action in sensitive workflow;
- production secret available to PR build;
- unsigned production image/binary where signing required;
- critical unexplained vulnerability;
- dependency license blocker;
- Mainnet capability enabled before gate;
- Core credential reused;
- privileged container introduced without approved exception;
- Docker socket mounted into application workload.

## 62. Emergency release

Emergency security release still requires:
- reviewed source diff;
- trusted build;
- immutable artifact;
- signature;
- minimal tests;
- rollback/recovery plan;
- post-release full review.

Emergency does not mean bypass provenance.

## 63. Rollback security

Rollback may reintroduce a known vulnerability.

Release metadata must support:
- minimum safe version;
- blocked/revoked versions;
- configuration compatibility checks.

Do not automatically rollback settlement protocol without state compatibility review.

## 64. Key separation

Separate keys/identities for:
- code signing;
- image signing;
- CI OIDC;
- deployment;
- TLS;
- admin authentication;
- wallet protocols.

One key must not serve multiple unrelated trust purposes.

## 65. Signing key access

Human developers should not routinely possess production signing private keys.

Prefer:
- managed signer;
- HSM/KMS-backed signer;
- short-lived authorized signing operation;
- auditable approvals.

## 66. Release transparency

For commercial deployments, publish/verifiably expose where appropriate:
- release hash;
- version;
- publisher identity;
- signed artifact metadata;
- security notices.

This helps users detect substitution.

## 67. Dependency compromise response

If dependency compromise suspected:
1. freeze affected releases;
2. stop new deployment;
3. identify affected artifact hashes;
4. rotate exposed secrets;
5. rebuild from trusted dependency set;
6. compare behavior;
7. issue security advisory if needed;
8. preserve recovery availability.

## 68. CI compromise response

If CI compromised:
- revoke deployment credentials/OIDC trust as needed;
- invalidate signing access;
- stop automatic deploy;
- verify recent artifacts independently;
- rebuild trusted baseline;
- review workflow history;
- inspect Core isolation.

## 69. Image compromise response

If image registry compromised:
- deploy only by known verified digest;
- rotate registry credentials;
- compare signatures/provenance;
- quarantine unknown images;
- rebuild from trusted source.

## 70. Dependency update policy

Do not blindly auto-merge dependency updates into fund-critical code.

Use:
- automated PR creation;
- security checks;
- test suite;
- human review for sensitive libraries;
- cryptography-specific review.

## 71. Crypto dependency policy

For cryptographic libraries:
- mature implementation;
- active maintenance;
- public review;
- known test vectors;
- license compatibility;
- no custom fork without strong reason.

Version upgrades require regression vectors.

## 72. Infrastructure as Code

Infrastructure should become declarative where platform permits.

Benefits:
- reviewable changes;
- reproducibility;
- drift detection;
- security scanning.

IaC changes affecting:
- network;
- IAM;
- secrets;
- production deployment

require security review.

## 73. Drift detection

Periodically detect differences between:
- declared network rules;
- live firewall rules;
- IAM policy;
- deployed image digest;
- secret permissions.

Manual production drift is a risk.

## 74. Service ownership

Every service requires:
- owner;
- security classification;
- dependencies;
- secrets;
- network edges;
- runbook;
- alert policy;
- recovery behavior.

Unowned infrastructure is not production-ready.

## 75. Logging

Use structured allowlist logging.

Never log:
- seeds;
- private keys;
- wallet passwords;
- bearer tokens;
- session cookies;
- recovery secrets;
- raw signing material not intended for logging.

Log redaction must be tested.

## 76. Telemetry dependencies

Third-party telemetry SDKs are prohibited in settlement/recovery paths unless explicitly reviewed.

Avoid leaking:
- wallet addresses;
- trade identifiers;
- financial amounts;
- user identity correlation.

## 77. DNS / external services

Every external hostname used in production must have:
- owner;
- purpose;
- TLS requirement;
- failure behavior;
- trust classification.

No arbitrary runtime external integrations.

## 78. Supply-chain trust map

Trust nodes include:
- GitHub repository;
- GitHub Actions;
- action publishers;
- package registries;
- container registry;
- base image publishers;
- signing service;
- deployment platform;
- DB/Redis providers;
- RPC providers.

Each trust node needs:
- compromise scenario;
- detection;
- containment;
- recovery.

## 79. Required tests before G0/G1 pass

- workflow permission audit;
- third-party action pinning audit;
- PR secret exfiltration test;
- OIDC trust-condition test;
- container runs non-root;
- privileged-container scan;
- Docker socket scan;
- read-only filesystem test where configured;
- capability scan;
- image vulnerability scan;
- SBOM generation test;
- signature verification test;
- provenance verification test;
- Core credential denial test;
- network segmentation test.

## 80. Current repository implications

Existing Core deployment/configuration must remain untouched unless a separate explicit review permits
integration.

Asset Exchange must receive:
- its own deploy target;
- its own credentials;
- its own workflows;
- its own infrastructure state.

Do not retrofit Asset Exchange settlement into the existing Core Docker image.

## 81. Initial implementation recommendation

Before executable marketplace services:
1. define isolated package/service directories;
2. define CI path filters;
3. add security linting for forbidden Core imports;
4. add dedicated container definitions;
5. enforce non-root runtime;
6. add dedicated test-only local infrastructure;
7. keep all Mainnet flags absent/disabled.

## 82. Security acceptance rule

No infrastructure control is considered implemented because it exists in documentation.

It must be:
- configured;
- negatively tested;
- observed;
- recorded as evidence.

## 83. Current status

Linux/host baseline: DRAFTED.
Container baseline: DRAFTED.
Supply-chain baseline: DRAFTED.
CI/CD implementation: NOT STARTED.
Production deploy: NOT PROVISIONED.
Mainnet: FORBIDDEN.

## 84. Revalidation rule

Before production, revalidate:
- Docker security guidance;
- GitHub Actions secure-use guidance;
- OIDC provider guidance;
- CIS Docker/Linux benchmark versions;
- deployment-provider security model.

Platform security assumptions change over time.
