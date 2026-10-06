# gpu.k.p2p — Windows Security Baseline v0

Status: SECURITY ARCHITECTURE / PRE-DEVELOPMENT / NO REAL FUNDS

## 1. Purpose

This document defines the Windows security baseline for:

- the future local Asset Exchange Wallet Agent;
- privileged administrator workstations;
- security/recovery operator workstations;
- Windows-based test environments used for fund-critical protocol validation.

It is based on current Microsoft platform capabilities and must be revalidated against current
Microsoft guidance before production release.

This document does not authorize Mainnet settlement.

## 2. Core principle

Windows endpoint security is defense in depth.

No Windows feature is treated as a substitute for:

- non-custodial protocol design;
- hardware wallets where appropriate;
- cryptographic transaction verification;
- signed immutable terms;
- application-level authorization;
- network isolation;
- independent recovery.

Assume the browser and endpoint can be attacked.

## 3. Security tiers

### Tier W0 — Developer workstation

Purpose:
- ordinary development;
- no production secrets;
- no Mainnet signing authority.

Required:
- supported Windows version;
- automatic security updates;
- Microsoft Defender Antivirus or equivalent;
- firewall enabled;
- no production private keys;
- no production admin session persistence.

### Tier W1 — Wallet Agent user workstation

Purpose:
- local user-side signing integration.

Required:
- signed wallet-agent binaries;
- loopback-only listener;
- authenticated browser pairing;
- origin binding;
- least privilege;
- protected local configuration;
- updater verification;
- no seed/private-key export API.

Recommended:
- TPM-backed machine keys when suitable;
- App Control / Smart App Control compatibility;
- memory integrity where compatible;
- Defender/EDR active.

### Tier W2 — Privileged admin/security workstation

Purpose:
- policy changes;
- mode changes;
- production configuration;
- incident response.

Required:
- dedicated account;
- phishing-resistant WebAuthn/FIDO2 or hardware-backed Windows Hello where possible;
- full-disk encryption;
- Credential Guard/VBS where supported;
- application control;
- ASR policy;
- Defender/EDR;
- firewall;
- no daily personal use;
- no consumer browser extensions;
- no direct wallet seed handling.

### Tier W3 — Release/signing workstation or signing service

Purpose:
- code signing / release integrity.

Preferred:
- managed signing service rather than exportable local certificate private keys.

If local signing is unavoidable:
- dedicated hardened workstation;
- hardware-backed key where possible;
- no web browsing/email;
- application allowlisting;
- separate operator identity;
- audit trail.

## 4. Local Wallet Agent threat model

Threats include:

- malicious website attempting localhost requests;
- DNS rebinding;
- browser extension compromise;
- local malware;
- process injection;
- DLL search-order hijacking;
- malicious updater;
- downgrade attack;
- tampered binary;
- arbitrary file-read abuse;
- shell-command abuse;
- privilege escalation;
- stolen pairing token;
- replayed request;
- request confusion between origins;
- wallet/account switching;
- signing transaction different from what user reviewed.

The Wallet Agent must assume that "localhost" is not automatically trusted.

## 5. Loopback-only service

Wallet Agent should bind only to:

- 127.0.0.1;
- optionally ::1 after equivalent security validation.

Do not bind to:

- 0.0.0.0;
- LAN interfaces;
- public interfaces.

Binding to loopback is necessary but not sufficient.

## 6. Browser-to-agent pairing

Required controls:

- explicit user-initiated pairing;
- high-entropy pairing secret;
- short-lived challenge;
- origin binding;
- session binding;
- replay protection;
- expiry;
- user-visible confirmation of the requesting site;
- revocation capability.

A random web page must not be able to call the Wallet Agent merely because it can reach localhost.

## 7. Origin security

The agent must maintain an explicit allowlist of approved origins.

For production, origin should bind to the exact approved gpu.k.p2p HTTPS origin.

Reject:

- missing Origin when browser context requires it;
- arbitrary localhost web origins;
- file://;
- data:;
- untrusted browser-extension origins;
- wildcard origins.

CORS must not be permissive.

Do not use Access-Control-Allow-Origin: * for signing endpoints.

## 8. DNS rebinding controls

Do not rely only on hostname checks.

Controls:

