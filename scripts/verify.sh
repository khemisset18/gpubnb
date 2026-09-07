#!/usr/bin/env bash
set -euo pipefail
python3 -m py_compile agent/agent.py
node --check apps/web/app.js
node --check apps/web/config.js
node --check scripts/devnet-doctor.mjs
python3 - <<'PY'
import json
from pathlib import Path

env = Path('.env.example').read_text()
runtime_text = Path('deploy/runtime-processes.json').read_text()
runtime = json.loads(runtime_text)
migration = Path('apps/api/prisma/migrations/0001_initial/migration.sql').read_text()

assert 'ALLOW_MAINNET=false' in env
assert 'B5WQmXWHL8R86wf3LHLRE4aQAuRdRSz1EXKcwNQDqj2e' in env
assert runtime['image']['dockerfile'] == 'apps/api/Dockerfile'
assert runtime['image']['runtimeUser'] == 'app'
assert runtime['processes']['api']['command'] == 'node dist/server.js'
assert runtime['processes']['api']['healthPath'] == '/ready'
assert runtime['processes']['delivery-worker']['command'] == 'node dist/delivery-worker.js'
assert set(runtime['dependencies']['redis']['requiredSemantics']) >= {
    'ttl', 'getdel', 'set-nx', 'lua', 'lists', 'streams'
}
assert 'render' not in runtime_text.lower()
assert 'CREATE TABLE "User"' in migration and 'booking_no_overlap' in migration
print('provider-neutral static checks passed')
PY
