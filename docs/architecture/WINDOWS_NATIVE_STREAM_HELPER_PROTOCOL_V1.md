# GPUbnb Windows native stream helper protocol v1

Status: implementation contract for PR #220; not a release qualification.

## Purpose

`gpubnb-windows-stream.exe` is the only native component allowed to own the
Windows graphical renter session for Cloud Desktop, Creator, CAD and Gaming.
The Agent remains the authority boundary. The helper may capture/encode media
and inject renter input only inside the dedicated GPUbnb renter session; it does
not decide booking, billing, fencing, reconnect grace or marketplace state.

The helper must never capture the provider's personal desktop.

## Common process rules

- Native Windows executable; no shell command construction by the Agent.
- JSON is written to stdout. Human diagnostics belong on stderr.
- stdout must contain exactly one JSON object for each command invocation.
- `schemaVersion` is integer `1` for `--self-test` and `--start` replies.
- Unknown arguments or unsupported schema versions fail non-zero.
- Agent parsing rejects duplicate JSON keys, non-finite JSON constants, oversized
  replies and non-integer schema versions (including boolean true and 1.0).
- UUID validation is shared by Agent preflight and launch; matching a malformed
  UUID string in inventory cannot establish native readiness.
- A non-zero `--start` exit code MUST leave no live renter session, capture,
  encoder, input hook, listener or child process behind.
- The Agent also requests verified cleanup after a non-zero start, timeout or
  process failure: a crashed helper cannot prove that its resources are gone.
  Failure to confirm stop is surfaced as cleanup unverified.
- A successful `--start` reply transfers lifecycle ownership to the Agent; if
  the Agent rejects that reply it immediately calls `--stop` for the requested
  session id.
- `--stop` is idempotent: an already-clean session still returns `stopped:true`
  for the requested session id after verifying no owned process/listener remains.
- Media listeners bind loopback only. No `0.0.0.0`, LAN, public or wildcard
  listener is permitted. The Agent accepts only a literal loopback IP, an explicit
  TCP port and a path exactly `/session/<sessionId>`; credentials, query strings
  and fragments are rejected.
- The local media WebSocket upgrade is a separate authenticated trust boundary.
  It accepts only a bounded HTTP/1.1 `GET /session/<sessionId>` request, a
  canonical literal-loopback `Host` with explicit non-zero port, WebSocket
  version 13, and exactly one `X-GPUbnb-Media-Token` header. Duplicate headers,
  request bodies, transfer encoding, folded headers, cross-session paths and token
  whitespace normalization are rejected before any media runtime is touched.
- Worker control and encoded media are deliberately separate local transports.
  The privileged control pipe remains capped at 512-byte command/proof frames and
  MUST NOT carry H.264 payloads. Encoded H.264 travels worker -> service over a
  distinct local-only named pipe with a protected DACL, remote clients rejected,
  and the same exact renter logon SID + worker PID verification as the control pipe.
- Each media frame starts with the fixed 80-byte media header and is followed
  by exactly one bounded H.264 payload (maximum 8 MiB). Media transport protocol
  v2 adds an explicit keyframe flag while preserving the fixed header size. The
  header binds the bytes to generation, control-command sequence, WTS session id,
  adapter LUID, display nonce, frame sequence, dimensions, refresh rate and the
  corresponding media proof. Any mismatch, replay, unknown flag, zero/oversized
  length or partial proof revokes the media runtime.
- Media DLL ABI v2 exposes whether NVENC actually emitted an IDR frame. A newly
  opened encoder forces IDR + SPS/PPS exactly once; steady frames use the normal
  low-latency inter-frame path. Start and reconnect MUST receive a frame marked
  keyframe before READY can be armed, so a browser decoder never resumes from a
  stale P-frame. Reconnect creates a fresh media session, re-arming the one-shot
  IDR/SPS/PPS behavior.
- During an established stream, `DXGI_ERROR_WAIT_TIMEOUT` means only that
  Desktop Duplication produced no new desktop image within the short polling
  interval. The worker reports a typed `NoFrame` control result fenced to the
  current generation, command sequence and WTS session; it does not invent or
  replay an H.264 frame and it does not revoke READY solely because the desktop is
  static. The service rechecks UUID -> LUID before accepting this benign result.
  Access loss, device removal/reset/hang, identity mismatch and all other capture
  failures remain terminal and revoke the media proof. Initial start and reconnect
  still require a fresh real captured+NVENC frame before readiness can be armed.
