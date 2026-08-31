# CAD Workspace - architecture prepared, NOT working, NOT bookable

**Not REAL_WORKING.** Not in `executableWorkspaceSlugs`, not bookable.
Shares the exact same base image, GPU-rendering gap, and container-
hardening open questions as `workspaces/cloud-desktop/` - see
`workspaces/cloud-desktop/NOT_YET_WORKING.md` for the full detail, not
repeated here.

## What's specific to CAD

- Real FreeCAD (GPL, confirmed live to install cleanly on this exact
  image) - **not** from Ubuntu's own official repo: this image already has
  the well-known, actively-maintained `xtradeb` PPA configured (Ubuntu's
  own repo lags behind upstream FreeCAD releases). A real, documented
  trust-level difference from Blender/Steam's own official-repo packages -
  worth a deliberate decision before shipping, not hidden.
- `healthcheck.sh` additionally checks `freecad` is on `PATH` (cheap, real,
  proves nothing about GPU rendering).

## Real validation still required (see docs/SESSION_RESUME.md section 8/9)

Same Linux-GPU-host validation plan as Cloud Desktop, plus: confirm
FreeCAD's own 3D view actually uses GPU-accelerated OpenGL once `/dev/dri`
is available to test against, and make an explicit decision on the PPA
trust question above.
