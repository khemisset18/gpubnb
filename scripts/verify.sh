#!/usr/bin/env bash
set -euo pipefail
python3 -m py_compile agent/agent.py
node --check apps/web/app.js
node --check apps/web/config.js
node --check apps/web/auth.js
node --check apps/web/publish.js
node --test test/frontend.test.mjs
node --check scripts/devnet-doctor.mjs
node --check scripts/generate-web-config.mjs
bash -n sandbox/*.sh scripts/*.sh
python3 -c 'from pathlib import Path; env=Path(".env.example").read_text(); render=Path("render.yaml").read_text(); migration=Path("apps/api/prisma/migrations/0001_initial/migration.sql").read_text(); assert "ALLOW_MAINNET=false" in env; assert "B5WQmXWHL8R86wf3LHLRE4aQAuRdRSz1EXKcwNQDqj2e" in env; assert "plan: free" in render and "region: frankfurt" in render; assert "CREATE TABLE \"User\"" in migration and "booking_no_overlap" in migration; assert "DIRECT_URL" not in render; print("static checks passed")'
