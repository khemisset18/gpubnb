#!/usr/bin/env python3
"""Independent SHA-256/LE integer fixtures; no chain, signing, or RPC."""
import hashlib,json,struct,sys
from pathlib import Path
k=lambda n:bytes([n])*32
u64=lambda n:struct.pack('<Q',n)
u32=lambda n:struct.pack('<I',n)
i64=lambda n:struct.pack('<q',n)
def disc(kind,name):return hashlib.sha256(f'{kind}:{name}'.encode()).digest()[:8]
def b58(s):
 n=0
 for c in s:n=n*58+'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.index(c)
 return n.to_bytes(32,'big')
e={'program_id':b58('Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m')}
e['account:Config']=disc('account','Config')+k(1)+k(2)+k(3)+k(4)+bytes([1,254])
e['account:Escrow']=disc('account','Escrow')+k(5)+k(6)+k(7)+u64(2**64-1)+u32(86400)+u32(43200)+i64(1700000000)+i64(1700003600)+bytes([2,253])
ix={'initialize_config':k(3)+k(4),'update_config':k(3)+k(4),'set_paused':b'\1','propose_admin':k(2),'accept_admin':b'','open':k(5)+u64(2**64-1)+u32(86400)+i64(1700000000),'propose_settlement':u32(43200),'dispute':b'','finalize':b'','resolve_dispute':u32(43200),'refund_expired':b''}
for name,data in ix.items():e['ix:'+name]=disc('global',name)+data
ev={'ConfigInitialized':k(1)+k(3)+k(4),'ConfigUpdated':k(3)+k(4),'PauseChanged':b'\1','AdminTransferProposed':k(1)+k(2),'AdminTransferred':k(1)+k(2),'EscrowOpened':k(8)+k(5)+k(6)+k(7)+u64(2**64-1)+u32(86400)+i64(1700000000),'SettlementProposed':k(8)+u32(43200)+i64(1700003600),'EscrowDisputed':k(8)+k(6),'EscrowSettled':k(8)+u64(100)+u64(5)+u64(95)+u64(0)+u32(43200),'EscrowRefunded':k(8)+k(6)+u64(2**64-1)}
for name,data in ev.items():e['event:'+name]=disc('event',name)+data
for i,(n,signer,writable) in enumerate([(1,0,0),(6,1,1),(7,0,0),(8,0,1),(9,0,0)]):e['open_meta:'+str(i)]=k(n)+bytes([signer,writable])
e['state_values']=bytes(range(5))
expected={k:v.hex() for k,v in e.items()}
results=[]
for name in sys.argv[1:]:
 p=Path(name);actual=dict(line.split('\t') for line in p.read_text().splitlines())
 if actual!=expected:
  bad=[k for k in sorted(actual.keys()|expected.keys()) if actual.get(k)!=expected.get(k)]
  raise SystemExit('ABI mismatch '+str(p)+': '+str(bad))
 results.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'fixtures':len(e),'status':'PASS'})
print(json.dumps({'status':'PASS','independentFixtures':len(e),'results':results,'notTested':['SBF execution','on-chain account constraints','client migration','deployment']},indent=2))
