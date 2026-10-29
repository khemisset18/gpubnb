#!/bin/sh
set -eu
test "$(id -u)" -ne 0
python - <<'PY'
import json
from urllib.request import urlopen
with urlopen("http://127.0.0.1:3000/healthz", timeout=5) as reply:
    assert reply.status == 200
    assert json.load(reply)["ready"] is True
PY
