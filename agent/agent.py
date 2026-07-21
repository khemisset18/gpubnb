#!/usr/bin/env python3
"""GPUbnb signed telemetry agent. Never run as root."""
import os,time,json,subprocess,base64,urllib.request,tempfile,ssl,hashlib
from datetime import datetime,timezone
from nacl.signing import SigningKey
import base58

API=os.environ.get('GPUBNB_API','http://localhost:8787').rstrip('/')
ENV=os.environ.get('GPUBNB_ENV','development')
if ENV=='production' and not API.startswith('https://'): raise RuntimeError('production agent requires HTTPS')
if hasattr(os,'geteuid') and os.geteuid()==0 and ENV=='production': raise RuntimeError('production agent must not run as root')
MACHINE=os.environ['GPUBNB_MACHINE_ID']
_raw_key=base64.b64decode(os.environ['GPUBNB_AGENT_PRIVATE_KEY'],validate=True)
if len(_raw_key)!=32: raise RuntimeError('GPUBNB_AGENT_PRIVATE_KEY must decode to 32 bytes')
KEY=SigningKey(_raw_key)
INTERVAL=max(5,min(60,int(os.environ.get('GPUBNB_INTERVAL','10'))))
COUNTER_FILE=os.environ.get('GPUBNB_COUNTER_FILE',os.path.join(os.path.expanduser('~'),'.gpubnb-counter'))
CA_FILE=os.environ.get('GPUBNB_CA_FILE')
SSL_CONTEXT=ssl.create_default_context(cafile=CA_FILE) if CA_FILE else ssl.create_default_context()
try: counter=max(int(os.environ.get('GPUBNB_COUNTER_START','0')),int(open(COUNTER_FILE).read().strip()))
except Exception: counter=int(os.environ.get('GPUBNB_COUNTER_START','0'))

def save_counter(value):
 directory=os.path.dirname(COUNTER_FILE) or '.'; os.makedirs(directory,mode=0o700,exist_ok=True); fd,tmp=tempfile.mkstemp(prefix='.counter-',dir=directory,text=True)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,'w') as f: f.write(str(value)); f.flush(); os.fsync(f.fileno())
  os.replace(tmp,COUNTER_FILE)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)

def signed_headers(method,path):
 epoch=int(time.time()*1000); canonical=f'{method.upper()}|{path}|{MACHINE}|{epoch}'
 sig=base58.b58encode(KEY.sign(canonical.encode()).signature).decode()
 return {'x-agent-timestamp':str(epoch),'x-agent-signature':sig}

def request_json(path,method='GET',body=None,headers=None):
 data=None if body is None else json.dumps(body,separators=(',',':')).encode()
 h={'content-type':'application/json','user-agent':'gpubnb-agent/0.4',**(headers or {})}
 req=urllib.request.Request(API+path,data=data,headers=h,method=method)
 with urllib.request.urlopen(req,timeout=8,context=SSL_CONTEXT) as r:
  if r.status<200 or r.status>=300: raise RuntimeError(f'HTTP {r.status}')
  return json.loads(r.read(1_000_000).decode())

def gpu():
 p=subprocess.run(['nvidia-smi','--query-gpu=name,uuid,memory.total,memory.used,driver_version,temperature.gpu,utilization.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=5,check=True,env={'PATH':'/usr/bin:/bin'})
 rows=[]
 for line in p.stdout.splitlines():
  x=[v.strip() for v in line.split(',')]
  if len(x)!=7: continue
  rows.append(dict(gpuModel=x[0][:200],gpuUuid=x[1][:200],vramMiB=int(x[2]),memoryUsedMiB=int(x[3]),driverVersion=x[4][:100],temperatureC=int(x[5]),gpuUtilization=int(x[6])))
 if len(rows)!=1: raise RuntimeError('agent requires exactly one assigned NVIDIA GPU')
 g=rows[0]
 if not (0<=g['memoryUsedMiB']<=g['vramMiB']<=1_000_000 and -20<=g['temperatureC']<=130 and 0<=g['gpuUtilization']<=100): raise RuntimeError('invalid GPU telemetry')
 return g

def cuda_probe():
 try:return subprocess.run(['nvidia-smi','-q','-d','COMPUTE'],capture_output=True,text=True,timeout=5,env={'PATH':'/usr/bin:/bin'}).returncode==0
 except Exception:return False

def heartbeat():
 global counter
 path=f'/agent/challenge/{MACHINE}'
 challenge=request_json(path,headers=signed_headers('GET',path))['challenge']
 g=gpu(); counter+=1; save_counter(counter)
 ts=datetime.now(timezone.utc).isoformat().replace('+00:00','Z'); session=os.environ.get('GPUBNB_SESSION_ID') or None; probe=cuda_probe()
 fields=[MACHINE,str(counter),challenge,ts,g['gpuUuid'],g['gpuModel'],str(g['vramMiB']),g['driverVersion'],str(g['gpuUtilization']),str(g['memoryUsedMiB']),str(g['temperatureC']),str(probe).lower(),session or '']
 signature=base58.b58encode(KEY.sign('|'.join(fields).encode()).signature).decode()
 return request_json('/agent/heartbeat','POST',{'machineId':MACHINE,'counter':counter,'challenge':challenge,'timestamp':ts,**g,'cudaProbeOk':probe,'sessionId':session,'signature':signature})

failures=0
while True:
 try:
  print(json.dumps(heartbeat(),separators=(',',':')),flush=True); failures=0
 except Exception as e:
  failures=min(failures+1,8); print(f'heartbeat_error:{type(e).__name__}:{str(e)[:200]}',flush=True)
 time.sleep(min(300,INTERVAL*(2**failures)) if failures else INTERVAL)
