#!/bin/sh
set -eu
test "$(id -u)" -ne 0
python - <<'PY'
from urllib.request import urlopen
with urlopen("http://127.0.0.1:3000/api", timeout=5) as reply:
    assert reply.status == 200
PY
