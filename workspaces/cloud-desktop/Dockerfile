# NOT YET WORKING - see NOT_YET_WORKING.md. Not in executableWorkspaceSlugs,
# not bookable, GPU rendering not provable on this host (no /dev/dri).
#
# Real, official, actively-maintained image: linuxserver/webtop
# (Selkies-GStreamer based - see docs/SESSION_RESUME.md section 8 for the
# researched WebRTC/TURN-over-TCP integration plan). Digest is the real
# multi-arch manifest-list digest for the `latest` tag, resolved via the
# Docker Hub API 2026-08-31 so Docker picks the right arch automatically.
FROM linuxserver/webtop@sha256:49a08b1e871aa300829d206141dc932459c7db2866269120ad79ec9d959ccbed

# What was actually tested live against this exact image on this exact
# host (no GPU flags - this host has none to pass through):
#   - real container start, real HTTP 200 + real Selkies HTML on port 3000
#     (the documented plain-HTTP reverse-proxy port - matches this
#     platform's WORKSPACE_ENTRY_PORT=3000 with no remapping needed)
#   - the real loopback-proxy.js relay (same script every REAL_WORKING
#     workspace's Gateway uses) correctly relays through to it, on the
#     same two-network pattern production uses
#   - real gamepad support confirmed live in the container's own startup
#     logs (4 persistent gamepad instances initialized)
#   - real stop/cleanup confirmed
# NOT tested (needs a real Linux GPU host): the --gpus/NVIDIA_DRIVER_CAPABILITIES
# flags a real launch would need, e.g.:
#   --gpus device={exact_leased_hardware_uuid}
#   --env NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute
# and whether the desktop this serves is genuinely GPU-rendered once it does
# - confirmed live that /dev/dri is absent both on this host and inside
# this exact image's container, so there is nothing to prove that against.