- The browser-facing binary media protocol is distinct from the privileged
  worker-media proof protocol. It exposes only codec/keyframe state, a non-zero
  stream epoch, frame sequence, dimensions and bounded chunk metadata; GPU UUID,
  LUID, WTS identifiers, display nonce and capability tokens never enter browser
  media messages. Each binary message contains a fixed 44-byte v1 header followed
  by at most 1 MiB of one encoded H.264 frame. A frame remains bounded to 8 MiB,
  so large IDR frames are chunked below the existing 4 MiB gateway frame ceiling.
  Chunks are contiguous offsets into one frame and must not be combined across
  epochs or frame sequences. Reconnect creates a new stream epoch and the first
  delivered frame for that epoch must be the freshly proved keyframe.
- The helper never logs provider usernames, profile paths, browser data,
  document paths, tokens or renter credentials.

## Stable identifiers

`sessionId` is an opaque GPUbnb identifier containing only ASCII letters,
digits, `-` and `_`, maximum 200 characters.

`gpuUuid` is the exact stable NVIDIA UUID selected by GPUbnb for the lease. The helper accepts only the canonical physical-GPU form `GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` and must reject a launch when capture/encode/rendering cannot be bound to that GPU. A different GPU, alias or device name must never be substituted silently.

Supported Workspace slugs in v1:

- `cloud-desktop`
- `creator`
- `cad`
- `gaming`

## `--self-test --json`

The self-test is a real local proof, not a configuration check. It must create an
ephemeral GPU-rendered test surface in a GPUbnb-isolated Windows context, capture
at least one real frame, hardware-encode it on the selected NVIDIA GPU, deliver
that encoded frame through the local media path and verify renter-input isolation.
The self-test must prove that the capture source is the GPUbnb-owned virtual display and that the provider desktop is excluded; a generic interactive-session boolean is not sufficient. Temporary self-test resources must be removed before the process exits.

Success stdout:

```json
{
  "schemaVersion": 1,
  "platform": "windows",
  "helperVersion": "0.1.0",
  "gpuUuid": "GPU-...",
  "isolatedSession": true,
  "separateRenterIdentity": true,
  "renterSessionActive": true,
  "providerSessionInactive": true,
  "virtualDisplay": true,
  "providerDesktopExcluded": true,
  "captureFrame": true,
  "exactGpuBound": true,
  "nvencReady": true,
  "hardwareEncoder": "nvenc",
  "mediaLoopback": true,
  "inputIsolation": true,
  "audioAvailable": true
}
```

The Agent treats any missing/false proof, invalid JSON, non-NVENC encoder, wrong
platform or GPU UUID not present in its own NVIDIA inventory as unavailable.
CUDA presence, GPU model, VRAM size or Docker availability never substitute for
this proof.

## `--start --json`

Invocation:

```text
gpubnb-windows-stream.exe --start --json \
  --session-id <sessionId> \
  --workspace <slug> \
  --gpu-uuid <gpuUuid> \
  [--application <absolute-qualified-application-path>]
```

Before returning success, the helper must have created the isolated renter
boundary on a GPUbnb-owned virtual display, proved the provider desktop is not a
capture source, bound rendering/capture/encode to the leased GPU and opened a
loopback media endpoint on an explicit TCP port.

Success stdout:

```json
{
  "schemaVersion": 1,
  "sessionId": "sess-...",
  "workspaceSlug": "cloud-desktop",
  "gpuUuid": "GPU-...",
  "helperVersion": "0.1.0",
  "isolatedSession": true,
  "separateRenterIdentity": true,
  "renterSessionActive": true,
  "providerSessionInactive": true,
  "virtualDisplay": true,
  "providerDesktopExcluded": true,
  "captureReady": true,
  "exactGpuBound": true,
  "nvencReady": true,
  "hardwareEncoder": "nvenc",
  "mediaReady": true,
  "inputIsolation": true,
  "audioReady": false,
  "controllerReady": false,
  "mediaUrl": "http://127.0.0.1:43123/session/sess-...",
  "mediaToken": "<random-base64url-secret>"
}
```

