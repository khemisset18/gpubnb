#!/bin/sh
set -eu
test -w /workspace || { echo "writable_renter_volume_required" >&2; exit 1; }
# Jupyter authentication is enforced by the rented Gateway, not a public port.
exec start-notebook.py --ServerApp.ip=0.0.0.0 --ServerApp.port=3000 \
  --ServerApp.token='' --ServerApp.password=''
