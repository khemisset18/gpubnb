# Windows native renter-session isolation boundary

Status: architecture constraint for PR #220. This document does not qualify any
physical host or enable Windows-native booking.

## Security decision

GPUbnb MUST NOT treat a secondary Windows logon token, a process running as
another user inside the provider's interactive session, or an unsupported
Terminal Services/GPU virtualization patch as an isolated renter desktop.

The Windows-native v1 graphics runtime may consume a renter session only after a
privileged proof establishes all of the following:

- the renter user SID is distinct from the provider SID and from built-in service
  identities;
- the exact renter WTS session is `WTSActive`;
- no other WTS session is `WTSActive` while native capture/input is armed;
- `WTSQueryUserToken` returns the primary token for that exact session and user;
- the worker PID and logon SID match the renter boundary;
- the virtual display, captured frame and NVENC output are fenced to the same
  session/generation/GPU identity.

The resulting Rust `RenterSessionIsolationProof` is provenance-backed: it is
created only after those checks pass. Agent `--self-test` and `--start`
contracts independently require `separateRenterIdentity`,
`renterSessionActive` and `providerSessionInactive`.

## Why a token is not a session

Microsoft documents `WTSQueryUserToken` as retrieving the primary token of an
already logged-on user for a supplied Remote Desktop Services session ID. It does
not create a session:

https://learn.microsoft.com/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken

`LogonUserW(LOGON32_LOGON_INTERACTIVE)` creates a logon token. Microsoft
documents `CreateProcessAsUserW` as running the process in the session carried
by the token; changing the token session ID targets a session that already
exists. These APIs are not a supported primitive for allocating a new WTS
interactive session:

https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-logonuserw

https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw

Microsoft also documents that only `WinSta0` is interactive. Other window
stations are noninteractive and cannot display UI or receive user input. Each
real Remote Desktop session receives its own interactive `WinSta0`:

https://learn.microsoft.com/windows/win32/winstation/window-stations

https://learn.microsoft.com/windows/win32/termserv/terminal-services-sessions

Therefore GPUbnb must never claim isolation by putting a renter process on
`WinSta0\\Default` of the provider session, even under a different user token.

## Child sessions are not the renter boundary

Windows child sessions are loopback RDP sessions tied to an existing user's
parent session and are created through the Remote Desktop ActiveX control.
They are useful Windows functionality but do not provide GPUbnb's required
separate renter identity boundary:

https://learn.microsoft.com/windows/win32/termserv/child-sessions

## Host virtualization support boundary

Do not use undocumented patches or assume that Hyper-V GPU passthrough available
on Windows Server is supported on a consumer/client host.

Microsoft's current Hyper-V guidance states:

- DDA requires a Windows Server 2016-or-newer host and server-class hardware.
- GPU partitioning requires Windows Server 2025-or-newer for the supported
  production path.
- DDA and GPU-P are not supported on client operating systems such as Windows
  10/11 Pro or on desktop-class hardware.

https://learn.microsoft.com/troubleshoot/windows-server/virtualization/troubleshoot-hyper-v-gpu-assignment-partitioning-passthrough-issues

Windows 10/11 Enterprise multi-session is an Azure Virtual Desktop capability
and Microsoft does not permit production use of that multi-session edition
outside Azure Virtual Desktop:

https://learn.microsoft.com/azure/virtual-desktop/windows-multisession-faq

These platform constraints are independent of whether an unsupported technique
can be made to work experimentally.

## Consequence for the current implementation

The current native v1 code validates an already-provisioned renter WTS session;
it does not yet provision one. Native Windows bookability MUST remain disabled
until one supported provisioning strategy is implemented and physically proven.

Acceptable future strategies include a reviewed Windows Server/RDS design or a
dedicated VM design on a host/GPU combination for which Microsoft and the GPU
vendor support the selected GPU assignment method. A strategy must also preserve
the exact GPU UUID/LUID authority chain and GPUbnb cleanup/reconnect semantics.

A personal Windows client host cannot be promoted merely because IddCx, Desktop
Duplication and NVENC work in the provider session.

## Qualification requirements

Before changing the server-side Windows runtime gate, physical evidence must show:

1. a supported session/VM provisioning mechanism creates the renter boundary;
2. the provider identity/session cannot become the capture or input target;
3. exact GPU binding survives start, reconnect and steady streaming;
4. browser disconnect suspends media and reconnect requires fresh proof;
5. stop removes worker/application/session credentials and all temporary state;
6. host/service crash recovery leaves the machine offline until cleanup and
   authority reconciliation succeed;
7. the exact Windows edition, build, GPU model/driver and virtualization/session
   mechanism used by the qualification are recorded.

Unit tests and synthetic JSON cannot substitute for this evidence.