- bind to numeric loopback;
- validate Host/Origin independently;
- reject non-loopback destination context;
- use pairing secret independent from network location;
- avoid accepting arbitrary browser-provided callback URLs;
- test IPv4, IPv6 and alternate hostname forms.

## 9. Method allowlist

Wallet Agent should expose narrowly scoped methods.

Examples:

- getCapabilities
- listApprovedWallets
- getPublicAddress
- requestOwnershipProof
- signCanonicalOffer
- signCanonicalAccept
- signPreparedTransaction
- getTransactionStatus

Forbidden methods:

- exportSeed
- exportPrivateKey
- exportWalletFile
- executeShell
- runCommand
- readArbitraryFile
- writeArbitraryFile
- loadArbitraryDLL
- installPluginFromURL

## 10. Principle of transaction intent

The Wallet Agent must never sign opaque arbitrary bytes merely because the web application requests
it.

Where technically possible, the agent should parse and display:

- network;
- asset;
- amount;
- destination;
- lock/redeem/refund role;
- fee;
- timelock;
- transaction identifier or canonical intent hash;
- protocol version.

If parsing/validation is impossible for a signing method, the residual risk must be explicit.

## 11. Windows Hello / WebAuthn

Windows exposes WebAuthn APIs that can use Windows Hello or FIDO2 security keys for passwordless,
phishing-resistant authentication.

Use cases for gpu.k.p2p:

- privileged admin reauthentication;
- policy changes;
- mode switch approval;
- RPC/contract configuration changes;
- security-sensitive recovery operations.

Do not reuse the normal user web session as sufficient proof for critical admin actions.

## 12. TPM-backed keys

Windows CNG provides the Microsoft Platform Crypto Provider for TPM-backed key storage.

Potential gpu.k.p2p uses:

- device pairing identity;
- local agent device identity;
- admin-device attestation/signing keys where design supports it;
- encryption key wrapping;
- release/operator device authentication.

Rule:

TPM-backed keys are for application/device security keys.

They are not automatically substitutes for blockchain wallet signing schemes or hardware wallets.

Do not force unsupported blockchain private keys into CNG if the cryptographic algorithm or wallet
security model does not fit.

## 13. DPAPI

Windows DPAPI may be used for selected local secrets such as:

- pairing credentials;
- local session material;
- encrypted configuration secrets;
- local cache keys.

DPAPI usually binds protection to the same Windows user and machine context.

Important limitations:

- DPAPI protects stored data, not data after the legitimate process decrypts it;
- malware running as the same user may still attack the application;
- DPAPI is not a reason to store wallet seeds unnecessarily.

Rule:

Never store a blockchain seed just because DPAPI is available.

## 14. Long-lived application keys

Where Windows-native application keys are needed, prefer CNG key isolation / hardware-backed
providers when compatible.

Avoid raw private-key files.

Keys should be non-exportable where the use case allows it.

## 15. Code signing

Every production Wallet Agent binary, installer, DLL and updater component must be signed.

Required:

- consistent verified publisher identity;
- SHA-256;
- timestamping;
- signature verification before installation/update;
- reject modified artifacts;
- retain artifact hashes and provenance.

Self-signed certificates are test-only.

Production distribution must use a publicly trusted signing path or approved enterprise trust model.

## 16. MSIX consideration

MSIX is a candidate packaging format for the Windows Wallet Agent.

Benefits to evaluate:

- signed package requirement;
- cleaner install/uninstall;
- package identity;
- managed distribution;
- integration with Windows deployment controls.

Packaging choice must still be evaluated against:

- localhost service requirements;
- auto-start/service model;
- hardware-wallet integrations;
- browser communication;
- update requirements.

Do not choose MSIX solely for marketing reasons.

## 17. SmartScreen / Smart App Control

Unsigned production binaries are unacceptable.

SmartScreen reputation and Smart App Control can add another protection layer.

Operational implications:

- use consistent publisher identity;
- sign every release;
- do not instruct users to casually bypass "Windows protected your PC";
- treat unexpected publisher/signature warnings as security incidents.

## 18. App Control for Business

For managed enterprise/admin endpoints, App Control for Business is strongly recommended.

Goal:

allow only trusted/signed software and approved scripts.

Use cases:

- privileged admin workstations;
- signing/release workstations;
- security/recovery workstations.

Deployment methodology:

