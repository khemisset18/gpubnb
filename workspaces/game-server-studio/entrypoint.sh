#!/bin/sh
set -eu
# Do not accept Mojang's EULA on behalf of the renter.
if [ "${GPUBNB_GAME_EULA_ACCEPTED:-}" != "TRUE" ]; then
  echo "minecraft_eula_not_accepted_by_renter" >&2
  exit 1
fi
test -w /workspace || { echo "writable_renter_world_required" >&2; exit 1; }
printf 'eula=true\n' > /workspace/eula.txt
# No outbound networking and no player ingress are available in GPUbnb yet.
exec java -Xms512M -Xmx4G -jar /opt/gpubnb-game/server.jar nogui