`mediaToken` is a fresh, high-entropy per-session secret used by the authenticated
GPUbnb gateway when connecting to the helper. The Windows implementation generates
256 bits from CNG `BCryptGenRandom` with
`BCRYPT_USE_SYSTEM_PREFERRED_RNG`, encodes the 32 random bytes as 64 lowercase
hexadecimal ASCII characters, and keeps the capability in memory only. It must
contain at least 32 base64url-safe characters, must never be placed in
`mediaUrl`, and must never be written to logs, diagnostics, persisted session
metadata or renter-visible JSON. The helper rejects media/input requests that do
not present the token through the dedicated local authentication mechanism and
compares a correctly sized presented token without token-dependent early exit.

Additional Workspace requirements:

- Cloud Desktop: `--application` is forbidden; the helper must not accept an arbitrary executable.
- Creator: a qualified Blender executable is required and launched in the renter boundary.
- CAD: a qualified FreeCAD executable is required and launched in the renter boundary.
- Gaming: a qualified Steam executable is required and launched in the renter boundary;
  `audioReady` and `controllerReady` must both be true before GPUbnb exposes the
  session as ready.

Application paths are defense-in-depth validated by both Agent and helper: local drive-qualified Windows paths only, explicit `.exe`, no PATH lookup, no UNC/network path, no Win32 device namespace, no alternate data stream and no `.`/`..` component.

A helper MUST NOT return success unless the renter boundary is proven before any
graphics/media proof is accepted. In v1, `separateRenterIdentity`,
`renterSessionActive` and `providerSessionInactive` are mandatory provenance
claims backed by the privileged WTS/token checks: the renter user SID is distinct
from the provider and system identities, the exact renter WTS session is active,
and no other WTS session is active. A secondary `LogonUser` token or a
`CreateProcessAsUser` process placed into the provider's interactive session
cannot satisfy this contract.

The helper must also prove both `virtualDisplay` and
`providerDesktopExcluded`. It must never present a provider desktop, a public
listener, a software encoder, the wrong GPU or an unisolated input target.

## `--stop --json`

Invocation:

```text
gpubnb-windows-stream.exe --stop --json --session-id <sessionId>
```

Success stdout after verified cleanup:

```json
{
  "stopped": true,
  "sessionId": "sess-..."
}
```

Before returning `stopped:true`, the helper verifies that all resources owned by
that renter session are gone: application/process tree, capture source, encoder,
media listener, input hook, temporary credentials/tokens and renter-scoped
session resources. Failure to verify cleanup returns non-zero or
`stopped:false`; the Agent treats that as cleanup unverified.

## Isolation requirements

The current native v1 runtime consumes an already-provisioned interactive renter
session; it does not manufacture a new WTS session from a token. Windows APIs
that create a logon token do not by themselves create a separate interactive
WinSta0 session, and GPUbnb must not weaken this boundary by launching the renter
inside the provider's session. Until a supported provisioning path is implemented
and physically qualified, native Windows bookability remains disabled.

The v1 implementation must demonstrate all of the following during physical
qualification:

1. The renter runs under a user identity distinct from the provider and from
   LocalSystem/LocalService/NetworkService.
2. The exact renter WTS session is active and the provider session is not active
   while native capture/input is armed.
3. Provider personal desktop pixels never enter the renter stream.
4. Renter keyboard/mouse/controller input cannot target the provider session.
5. Provider clipboard, profile, browser cookies, documents and personal drives
   are not inherited by default.
6. Workspace files live under a GPUbnb-controlled renter ACL boundary.
7. Only the exact leased GPU is used for the ready proof.
8. Media is reachable only through the authenticated GPUbnb data plane; the
   helper itself exposes loopback only.
9. Session cleanup remains verifiable after normal stop, renter disconnect,
   helper crash and Host reboot/recovery.

## Authority and reconnect

The helper never extends lease time or decides whether a disconnected renter may
resume. Existing GPUbnb server authority remains responsible for the 10-minute
reconnect grace and valid-service-time billing. The Agent may pause/stop native
runtime work according to that authority, and every resume must still be fenced
to the same booking/session/GPU allocation.

## Promotion gate

Passing unit tests or returning this JSON shape is not qualification. Windows
bookability remains disabled until a physical NVIDIA Windows host proves browser
decode, exact-GPU rendering, provider-session isolation, reconnect/billing and
verified cleanup end to end.