- inventory applications;
- start with Audit where appropriate;
- review events;
- move to enforcement after compatibility validation;
- avoid broad exclusions.

App Control complements antivirus; it does not replace it.

## 19. AppLocker

AppLocker may be used where App Control for Business is not the chosen control.

Preference for high-security managed systems:
App Control for Business when operationally feasible.

Do not maintain two overlapping allowlisting systems without a clear ownership model.

## 20. Attack Surface Reduction rules

ASR rules should be evaluated for admin/security workstations.

Relevant protection themes include:

- credential theft;
- malicious scripts;
- office/email-delivered executable content;
- process injection;
- abuse of vulnerable signed drivers;
- WMI persistence.

Rollout:

1. inventory software;
2. enable audit where Microsoft guidance recommends testing;
3. review events;
4. resolve legitimate compatibility;
5. enable Block/Warn according to policy;
6. minimize exclusions.

Broad exclusions are a security smell.

## 21. Defender Antivirus / EDR

Microsoft Defender Antivirus or an equivalent enterprise endpoint security product must remain
active.

For privileged workstations, central EDR visibility is strongly recommended.

Important alerts should include:

- Wallet Agent executable modification;
- process injection into wallet-agent;
- suspicious child process;
- credential theft activity;
- unsigned/untrusted code execution;
- persistence changes;
- suspicious PowerShell;
- unexpected network connections.

## 22. Credential Guard

For privileged Windows admin/security workstations, enable Credential Guard where supported and
compatible.

Credential Guard protects Windows/domain authentication material using virtualization-based
security.

This helps protect operator credentials.

It does NOT protect blockchain wallet private keys by itself.

## 23. LSA protection

Privileged workstations should use current Windows LSA protection defaults/recommendations.

Do not design gpu.k.p2p tools that require extracting credentials from LSASS.

Any such requirement is a design failure.

## 24. Memory integrity / VBS

For privileged workstations, enable virtualization-based security and memory-integrity protections
where supported and validated.

Driver compatibility must be tested.

Do not disable memory integrity merely to support a poorly designed Wallet Agent or legacy driver.

Hardware-wallet driver requirements must be assessed before deployment.

## 25. Windows Firewall

Windows Firewall should be enabled.

For Wallet Agent:

Inbound:
- no LAN/public inbound rule;
- loopback communication only.

Outbound:
- deny by default for Wallet Agent where practical;
- allow only endpoints required by its explicit function.

Preferred architecture:

the Wallet Agent should not need unrestricted internet access if the browser/server can prepare
public chain context safely and the agent's role is signing.

If direct wallet/node communication is necessary, document exact destinations/protocols.

## 26. Wallet Agent outbound minimization

Strong preference:

Wallet Agent communicates only with:
- local browser via authenticated loopback;
- explicitly configured native wallet/hardware interface;
- vetted update verification service if updater is inside the agent architecture.

Avoid:
- arbitrary URL fetching;
- arbitrary RPC configuration supplied by the website;
- analytics SDKs;
- ad/tracking SDKs;
- remote HTML/content rendering.

## 27. Service vs per-user process

Default preference:

run Wallet Agent as the least-privileged user process unless a Windows service is genuinely needed.

Reasons:

- smaller privilege boundary;
- fewer system-wide privileges;
- easier user-scoped pairing.

If a Windows service is required:

- dedicated service identity;
- service SID where applicable;
- minimal privileges;
- restricted ACLs;
- no LocalSystem unless unavoidable and independently reviewed;
- no interactive desktop access.

## 28. Filesystem ACLs

Wallet Agent files:

Program binaries:
- writable only by trusted installer/admin context.

User config:
- user-specific ACL.

Pairing secrets:
- user-specific ACL + DPAPI or stronger appropriate protection.

Logs:
- no secret material;
- user/service-specific write access;
- bounded size.

Update staging:
- not writable by low-integrity/untrusted processes if elevated installer consumes it.

## 29. DLL loading

Mitigate DLL hijacking:

- use safe DLL search behavior;
- avoid current-directory dynamic loading;
- use absolute paths for trusted modules;
- avoid user-writable directories in library search;
- sign/verify critical modules;
- minimize native plugin architecture.

Do not support arbitrary Wallet Agent plugins in V1.

## 30. Process privileges

Wallet Agent must not request administrator rights for normal operation.

No SeDebugPrivilege.

