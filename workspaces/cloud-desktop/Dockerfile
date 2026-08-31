# NOT YET WORKING - see NOT_YET_WORKING.md. Not in executableWorkspaceSlugs,
# not bookable, GPU rendering not provable on this host (no /dev/dri).
#
# Shared base for all 4 desktop workspaces (Cloud Desktop/Creator/CAD/
# Gaming - see docs/SESSION_RESUME.md section 8/9): linuxserver/webtop,
# `ubuntu-xfce` tag specifically (glibc-based, not the default Alpine tag -
# needed because Gaming's Steam has no Alpine package at all, confirmed
# live). Digest is the real multi-arch manifest-list digest, resolved via
# the Docker Hub API 2026-08-31 so Docker picks the right arch
# automatically. Cloud Desktop itself adds nothing on top of this shared
# base - it *is* the base, general-purpose desktop.
FROM linuxserver/webtop@sha256:1bd141d5d7aaf3e98e47b7d9665f50657d1628617b4ef47bc3bbd43d726fd77e

# What was actually tested live against this exact image on this exact
# host (no GPU flags - this host has none to pass through):
#   - real container start, real HTTP 200 + real Selkies HTML on port 3000
#     (the documented plain-HTTP reverse-proxy port - matches this
#     platform's WORKSPACE_ENTRY_PORT=3000 with no remapping needed)
#   - the real loopback-proxy.js relay (same script every REAL_WORKING
#     workspace's Gateway uses) correctly relays through to it, on the
#     same two-network pattern production uses
#   - real gamepad support (4 persistent "Xbox 360 pad" instances) and real
#     audio support (audio_enabled/microphone_enabled, pulseaudio present)
#     both confirmed live in the container's own startup logs/config
#   - real stop/cleanup confirmed
#
# REAL, IMPORTANT SECURITY FINDING - this image needs a DIFFERENT hardening
# profile than every other workspace here, not the standard one:
#   - `--read-only` does NOT work: this image self-configures nginx, an SSL
#     cert, and copies Selkies' web assets into several *different* paths
#     at container startup (not baked in at build time) - confirmed live,
#     it fails partway through init with permission/missing-file errors no
#     matter how many extra tmpfs mounts were added on top (multiple real
#     attempts made, not just one).
#   - `--cap-drop=ALL` also does NOT work: its s6-overlay init needs real
#     capabilities to remap PUID/PGID at startup (confirmed live: "chown:
#     Operation not permitted", "s6-applyuidgid: fatal: unable to set
#     supplementary group list: Operation not permitted"). Likely
#     CAP_CHOWN/CAP_SETUID/CAP_SETGID/CAP_DAC_OVERRIDE are needed, but the
#     exact minimal set was NOT determined - stopped here rather than keep
#     guessing without real hardware to fully validate against.
#   - **What IS confirmed working**: `--security-opt=no-new-privileges`,
#     `--pids-limit`, `--memory`, `--cpus`, `--tmpfs=/tmp`, and a real
#     writable volume at `/config` (this image's own persistent-data
#     convention, not `/workspace` - deliberately not overridden). This is
#     a real, honest, *reduced* hardening profile vs. the other 9
#     workspaces (no --read-only, no --cap-drop=ALL) - not a silent gap,
#     a documented limitation pending either (a) determining the exact
#     minimal capability set on real hardware, or (b) a custom Dockerfile
#     that pre-bakes the nginx/SSL/web-asset setup at build time so the
#     container never needs to self-configure or chown anything at
#     startup. Do not claim `--read-only`/`--cap-drop=ALL` for this
#     workspace family until one of those is actually done and tested.
#
# NOT tested (needs a real Linux GPU host): the --gpus/NVIDIA_DRIVER_CAPABILITIES
# flags a real launch would need, e.g.:
#   --gpus device={exact_leased_hardware_uuid}
#   --env NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute
# and whether the desktop this serves is genuinely GPU-rendered once it does
# - confirmed live that /dev/dri is absent both on this host and inside
# this exact image's container, so there is nothing to prove that against.
