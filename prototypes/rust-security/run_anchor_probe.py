#!/usr/bin/env python3
"""Host-only comparison; never starts a node/signer, signs or submits transactions."""
import argparse,collections,hashlib,json,os,re,shutil,subprocess,sys,urllib.request
from pathlib import Path
BASE='470926f416cf84caa4a407f219c72d6984f3a45b'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 parser=argparse.ArgumentParser();parser.add_argument('fresh_work_dir',type=Path);args=parser.parse_args();work=args.fresh_work_dir.resolve();work.mkdir(mode=0o700,exist_ok=False)
 here=Path(__file__).resolve().parent;repo=here.parents[1];env=os.environ.copy()
 def run(cmd,label,cwd=repo,extra=None):
  e=env.copy();e.update(extra or {})
  with (work/(label+'.log')).open('wb') as log:r=subprocess.run(cmd,cwd=cwd,env=e,stdout=log,stderr=subprocess.STDOUT,timeout=600)
  if r.returncode:raise RuntimeError('command failed; inspect '+str(work/(label+'.log')))
 def original(path):return subprocess.check_output(['git','show',BASE+':'+path],cwd=repo)
 source='programs/gpu_escrow/src/lib.rs'
 if (repo/source).read_bytes()!=original(source):raise RuntimeError('financial source differs from frozen baseline')
 baseline=work/'baseline';program=baseline/'programs/gpu_escrow';(program/'src').mkdir(parents=True)
 (program/'src/lib.rs').write_bytes(original(source));(baseline/'Cargo.lock').write_bytes(original('Cargo.lock'))
 (baseline/'Cargo.toml').write_text('[workspace]\nmembers=["programs/gpu_escrow"]\nresolver="2"\n')
 m=original('programs/gpu_escrow/Cargo.toml').decode();assert 'anchor-lang="0.31.1"' in m
 (program/'Cargo.toml').write_text(m.replace('default=[]','default=[]\nidl-build=["anchor-lang/idl-build"]'))
 for folder,name in [('examples','abi_snapshot.rs'),('tests','migration_abi.rs')]:
  (program/folder).mkdir();(program/folder/name).write_bytes((repo/'programs/gpu_escrow'/folder/name).read_bytes())
 # Only the isolated baseline's generated lock resolves its newly enabled IDL deps.
 run(['cargo','test','-p','gpu_escrow','--features','idl-build','--lib','--test','migration_abi'],'baseline-tests',baseline,{'ANCHOR_IDL_BUILD_PROGRAM_PATH':str(program)})
 run(['cargo','test','--locked','-p','gpu_escrow','--lib','--test','migration_abi'],'candidate-tests')
 snapshots=[];idls={}
 for label,root in [('baseline',baseline),('candidate',repo)]:
  e=env.copy();e['ANCHOR_IDL_BUILD_PROGRAM_PATH']=str(root/'programs/gpu_escrow')
  out=work/('abi-'+label+'.tsv')
  with out.open('wb') as f, (work/('abi-'+label+'-build.log')).open('wb') as err:subprocess.run(['cargo','run','--locked','-p','gpu_escrow','--example','abi_snapshot'],cwd=root,env=e,stdout=f,stderr=err,check=True,timeout=600)
  snapshots.append(out)
  run(['cargo','test','--locked','-p','gpu_escrow','--features','idl-build','__anchor_private_print_idl','--','--show-output'],'idl-'+label,root,{'ANCHOR_IDL_BUILD_PROGRAM_PATH':e['ANCHOR_IDL_BUILD_PROGRAM_PATH']})
  sections=collections.defaultdict(list)
  for match in re.finditer(r'--- IDL begin ([^\n]+) ---\n(.*?)\n--- IDL end \1 ---',(work/('idl-'+label+'.log')).read_text(),re.S):sections[match.group(1)].append(json.loads(match.group(2)))
  idls[label]={k:sorted(v,key=lambda x:json.dumps(x,sort_keys=True)) for k,v in sections.items()};(work/('idl-'+label+'.json')).write_text(json.dumps(idls[label],indent=2,sort_keys=True)+'\n')
 run([sys.executable,str(here/'verify_abi.py'),*[str(p) for p in snapshots]],'independent-abi')
 old=idls['baseline'];new=idls['candidate'];raw=old==new
 assert old['address']==['"Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m"'];assert new['address']==['Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m'];assert len(old['event'])==10;assert len(old['program'])==1
 old['address']=[json.loads(old['address'][0])]
 if old!=new:raise RuntimeError('IDL semantic mismatch beyond exact asserted address-print correction')
 pins=json.loads((here/'crypto/PUBLIC_VECTOR_SOURCE.json').read_text());vectors=work/'wycheproof.json';urllib.request.urlretrieve('https://raw.githubusercontent.com/C2SP/wycheproof/'+pins['commit']+'/'+pins['file'],vectors)
 if sha(vectors)!=pins['sha256']:raise RuntimeError('public vector digest mismatch')
 for label,version in [('baseline','0.6.0'),('candidate','0.7.2')]:
  crate=work/('crypto-'+label);shutil.copytree(here/'crypto',crate)
  if label=='baseline':
   p=crate/'Cargo.toml';p.write_text(p.read_text().replace('=0.7.2','=0.6.0'));(crate/'Cargo.lock').unlink()
  cmd=['cargo','run','--manifest-path',str(crate/'Cargo.toml')]
  if label=='candidate':cmd.append('--locked')
  with (work/('crypto-'+label+'.json')).open('wb') as out,(work/('crypto-'+label+'-build.log')).open('wb') as err:subprocess.run(cmd+['--',str(vectors)],cwd=work,env=env,stdout=out,stderr=err,check=True,timeout=600)
  result=json.loads((work/('crypto-'+label+'.json')).read_text());assert result['status']=='PASS' and result['count']==476
 a=json.loads((work/'crypto-baseline.json').read_text());b=json.loads((work/'crypto-candidate.json').read_text());assert a==b
 report={'status':'PASS_HOST_PROTOTYPE_ONLY','independentAbiFixtures':30,'wycheproofVectorsPerVersion':476,'rawIdlIdentical':raw,'semanticIdlAfterAssertedAddressDecode':'PASS','financialSourceSha256':sha(repo/source),'baseCommit':BASE,'notTested':['SBF runtime','CPI/account constraints','client migration','deployment','on-chain signatures']};(work/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__':main()