No unnecessary token privileges.

No UAC elevation during ordinary signing.

Installer elevation is separate from runtime.

## 31. Browser extensions

The official web app must not assume browser extensions are trustworthy.

Controls:

- identify selected provider;
- re-read account/network immediately before signature;
- show destination/network/amount;
- bind signatures to canonical terms.

Admin workstations should minimize extensions and use a dedicated hardened browser profile.

## 32. Clipboard risk

Do not rely on clipboard for fund-critical destination integrity.

If addresses are copied/pasted:

- validate encoding/network;
- show full or strongly distinguishable address representation;
- compare transaction to signed canonical terms;
- require final confirmation.

## 33. Screen capture and remote support

Privileged workflows should avoid exposing secrets through screen-sharing or remote-support tools.

The application should never display seed phrases because it should never possess them.

Do not build "support mode" that extracts wallet secrets.

## 34. Crash dumps

Crash dumps can leak sensitive in-memory material.

Requirements:

- classify Wallet Agent crash dumps as sensitive;
- avoid automatically uploading raw dumps;
- scrub/minimize where possible;
- obtain explicit diagnostic consent if user data could be present;
- never include private wallet material intentionally.

## 35. Windows Event Log

Security-relevant local events may be logged to Windows Event Log or another protected local audit
channel.

Examples:

- agent start/stop;
- pairing created/revoked;
- rejected origin;
- failed authentication;
- update verification failure;
- code-signature failure;
- privileged method denial.

Do not log:

- seed;
- private key;
- raw signing secret;
- wallet password;
- full sensitive recovery secret.

## 36. Update architecture

Updater security is fund-critical.

Required:

- signed update metadata/artifact;
- signature verification;
- version monotonicity / rollback protection;
- channel binding;
- package identity verification;
- atomic replacement;
- recovery after interrupted update.

Forbidden:

download latest.exe
then execute without independent verification.

## 37. Update freeze / rollback defense

Threats:

- attacker serves old vulnerable but validly signed build;
- update mirror freezes user on vulnerable version;
- metadata and binary from different releases are mixed.

Controls:

- signed version metadata;
- minimum allowed version policy for critical vulnerabilities;
- expiry/freshness where appropriate;
- hash-bound artifact metadata;
- separate emergency revocation mechanism.

## 38. Release signing key protection

Preferred:

managed signing service with audited access and non-exportable service-held signing identity.

If certificate key material exists locally:

- hardware-backed where possible;
- separate release workstation;
- no developer access by default;
- strong operator auth;
- rotation/revocation plan.

Release-signing identity is separate from blockchain wallet identities.

## 39. Reproducibility / provenance

For each Wallet Agent release record:

- Git commit;
- build workflow;
- dependency lock state;
- artifact SHA-256;
- signing identity;
- timestamp;
- SBOM;
- provenance;
- test results.

A valid Authenticode signature alone does not prove the build is safe.

## 40. Admin workstation standard

Recommended production admin workstation:

- Windows 11 current supported release;
- Secure Boot enabled;
- TPM 2.0;
- BitLocker;
- Windows Hello/FIDO2;
- Credential Guard;
- VBS/memory integrity;
- Defender AV/EDR;
- App Control for Business;
- ASR;
- Firewall;
- automatic security patching;
- standard user for daily operations;
- separate privileged identity;
- dedicated browser profile;
- no unapproved software.

## 41. Recovery operator workstation

Recovery operations can be more dangerous than ordinary marketplace actions.

Controls:

- dedicated device or hardened admin tier;
- phishing-resistant authentication;
- minimal installed software;
- signed recovery tooling;
- offline-verifiable recovery instructions;
- no dependence on compromised production web UI.

## 42. Development/test Windows hosts

Development convenience must not leak into production.

Permitted in dev only:

- self-signed package signing;
- localhost test endpoints;
- mock wallets;
- regtest/testnet private keys.

Forbidden:

- production user seeds;
- production signing keys;
- production admin secrets.

## 43. Hardware wallet integration

When supported:

- prefer vendor-documented protocols;
- verify device identity/capabilities where possible;
- show transaction intent on trusted device display when available;
- never ask user to type seed into gpu.k.p2p;
- validate device firmware/support status according to documented policy.

Do not install unsigned third-party hardware drivers.

## 44. Windows-specific security tests

