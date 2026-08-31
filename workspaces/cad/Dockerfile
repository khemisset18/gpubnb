# NOT YET WORKING - see NOT_YET_WORKING.md and
# workspaces/cloud-desktop/NOT_YET_WORKING.md (same shared base, same
# open GPU-rendering and container-hardening questions - not repeated here).
# Not in executableWorkspaceSlugs, not bookable.
FROM linuxserver/webtop@sha256:1bd141d5d7aaf3e98e47b7d9665f50657d1628617b4ef47bc3bbd43d726fd77e

# FreeCAD, GPL, real. NOT from Ubuntu's own official repo - confirmed live
# this exact image already has the well-known, actively-maintained
# `xtradeb` PPA configured (Ubuntu's own official repo version lags behind
# upstream FreeCAD releases). Documented explicitly since this is a
# meaningfully different trust level than Blender/Steam's own official
# Ubuntu-repo packages - a real decision point before shipping, not hidden.
# Deliberately no USER switch - see workspaces/creator/Dockerfile's comment.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends freecad \
 && rm -rf /var/lib/apt/lists/*
