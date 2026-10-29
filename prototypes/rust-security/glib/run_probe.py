#!/usr/bin/env python3
"""Reproduce the exact official GLib fix on native runtime; no GUI or network service.
Downloads only the hash-pinned crate/fixed source, then compiles public test code.
Requires cargo/rustc plus system GLib development metadata and pkg-config.
"""
import argparse,hashlib,json,os,resource,shutil,signal,subprocess,tarfile,urllib.request
from pathlib import Path
PINS={'archive':'233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5'}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def download(url,path,digest):
 urllib.request.urlretrieve(url,path)
 if sha(path)!=digest:raise RuntimeError('download SHA-256 mismatch: '+url)
def bounded():
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_AS,(256*1024**2,256*1024**2))
def main():
 a=argparse.ArgumentParser();a.add_argument('fresh_work_dir',type=Path);args=a.parse_args();work=args.fresh_work_dir.resolve();work.mkdir(mode=0o700,parents=False,exist_ok=False)
 here=Path(__file__).resolve().parent; pins=json.loads((here.parent/'evidence/glib-source-provenance.json').read_text())
 archive=work/'glib.crate';download('https://crates.io/api/v1/crates/glib/0.18.5/download',archive,PINS['archive'])
 with tarfile.open(archive) as t:t.extractall(work,filter='data')
 baseline=work/'glib-0.18.5';candidate=work/'glib-0.18.5-patched';shutil.copytree(baseline,candidate)
 p=candidate/'src/variant_iter.rs'
 if sha(p)!=pins['originalFileSha256']:raise RuntimeError('original source hash mismatch')
 s=p.read_text();old='let p: *mut libc::c_char = std::ptr::null_mut();';arg='                &p,'
 if s.count(old)!=1 or s.count(arg)!=1:raise RuntimeError('patch preimage mismatch')
 p.write_text(s.replace(old,'let mut p: *mut libc::c_char = std::ptr::null_mut();').replace(arg,'                &mut p,'))
 if sha(p)!=pins['patchedFileSha256']:raise RuntimeError('patched source hash mismatch')
 official=work/'official-fixed.rs';download('https://raw.githubusercontent.com/gtk-rs/gtk-rs-core/'+pins['upstreamFixCommit']+'/glib/src/variant_iter.rs',official,pins['patchedFileSha256'])
 results=[]
 for label,source in [('baseline',baseline),('candidate',candidate)]:
  crate=work/('probe-'+label);(crate/'src').mkdir(parents=True)
  (crate/'src/main.rs').write_bytes((here/'src/main.rs').read_bytes());(crate/'Cargo.toml').write_text((here/'Cargo.toml.template').read_text().replace('@VERIFIED_GLIB_SOURCE@',str(source)))
  env=os.environ.copy();env['CARGO_TARGET_DIR']=str(work/('target-'+label))
  with (work/(label+'-build.log')).open('wb') as log:subprocess.run(['cargo','build','--release','--manifest-path',str(crate/'Cargo.toml')],env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=600)
  binary=Path(env['CARGO_TARGET_DIR'])/'release/glib-variant-security-probe';r=subprocess.run([str(binary)],env=env,capture_output=True,text=True,timeout=15,preexec_fn=bounded)
  results.append({'label':label,'returncode':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'binarySha256':sha(binary),'result':'PASS' if r.returncode==0 else 'FAIL'})
  (work/(label+'-linkage.log')).write_text(subprocess.check_output(['ldd',str(binary)],env=env,text=True))
 report={'candidateStatus':'PASS' if results[1]['returncode']==0 else 'FAIL','baselineStatus':results[0]['result'],'negativeControlReproduced':results[0]['returncode']==-signal.SIGSEGV,'scannerStatus':'BLOCKED: package remains version0.18.5; no scanner exception/version spoof','fullGtkWebkitTauri':'NOT TESTED','results':results};(work/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
 if report['candidateStatus']!='PASS' or not report['negativeControlReproduced']:raise SystemExit(1)
if __name__=='__main__':main()
