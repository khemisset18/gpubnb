# Creator Workspace - architecture prepared, NOT working, NOT bookable

**Not REAL_WORKING.** Not in `executableWorkspaceSlugs`, not bookable.
Shares the exact same base image, GPU-rendering gap, and container-
hardening open questions as `workspaces/cloud-desktop/` - see
`workspaces/cloud-desktop/NOT_YET_WORKING.md` for the full detail, not
repeated here.

## What's specific to Creator

- Real Blender (official Ubuntu `universe` package, GPL, confirmed live to
  install cleanly on this exact image).
- `healthcheck.sh` additionally checks `blender` is on `PATH` (cheap, real,
  proves nothing about GPU rendering).

## Real validation still required (see docs/SESSION_RESUME.md section 8/9)

Same Linux-GPU-host validation plan as Cloud Desktop, plus: confirm
Blender's own viewport actually uses GPU-accelerated OpenGL (not its own
CPU/software fallback) once `/dev/dri` is available to test against.
