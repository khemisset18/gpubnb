#!/usr/bin/env python3
"""Qualify exact backports against a disposable copy of the active workspace.

The checked-out application's Cargo files are never modified by this runner. Native blockchain,
wallet, SBF tooling, signing, deployment and vulnerability exemptions are absent.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tomllib
import urllib.request

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def file_hashes(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*')) if p.is_file()}


def download(url, path, expected):
    assert url.startswith('https://static.crates.io/crates/')
    with urllib.request.urlopen(url, timeout=45) as response:
        data = response.read(4*1024*1024 + 1)
    assert len(data) <= 4*1024*1024, 'crate archive bound'
    assert hashlib.sha256(data).hexdigest() == expected, 'crate archive SHA256 mismatch'
    Path(path).write_bytes(data)


def extract(archive, destination, prefix):
    with tarfile.open(archive) as tar:
        entries = tar.getmembers()
        assert 0 < len(entries) <= 800 and sum(e.size for e in entries) <= 16*1024*1024
        for entry in entries:
            path = PurePosixPath(entry.name)
            assert not path.is_absolute() and '..' not in path.parts and path.parts[0] == prefix
            assert entry.isfile() or entry.isdir(), 'archive links and special files forbidden'
        tar.extractall(destination, filter='data')


def patch_source(source, pin):
    before = file_hashes(source)
    target = source / pin['file']
    assert digest(target) == pin['beforeSha256'], 'patch preimage mismatch'
    subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1',
                    '-i', str(HERE / pin['patch'])], cwd=source, check=True,
                   capture_output=True, text=True, timeout=10)
    assert digest(target) == pin['afterSha256'], 'patched source SHA256 mismatch'
    after = file_hashes(source)
    assert set(before) == set(after), 'backport added or removed crate files'
    assert [p for p in before if before[p] != after[p]] == [pin['file']], 'unexpected crate change'
    manifest = tomllib.loads((source/'Cargo.toml').read_text())
    assert manifest['package']['name'] == pin['name'] and manifest['package']['version'] == pin['version']
    return {'files':len(after), 'changedFiles':[pin['file']], 'patchedFileSha256':digest(target)}


def run(command, cwd, output, *, timeout=900, env=None):
    with output.open('wb') as log:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log,
                                stderr=subprocess.STDOUT, timeout=timeout)
    assert result.returncode == 0, f'command failed ({result.returncode}); see {output.name}'


def check_selected_sources(metadata, project, pins):
    for pin in pins['patches']:
        found=[p for p in metadata['packages'] if p['name']==pin['name'] and p['version']==pin['version']]
        assert len(found)==1 and found[0]['source'] is None, 'patched dependency not selected'
        source=Path(found[0]['manifest_path']).parent
        assert source == project/pin['vendorPath'], 'unexpected patched dependency path'
        assert digest(source/pin['file']) == pin['afterSha256'], 'selected source digest mismatch'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fresh_work_directory', type=Path)
    parser.add_argument('--prepare-only', action='store_true')
    args=parser.parse_args()
    work=args.fresh_work_directory.resolve()
    work.mkdir(mode=0o700, parents=False, exist_ok=False)
    pins=json.loads((HERE/'source-pins.json').read_text())
    assert [(p['name'],p['version']) for p in pins['patches']] == [('glib','0.18.5'),('rand','0.7.3')]
    report={'schemaVersion':1,'result':'FAIL','scope':'actual active vendored sources; disposable regression workspace',
            'qualificationStatus':'BLOCKED','scannerExemptionAdded':False,'packageVersionsSpoofed':False,
            'nativeBlockchainEffects':False,'backports':[]}
    def save():
        (work/'report.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
    save()
    vendor=work/'verified-sources';vendor.mkdir()
    for pin in pins['patches']:
        archive=work/(pin['name']+'.crate')
        download(f"https://static.crates.io/crates/{pin['name']}/{pin['name']}-{pin['version']}.crate",
                 archive,pin['archiveSha256'])
        prefix=pin['name']+'-'+pin['version']
        extract(archive,vendor,prefix)
        source=vendor/prefix
        vcs=json.loads((source/'.cargo_vcs_info.json').read_text())
        assert vcs['git']['sha1'] == pin['archiveGitCommit']
        observed=patch_source(source,pin)
        report['backports'].append({'name':pin['name'],'version':pin['version'],
            'archiveSha256':digest(archive),'advisory':pin['advisory'],**observed});save()
    if args.prepare_only:
        report.update(result='PREPARATION_PASS',nativeTests='NOT_TESTED');save();print(json.dumps(report));return
    repository=Path(subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=HERE,text=True).strip())
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repository,text=True).strip()
    subprocess.run(['git','diff','--exit-code',pins['baseCommit'],revision,'--',
                    'programs/gpu_escrow','apps/host-desktop/src-tauri'],cwd=repository,check=True)
    original_manifest=subprocess.check_output(['git','show',pins['baseCommit']+':Cargo.toml'],cwd=repository,text=True)
    expected_manifest=original_manifest+'\n[patch.crates-io]\n'+''.join(p['name']+' = { path = '+json.dumps(p['vendorPath'])+' }\n' for p in pins['patches'])
    assert (repository/'Cargo.toml').read_text()==expected_manifest, 'unrelated active manifest change'
    original_lock=subprocess.check_output(['git','show',pins['baseCommit']+':Cargo.lock'],cwd=repository,text=True)
    expected_lock=original_lock
    for pin in pins['patches']:
        marker=f'name = "{pin["name"]}"\nversion = "{pin["version"]}"\n'
        old=marker+'source = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "'+pin['archiveSha256']+'"\n'
        assert expected_lock.count(old)==1
        expected_lock=expected_lock.replace(old,marker)
        assert file_hashes(repository/pin['vendorPath'])==file_hashes(vendor/(pin['name']+'-'+pin['version'])), 'vendored crate differs from independently verified backport'
    assert (repository/'Cargo.lock').read_text()==expected_lock, 'unrelated active lock change'
    project=work/'project'
    subprocess.run(['git','worktree','add','--detach',str(project),revision],cwd=repository,check=True,capture_output=True)
    report['executionCommit']=revision
    try:
        prod_files=['programs/gpu_escrow/src/lib.rs','apps/host-desktop/src-tauri/Cargo.toml']
        report['unchangedProductionSourceSha256']={p:digest(project/p) for p in prod_files}
        baseline=tomllib.loads((project/'Cargo.lock').read_text())
        baseline_ids={(p['name'],p['version']) for p in baseline['package']}
        lock=(project/'Cargo.lock').read_text()
        for pin in pins['patches']:
            match=[p for p in baseline['package'] if p['name']==pin['name'] and p['version']==pin['version']]
            assert len(match)==1 and 'source' not in match[0] and 'checksum' not in match[0]
        private_tmp=work/'tmp';private_tmp.mkdir(mode=0o700)
        env=os.environ.copy();env.update(CARGO_TARGET_DIR=str(work/'target'),CARGO_BUILD_JOBS='2',CARGO_PROFILE_DEV_DEBUG='0',TMPDIR=str(private_tmp))
        with (work/'active-metadata.json').open('wb') as stdout, (work/'active-metadata.log').open('wb') as stderr:
            subprocess.run(['cargo','metadata','--locked','--all-features','--format-version=1'],cwd=project,env=env,stdout=stdout,stderr=stderr,timeout=1200,check=True)
        check_selected_sources(json.loads((work/'active-metadata.json').read_text()),project,pins)
        report['activePatchedSourcesVerifiedBeforeExecution']=True;save()
        report['toolchain']={name:subprocess.check_output([name,'--version'],env=env,text=True).strip() for name in ['rustc','cargo']}
        # The sole new test crate deliberately enables Rand's optional logging
        # feature; keep the exact already-locked log package and all versions.
        block=re.search(r'\[\[package\]\]\nname = "rand"\nversion = "0.7.3"\n.*?(?=\n\[\[package\]\]|\Z)',lock,re.S)
        assert block and ' "log",' not in block[0]
        changed=block[0].replace('dependencies = [\n','dependencies = [\n "log",\n')
        lock=lock[:block.start()]+changed+lock[block.end():]
        lock+='\n[[package]]\nname = "gpubnb-security-backport-probe"\nversion = "0.0.0"\ndependencies = [\n "glib",\n "log",\n "rand 0.7.3",\n "rand_chacha 0.2.2",\n "rand_core 0.5.1",\n]\n'
        (project/'Cargo.lock').write_text(lock)
        manifest=(project/'Cargo.toml').read_text()
        assert '[patch.crates-io]' in manifest and manifest.count('members = [')==1
        manifest=manifest.replace('members = [','members = [\n  "prototypes/rust-compatible-backports/probe",',1)
        (project/'Cargo.toml').write_text(manifest)
        dist=repository/'apps/host-desktop/dist'
        assert dist.is_dir(), 'actual frontend build required before full Tauri check'
        shutil.copytree(dist,project/'apps/host-desktop/dist')
        report['frontendAssetSha256']=file_hashes(dist)
        for label,command in [
            ('metadata',['cargo','metadata','--locked','--all-features','--format-version=1']),
            ('security-regressions',['cargo','test','--locked','--release','-p','gpubnb-security-backport-probe','--','--nocapture']),
            ('anchor-host',['cargo','test','--locked','-p','gpu_escrow']),
            ('desktop-host',['cargo','test','--locked','-p','gpubnb-host-desktop','--all-targets']),
            ('tauri-native-compile',['cargo','check','--locked','-p','gpubnb-host-desktop','--features','desktop-runtime','--all-targets'])]:
            if label=='metadata':
                with (work/'metadata.json').open('wb') as stdout, (work/'metadata.log').open('wb') as stderr:
                    subprocess.run(command,cwd=project,env=env,stdout=stdout,stderr=stderr,timeout=1200,check=True)
                check_selected_sources(json.loads((work/'metadata.json').read_text()),project,pins)
            else:
                run(command,project,work/(label+'.log'),env=env,timeout=1200)
            report.setdefault('commands',[]).append({'name':label,'result':'PASS','command':command});save()
        metadata=json.loads((work/'metadata.json').read_text())
        candidate=tomllib.loads((project/'Cargo.lock').read_text())
        candidate_ids={(p['name'],p['version']) for p in candidate['package']}
        assert candidate_ids-baseline_ids == {('gpubnb-security-backport-probe','0.0.0')}
        assert not baseline_ids-candidate_ids, 'active package identity unexpectedly removed'
        check_selected_sources(metadata,project,pins)
        for path,expected in report['unchangedProductionSourceSha256'].items():assert digest(project/path)==expected
        shutil.copyfile(project/'Cargo.lock',work/'candidate-Cargo.lock')
        report.update(result='PASS',allOriginalPackageVersionsRetained=True,
            patchedPackagesReallySelected=True,fullGuiAndIpc='NOT_TESTED',SbfRuntime='NOT_TESTED',
            activeScannerDisposition='BLOCKED pending exact PR scanner result; package versions retained')
        save();print(json.dumps(report,indent=2))
    finally:
        subprocess.run(['git','worktree','remove','--force',str(project)],cwd=repository,check=True)


if __name__=='__main__':main()
