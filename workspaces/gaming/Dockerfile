# NOT YET WORKING - see NOT_YET_WORKING.md and
# workspaces/cloud-desktop/NOT_YET_WORKING.md (same shared base, same
# open GPU-rendering and container-hardening questions - not repeated here).
# Not in executableWorkspaceSlugs, not bookable.
FROM linuxserver/webtop@sha256:1bd141d5d7aaf3e98e47b7d9665f50657d1628617b4ef47bc3bbd43d726fd77e

# Steam, real, official Ubuntu multiverse package (not a third-party or
# pirated source) - confirmed live to install cleanly with its i386 Mesa/
# GL dependencies, and its real launcher (/usr/games/steam) genuinely
# bootstraps (creates its real ~/.steam install dir) inside this exact
# image's live Xvfb display. GPUbnb redistributes no game and no Steam
# content - the renter brings their own Steam account and owned games.
# Deliberately no USER switch - see workspaces/creator/Dockerfile's comment.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends steam-installer \
 && rm -rf /var/lib/apt/lists/*
