# Windows native private qualification blockers

**Status: NO-GO for installation and PC1 → PC2 streaming.** This record is
read-only with respect to Render and production. No Host was installed or
started, no session or payment was created, and no deployment was triggered.

## Current code and live Stage service

The PR branch `feature/windows-native-four-workspaces-20261120` has a private
page with four explicit profile selections. The page's PC1 preflight is
read-only. In this revision every launch control is disabled; API booking and
session endpoints reject the screen-only Cloud Desktop path because there is
no renter-scoped Windows-audio → browser path. Old private qualification
sessions are blocked at the status/access API and gateway fence and are sent
to the Agent as `STOPPING` for local cleanup.

Read-only Render inspection on 2026-11-21 found the service
[`gpubnb-stage3-private`](https://dashboard.render.com/web/srv-dau86i2d0e5s73elmk10)
still running deployment `dep-dbsut9tg1s2s7389m1q0`, commit
`23a7a2950ecf365866f3531ddbf76920d9fcb295`, branch
`stage4-private-pc1-23a7-qualification-20261115`. Auto-deploy is disabled.
The service's configured IP allow-list includes `0.0.0.0/0`; the page URL is
therefore reachable from the public Internet even though write routes are
intended to require account authentication and a private no-payment gate.
The current deployment's environment-variable values were not inspected, so
the no-payment gate's live state is **unknown**.

The currently served page at
<https://gpubnb-stage3-private.onrender.com/stage3-windows-native.html> is not
the PR branch's four-choice page. It has one “Démarrer le test Windows” button
and displays “Prêt.” before any host proof is shown. Do not use this deployment
to start a test: its build identity and exact private gate configuration have
not been verified for the requested revision.

## Workspace status

| Workspace | Current code status | Remaining proof before a real renter test |
| --- | --- | --- |
| Cloud Desktop | **Disabled** | Qualify the new bounded PCM/Web Audio path on a dedicated Host; verify isolation, exact GPU capture, STOP cleanup and browser video/input. Audio software plumbing exists but has no Windows or hardware proof. |
| Creator / Blender | **Disabled** | Verify the signed Host package, Blender launch, GPU rendering, session boundary, network restrictions, audio expectations and STOP cleanup on a dedicated Host. |
| CAD / FreeCAD | **Disabled** | Verify the signed Host package, FreeCAD launch, precise input, GPU rendering, session boundary, network restrictions and STOP cleanup on a dedicated Host. |
| Gaming / Steam | **Disabled** | Add an authorized game selector/launch contract, qualify audio/video/input and STOP on real hardware, provide native XInput if required, measure latency, and resolve game-content and GPU-driver commercial licensing. The current controller bridge maps browser Gamepad events to keyboard/mouse only. |

The four choice buttons identify the requested profile; they do not imply that
its applications or media path are installed or operational. No profile may
fall back to Cloud Desktop, Compute, the owner's physical desktop, or a Linux
container.

## Package and signing

The Windows package workflow is pinned to a source commit and can produce only
an unsigned, private candidate. It is not an installer approved for PC1 and it
does not satisfy production code-signing requirements. Do not install it with
Secure Boot disabled, test-signing enabled, or signature checks bypassed.
The IddCx display-driver package must be independently identified, licensed,
signed for the supported Windows release and verified under the intended
Secure Boot policy. A CI archive hash proves byte identity, not publisher
identity or safety.

## Licensing checks

These are release blockers to resolve for the exact product edition, license,
region and distribution model; this document is not a legal determination.

- Microsoft's Windows 11 OEM terms restrict commercial hosting and use as a
  server/remote-only device. Microsoft's Rental Rights program covers only
  specified qualifying licenses and says it cannot be used with products
  installed on servers or devices supporting multiple users. The PC owner's
  Windows license has not been shown to grant GPUbnb's proposed commercial
  rental use. See [Windows 11 OEM terms](https://www.microsoft.com/content/dam/microsoft/usetm/documents/windows/11/oem-%28pre-installed%29/UseTerms_OEM_Windows_11_English.pdf)
  and [Microsoft Rental Rights](https://www.microsoft.com/en-us/licensing/product-licensing/rental-rights).
- NVIDIA's GeForce/Titan software terms restrict commercial hosting and state
  that GeForce/Titan software is not licensed for datacenter deployment.
  The exact card, driver/software terms and GPUbnb-hosted rental model need
  written confirmation or a licensed alternative. See
  [NVIDIA GeForce Software License](https://www.nvidia.com/en-us/drivers/geforce-license/).
- Steam subscriptions are generally personal and non-commercial; renting,
  licensing or commercially exploiting content requires applicable express
  permission. A renter's individual game purchase does not grant GPUbnb a
  blanket right to host or rent that game. See the
  [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/).
- Blender's GPL permits commercial use of Blender and user-created artwork;
  FreeCAD documents commercial use under its LGPL terms. Distributions,
  add-ons, plugins, assets and games retain their own licenses. See
  [Blender licensing](https://www.blender.org/about/license/) and
  [FreeCAD licensing](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/License.md).

## Private deployment plan for operator approval

Do not deploy this candidate until all release gates below are satisfied. When
they are, an operator can perform a controlled Stage deployment in this order:

1. Record the exact PR commit and require successful Windows package, API,
   Agent and browser CI for that SHA. Obtain an independent formal GitHub
   `APPROVED` review on that exact unchanged SHA; any new commit invalidates it.
2. Produce the pinned CI candidate, verify its provenance manifest and every
   SHA-256, and separately verify publisher signatures and the driver package.
   A CI artifact marked unsigned remains **non-installable**.
3. On Render, confirm the target service ID and exact branch/commit. Keep
   auto-deploy off. Have an authorized operator verify the private no-payment
   flags without exposing secret values in logs. Reduce the Stage service's
   public ingress or enforce a tested access allow-list before exposing the
   qualification page. Do not use the public marketplace service.
4. Only after explicit operator approval, deploy the reviewed SHA to
   `gpubnb-stage3-private`; verify `/health`, `/release`, page commit identity,
   authenticated read-only preflight and the expected fail-closed response.
   Do not modify production service settings or location quarantine.
5. Use a physically dedicated, non-sensitive Windows 11 Host for the first
   install. Pre-provision a standard non-administrator renter account and a
   separate interactive session; prove that owner files, credentials, desktop
   and LAN services are inaccessible. Verify exact NVIDIA UUID selection and
   all STOP/expiry/revocation cleanup before allowing a renter stream.
6. From PC2, sign into the authorized Stage account, choose the exact enabled
   profile, inspect the no-payment preflight, and test only that profile. Stop
   immediately on any unexpected profile, owner-desktop frame, audio/input
   escape, GPU mismatch, stale grant or incomplete cleanup.

At this revision, steps 1–2 do not establish audio, licensing, a signed
production installer or physical isolation. The correct current result is to
keep the four launch paths disabled and defer PC1 installation.