Mandatory Wallet Agent test cases:

1. request from unapproved Origin;
2. DNS rebinding attempt;
3. request without pairing;
4. replay pairing challenge;
5. replay signing request;
6. oversized request;
7. malformed JSON/CBOR;
8. invalid method;
9. path traversal attempts;
10. arbitrary file read attempts;
11. shell command attempts;
12. DLL hijack simulation;
13. update package tampering;
14. old signed version rollback;
15. mixed metadata/artifact attack;
16. localhost/LAN binding verification;
17. firewall rule verification;
18. non-admin runtime verification;
19. crash dump inspection;
20. secret scanning of logs.

## 45. Windows admin security tests

1. critical action with password-only auth must fail if strong auth is required;
2. stale WebAuthn challenge rejected;
3. challenge for one configuration cannot approve another;
4. unsigned admin helper blocked;
5. unapproved script audited/blocked according to policy;
6. stolen normal web session cannot change critical policy;
7. endpoint compromise drill includes credential revocation;
8. code-signing access is unavailable to ordinary admins.

## 46. Compatibility testing

Security controls can break legitimate software.

Test before enforcement:

- browser;
- Wallet Agent;
- hardware-wallet software;
- VPN if operationally required;
- Defender;
- App Control;
- ASR;
- Credential Guard;
- memory integrity;
- corporate device-management tooling.

Security exceptions must be narrow and documented.

## 47. Anti-patterns forbidden

Never:

- tell users to disable Defender;
- tell users to disable SmartScreen permanently;
- tell users to disable firewall;
- require running Wallet Agent as Administrator;
- instruct users to bypass publisher warnings routinely;
- store seeds in registry/files "encrypted" by homegrown crypto;
- expose localhost API without authenticated pairing;
- allow wildcard CORS;
- auto-update from unsigned URLs;
- download and execute remote scripts;
- permit arbitrary wallet-agent plugins.

## 48. Enterprise deployment recommendations

For commercial enterprise deployments provide:

- signed installer;
- MSI/MSIX/managed deployment option as appropriate;
- documented hashes;
- publisher identity;
- WDAC/App Control deployment guidance;
- firewall rule documentation;
- Intune/GPO configuration guidance where relevant;
- rollback/recovery process;
- offline install verification procedure.

## 49. Consumer deployment recommendations

For ordinary users:

- simple signed installer;
- clear verified publisher name;
- automatic signed updates;
- no administrator requirement after install;
- minimal permissions;
- clear pairing confirmation;
- simple revoke button;
- visible agent version/security status.

Security must not require expert Windows knowledge from the user.

## 50. Security Center integration

gpu.k.p2p UI should eventually expose local-agent status:

- agent connected;
- version;
- signature/update status;
- supported wallet capabilities;
- pairing state;
- update required;
- security warning.

Do not expose detailed local filesystem/user information.

## 51. Mandatory review before Wallet Agent implementation

Before writing executable Wallet Agent code:

- [ ] final transport selected;
- [ ] pairing protocol specified;
- [ ] origin-binding protocol specified;
- [ ] replay protection specified;
- [ ] signing-intent schema specified;
- [ ] local secret model specified;
- [ ] TPM/CNG usage decision documented;
- [ ] DPAPI usage decision documented;
- [ ] update format specified;
- [ ] code-signing system selected;
- [ ] firewall model specified;
- [ ] privilege model specified;
- [ ] crash-dump policy specified;
- [ ] fuzzing plan specified;
- [ ] independent security review planned.

## 52. Current recommendation

For V1:

- do not build the Windows Wallet Agent until G2/G3 signing and recovery semantics are specified;
- design its security interface now;
- use browser/hardware-wallet integrations first where safe;
- introduce the agent only for chains/wallets that genuinely require it.

This minimizes attack surface.

## 53. Source validation note

Key Windows controls in this baseline were revalidated against current Microsoft documentation in
October 2026, including:

- Windows WebAuthn APIs / Windows Hello / FIDO2;
- CNG key storage and Microsoft Platform Crypto Provider (TPM);
- DPAPI;
- App Control for Business;
- Smart App Control / SmartScreen;
- Credential Guard / VBS;
- Attack Surface Reduction;
- MSIX/code-signing guidance.

These external platform assumptions must be revalidated again before commercial release.
