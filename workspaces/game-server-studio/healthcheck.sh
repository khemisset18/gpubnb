#!/bin/sh
set -eu
test "$(id -u)" -ne 0
command -v java >/dev/null
test -s /opt/gpubnb-game/server.jar
# Actual TCP game-join and UDP ingress tests remain mandatory, not faked.
