#!/usr/bin/env python3
import re, sys
from pathlib import Path
if len(sys.argv) != 2: raise SystemExit('usage: sync-program-id.py PROGRAM_ID')
pid=sys.argv[1].strip()
if not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', pid): raise SystemExit('invalid Solana public key')
root=Path(__file__).resolve().parents[1]
lib=root/'programs/gpu_escrow/src/lib.rs'
s=lib.read_text(); s=re.sub(r'declare_id!\("[^"]+"\);', f'declare_id!("{pid}");', s); lib.write_text(s)
for f in [root/'.env.example', root/'apps/web/config.js']:
    if f.exists():
        t=f.read_text(); t=re.sub(r'Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m', pid, t); f.write_text(t)
print(pid)
