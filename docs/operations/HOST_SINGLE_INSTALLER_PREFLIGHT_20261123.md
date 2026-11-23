# Windows Host single-installer preflight — 2026-11-23

## What the Windows CI preflight now exercises

The disposable `host-windows-preflight` job builds the Agent, stream helper,
worker and media DLL from one exact source commit, includes the four binaries
in one NSIS package, checks their hashes after installation, then checks that
uninstall removes the three native files and the Agent service. The package is
still an **unsigned CI preflight** and is deliberately blocked from running on
ordinary Windows PCs.

This is packaging evidence only. It does not execute capture or encoding,
install a display driver, connect an account, start a gaming session, or prove
PC1-to-PC2 playback. Do not download this CI artifact for PC1.

## Why a user Host installer is still blocked

The current Stage 4 package manifest says `installable=false` and
`iddDriverIncluded=false`. The Windows IddCx workflow compiles the driver but
does not produce a signed installable driver package. The driver README also
states that its swap-chain path only drains and validates surfaces; it does
not yet produce the nonce-bound captured game frame required for `READY`.

The Windows preflight artifacts are unsigned. There is no current approved
Authenticode identity and protected signing service configured for the Host
installer. The older private-test certificate fingerprint in historical
qualification notes is expired and is not proof of a currently usable
certificate on PC1.

## Required before the real single installer can be issued

1. Complete the isolated display path through exact-monitor capture, GTX
   adapter selection, NVENC output, audio/input, revocation and STOP cleanup.
2. Produce a current IddCx driver package with the required Microsoft driver
   signature, plus a bounded install, removal and rollback path. Verify it
   under the supported Windows Secure Boot policy.
3. Configure a protected Authenticode signing identity for the four native
   components and final NSIS installer. Verify publisher identity and hashes
   in CI; never place the private key in repository source or chat.
4. Build the release installer only from the verified native payload and
   signed driver package, then obtain the independent review and perform the
   authorized PC1/PC2 qualification. Keep public booking disabled.

Until these requirements pass, no artifact in Actions or GitHub Releases is a
usable Cloud Gaming Host installer.
