# Windows-native desktop physical qualification

Status: mandatory promotion checklist for PR #220. Unit/CI success does not replace
this procedure.

## Scope

Qualifies the Windows-native backend for:

- Cloud Desktop
- Creator / Blender
- CAD / FreeCAD
- Gaming / Steam

Run on a physical Windows NVIDIA Host. The Machine remains non-bookable for this
backend until the required stage has passed and evidence has been recorded.

## 0. Safety prerequisites

PASS only if all are true before testing:

- Agent build/commit under test is recorded.
- Windows version, NVIDIA driver, GPU model/UUID and VRAM are recorded.
- Provider has no sensitive documents/windows intentionally open for the test.
- A separate renter test identity is available.
- The Host can be recovered locally if networking or the Agent fails.
- Existing stable GPUbnb rental baseline remains recoverable.

Do not disable firewall/antivirus globally or weaken Windows account protections to
make a test pass.

## 1. Static inventory

Record:

```powershell
nvidia-smi --query-gpu=name,uuid,memory.total,driver_version --format=csv,noheader
python agent/tools/windows_native_qualify.py
```

PASS requires the qualification report to be valid JSON and contain no provider
profile/application filesystem paths. A missing helper is an expected FAIL before
the native helper is installed; it must never be converted into a guessed success.

## 2. Native helper self-test

Run:

```powershell
python agent/tools/windows_native_qualify.py --workspace cloud-desktop --require-ready
```

PASS requires all of:

- exact local NVIDIA GPU UUID;
- real captured frame;
- `hardwareEncoder = nvenc`;
- isolated renter session proof;
- input isolation proof;
- local media loopback proof;
- no helper listener on LAN/public interfaces;
- no leftover helper/session process after the self-test.

## 3. Cloud Desktop end to end

This is the first Workspace promotion gate because it proves the shared Windows
streaming/session foundation.

PASS requires:

1. booking reserves the exact GPU expected by the renter;
2. Host creates a dedicated GPUbnb renter boundary;
3. browser receives the renter desktop through the authenticated GPUbnb data path;
4. provider personal desktop is never visible, including during startup, UAC-like
   transitions, reconnect and shutdown;
5. keyboard/mouse input affects only the renter boundary;
6. clipboard, provider profile, cookies, documents and personal drives are absent by
   default;
7. browser refresh/reconnect resumes the same Workspace when authorized;
8. last renter connection loss pauses billable service according to the existing
   reconnect policy;
9. reconnect inside the server-authorized grace resumes the same Workspace without
   charging the disconnected interval;
10. grace expiry ends/reconciles the session;
11. normal stop leaves no renter process, capture source, encoder, media listener,
    input hook or temporary credential/token;
12. the GPU becomes reservable again only after cleanup is verified.

## 4. Failure injection

Cloud Desktop cannot pass qualification without controlled failure tests:

- kill browser connection;
- kill/restart the native stream helper;
- restart the GPUbnb Agent;
- temporarily interrupt Host networking;
- reboot Windows during an active test rental.

For every case verify server-authoritative fencing, no free-compute window, no double
billing, no duplicate renter session and cleanup/recovery without exposing the
provider desktop.

## 5. Creator / Blender

In addition to all shared Cloud Desktop checks:

- qualified native Blender executable is launched inside the renter boundary;
- Blender reports/uses the exact leased GPU for the qualification render;
- a real render completes and changes GPU utilization on that GPU;
- no fallback to another GPU/CPU is accepted as a GPU-ready proof;
- cleanup removes Blender and its child processes.

## 6. CAD / FreeCAD

In addition to shared checks:

- qualified FreeCAD executable launches inside the renter boundary;
- a real 3D viewport is rendered and captured;
- interactive viewport input is isolated to the renter boundary;
- GPU/render proof uses the leased GPU where the selected renderer path requires it;
- cleanup removes FreeCAD and child processes.

## 7. Gaming / Steam

Gaming has the strictest promotion gate. In addition to shared checks:

- Steam runs only inside the renter boundary;
- renter supplies their own account and owned games;
- GPUbnb stores/redistributes no Steam credential or game content;
- audio is delivered end to end;
- controller input is delivered only to the renter session;
- keyboard/mouse/controller cannot target the provider session;
- outbound network policy is explicit and limited to the Gaming policy rather than
  silently granting the policy to other Workspaces;
- measured latency/jitter are recorded; no low-latency performance claim is made
  unless measurements support it;
- Steam/game processes and credentials are removed/invalidated at cleanup.

## 8. Resource gates

Passing the streaming backend does not override Workspace resource minima. RAM,
disk and VRAM compatibility still apply independently. A Host can pass the native
backend proof while remaining incompatible with Creator, CAD or Gaming because of
resource limits.

## 9. Evidence record

For each qualified Host/build record at minimum:

- Agent commit/version;
- helper version/hash;
- Windows build;
- GPU model + UUID;
- NVIDIA driver;
- Workspace slug;
- timestamps for connect/disconnect/reconnect/stop;
- measured valid-service billing interval;
- cleanup result;
- pass/fail and failure reason.

Do not upload screenshots containing provider personal data, renter credentials or
private file contents.

## Promotion rule

Cloud Desktop may be considered for Windows bookability only after stages 0-4 pass
on physical hardware. Creator/CAD/Gaming additionally require their own stage.
PR #220 remains draft until the shared backend plus at least the intended Workspace
qualification evidence exists and CI is clean.

## Helper path trust

Production qualification must use the installed helper at
`C:\\Program Files\\GPUbnb\\gpubnb-windows-stream.exe`. The Agent deliberately
never discovers this security-sensitive executable through `PATH`.

A development build may be selected only by setting both
`GPUBNB_WINDOWS_STREAM_HELPER_DEV_ALLOW=1` and an **absolute**
`GPUBNB_WINDOWS_STREAM_HELPER` path. This override is for controlled development
and physical qualification only; release packaging must install the signed helper
at the fixed Program Files location.
