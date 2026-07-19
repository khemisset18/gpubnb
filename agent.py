#!/usr/bin/env python3
import os,time,json,subprocess,base64,urllib.request,urllib.error,tempfile
from datetime import datetime,timezone
from nacl.signing import SigningKey
import base58
API=os.environ.get('GPUBNB_API','http://localhost:8787').rstrip('/'); MACHINE=os.environ['GPUBNB_MACHINE_ID']; KEY=SigningKey(base64.b64decode(os.environ['GPUBNB_AGENT_PRIVATE_KEY'])); INTERVAL=max(5,int(os.environ.get('GPUBNB_INTERVAL','10'))); COUNTER_FILE=os.environ.get('GPUBNB_COUNTER_FILE',os.path.join(os.path.expanduser('~'),'.gpubnb-counter'));
try:
 counter=max(int(os.environ.get('GPUBNB_COUNTER_START','0')),int(open(COUNTER_FILE).read().strip()))
except Exception:
 counter=int(os.environ.get('GPUBNB_COUNTER_START','0'))
def save_counter(value):
 directory=os.path.dirname(COUNTER_FILE) or '.'; os.makedirs(directory,exist_ok=True); fd,tmp=tempfile.mkstemp(prefix='.counter-',dir=directory,text=True)
 try:
  with os.fdopen(fd,'w') as f: f.write(str(value)); f.flush(); os.fsync(f.fileno())
  os.replace(tmp,COUNTER_FILE)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
def request_json(url,method='GET',body=None):
 data=None if body is None else json.dumps(body).encode(); req=urllib.request.Request(url,data=data,headers={'content-type':'application/json','user-agent':'gpubnb-agent/0.2'},method=method)
 with urllib.request.urlopen(req,timeout=8) as r:return json.loads(r.read().decode())
def gpu():
 p=subprocess.run(['nvidia-smi','--query-gpu=name,uuid,memory.total,memory.used,driver_version,temperature.gpu,utilization.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=5,check=True)
 rows=[]
 for line in p.stdout.splitlines():
  x=[v.strip() for v in line.split(',')]; rows.append(dict(gpuModel=x[0],gpuUuid=x[1],vramMiB=int(x[2]),memoryUsedMiB=int(x[3]),driverVersion=x[4],temperatureC=int(x[5]),gpuUtilization=int(x[6])))
 if not rows: raise RuntimeError('no NVIDIA GPU detected')
 return rows[0]
def cuda_probe():
 try:
  p=subprocess.run(['nvidia-smi','-q','-d','COMPUTE'],capture_output=True,text=True,timeout=5); return p.returncode==0
 except Exception:return False
def heartbeat():
 global counter; counter+=1; save_counter(counter); challenge=request_json(f'{API}/agent/challenge/{MACHINE}')['challenge']; g=gpu(); ts=datetime.now(timezone.utc).isoformat().replace('+00:00','Z'); session=os.environ.get('GPUBNB_SESSION_ID') or None; probe=cuda_probe()
 fields=[MACHINE,str(counter),challenge,ts,g['gpuUuid'],g['gpuModel'],str(g['vramMiB']),g['driverVersion'],str(g['gpuUtilization']),str(g['memoryUsedMiB']),str(g['temperatureC']),str(probe).lower(),session or '']; signature=base58.b58encode(KEY.sign('|'.join(fields).encode()).signature).decode()
 return request_json(f'{API}/agent/heartbeat','POST',{'machineId':MACHINE,'counter':counter,'challenge':challenge,'timestamp':ts,**g,'cudaProbeOk':probe,'sessionId':session,'signature':signature})
while True:
 try: print(json.dumps(heartbeat(),separators=(',',':')))
 except Exception as e: print(f'heartbeat_error:{type(e).__name__}:{e}',flush=True)
 time.sleep(INTERVAL)
