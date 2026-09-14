# GPUbnb Host Windows install, repair and removal semantics

## Product rule

Installing a newer GPUbnb Host build, repairing the application or removing the Windows service must never silently destroy the owner's Host identity.

Persistent Host state lives under `%PROGRAMDATA%\GPUbnb` and includes the Agent key/configuration used to identify and reconnect the same machine. Application binaries and the Windows service are replaceable; identity is not.

## Upgrade / repair

A normal install over an existing installation may:

- stop and replace the `GPUbnbAgent` service;
- replace Host/Agent/tunnel binaries;
- refresh startup registration;
- reapply the protected ACL on `%PROGRAMDATA%\GPUbnb`.

It must not delete or regenerate an existing `agent.key` or `config.json` merely because the application is upgraded or repaired.

After repair, the same valid machine should be able to reconnect without the owner creating a new link code.

## Normal uninstall

A normal uninstall removes application binaries, startup hooks and the Windows service. It intentionally leaves `%PROGRAMDATA%\GPUbnb` in place so a later reinstall can recover the same machine identity and so uninstall is not an accidental security-sensitive key-destruction operation.

The UI must clearly disclose this behavior.

## Explicit local-data reset

A future "Remove GPUbnb data from this PC" action is a separate destructive operation. It must:

1. require explicit owner intent;
2. stop GPUbnb components first;
3. explain that the machine will need to be linked again;
4. never run automatically as part of upgrade, repair or ordinary uninstall;
5. coordinate server-side key revocation/unlink semantics before claiming the identity is removed everywhere.

Do not emulate this action by deleting ProgramData manually during support or recovery.

## Safety invariants

- no `powercfg` mutations in the installer;
- service data ACL remains restricted before the service starts;
- repair preserves machine identity;
- normal uninstall is reversible with respect to owner identity;
- destructive local-data removal is explicit and auditable.

`apps/api/test/windows-installer-data-preservation.test.ts` pins these invariants against the NSIS hook source so future packaging changes cannot silently weaken them.
