#!/usr/bin/env sh
set -eu
# Deliberately scoped to only what is honestly provable without a real
# /dev/dri render node: that the HTTP interface this image serves is alive.
# This does NOT check GPU rendering - there is no way to check that here,
# and claiming otherwise would be exactly the kind of fake healthcheck
# this project's mission explicitly forbids. See NOT_YET_WORKING.md.
curl -fsS -o /dev/null http://127.0.0.1:3000/ || wget -q -O /dev/null http://127.0.0.1:3000/
