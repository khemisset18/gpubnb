# NOT YET WORKING - see NOT_YET_WORKING.md and
# workspaces/cloud-desktop/NOT_YET_WORKING.md (same shared base, same
# open GPU-rendering and container-hardening questions - not repeated here).
# Not in executableWorkspaceSlugs, not bookable.
FROM linuxserver/webtop@sha256:1bd141d5d7aaf3e98e47b7d9665f50657d1628617b4ef47bc3bbd43d726fd77e

# Real, official Ubuntu universe package (not a third-party source),
# confirmed live to install cleanly on this exact image. Deliberately no
# USER switch: the base image itself declares no USER (defaults to root)
# because its ENTRYPOINT (/init, s6-overlay) needs to start as root to do
# its own internal PUID/PGID privilege drop at container runtime - not
# live-tested that overriding it here would break that, just not risked.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends blender \
 && rm -rf /var/lib/apt/lists/*
