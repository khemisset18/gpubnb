# GPUbnb Asset Exchange — Threat Model v0

Status: WORKING DRAFT / PRE-DEVELOPMENT

## Security objective

For every supported settlement protocol, an honest participant must be able to reach a safe
terminal outcome (completed or refunded) under the protocol's documented assumptions, without
requiring GPUbnb to possess their private keys.

## Assets to protect

- user funds and recovery rights;
- signed trade terms;
- wallet ownership proofs;
- temporary swap secrets and adaptor material;
- administrative authority;
- mode/policy configuration;
- chain/risk registry;
- release/update integrity;
- user privacy and identity linkage;
- audit/event history.

## Trust boundaries

Treat as potentially hostile or fallible:

- browser;
- wallet extension/provider;
- counterparty;
- blockchain RPC;
- explorer;
- public P2P peer;
- token/smart contract;
- third-party dependency;
- CI runner;
- build/update channel;
- administrator session;
- employee/operator;
- database/network/cache;
- clock/time source.

## Critical threat classes

### Trade integrity
- signed terms changed after authorization;
- replay of offer/accept/cancel messages;
- duplicate fills;
- accept/cancel races;
- wrong network or asset identity;
- amount/decimal/overflow bugs;
- stale or already-committed funds.

### Settlement
- incorrect timelock ordering;
- reorg after apparent confirmation;
- fee spikes / non-relayable transactions;
- transaction pinning / RBF / CPFP failures;
- double-spend;
- chain halt;
- crash between broadcast and durable persistence;
- duplicated worker execution;
- missing refund path.

### Wallet / signing
- malicious injected provider;
- account or chain switching;
- phishing;
- localhost wallet-agent abuse;
- DNS rebinding;
- secret leakage in logs/core dumps;
- compromised updater.

### Chain / asset
- consensus vulnerability;
- malicious or upgradeable token;
- pause/freeze/blacklist/delegate/hook changes;
- dishonest or stale RPC;
- unsupported fork/hardfork;
- privacy leakage through public infrastructure.

### Application / API
- XSS;
- CSRF;
- BOLA/IDOR;
- SSRF;
- WebSocket hijacking;
- resource exhaustion;
- business-flow automation/spam;
- Unicode/confusable asset impersonation.

### Administration
- stolen admin session;
- weak MFA;
- unsafe mode transition;
- stale admin privileges;
- policy/risk-registry tampering;
- kill switch disabling refund/recovery.

### Supply chain
- malicious dependency;
- compromised GitHub Action;
- unpinned build tool;
- artifact substitution;
- rollback/freeze attack in desktop agent updates;
- incompatible third-party license.

## Absolute no-go conditions

Real funds are forbidden if any of the following is true:

- server can obtain user seed/private key;
- trade-critical parameters can mutate after signature;
- blockchain amounts use floating point;
- refund/recovery depends solely on GPUbnb availability;
- one RPC/explorer is the sole fund-critical oracle;
- mode switching can strand an active trade;
- Asset Exchange shares core GPUbnb financial/storage blast radius;
- protocol has no crash-after-broadcast recovery strategy;
- protocol has no reorg and fee-spike tests;
- smart-contract/cryptographic settlement lacks independent review;
- release/update provenance and integrity are not verifiable.

## Required next pass

This document must be expanded into per-component entries containing:

- threat ID;
- attacker;
- preconditions;
- exploit path;
- impact;
- likelihood;
- prevention;
- detection;
- recovery;
- mandatory regression/adversarial test;
- residual risk;
- security gate blocking release.
