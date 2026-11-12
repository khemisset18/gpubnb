#!/usr/bin/env python3
"""Qualify public host recovery through the actual unchanged Anchor/Solana API."""
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

import oracle

HERE = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def hashes(root):
    return {str(p.relative_to(root)).replace('\\', '/'): sha(p)
            for p in sorted(root.rglob('*')) if p.is_file()}


def write_json(path, value):
    path.write_bytes((json.dumps(value, indent=2, sort_keys=True)+'\n').encode())


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo)


def lock_delta(before, after):
    old = {(p['name'], p['version']): p for p in before['package']}
    new = {(p['name'], p['version']): p for p in after['package']}
    return {'removed': [list(x) for x in sorted(old.keys()-new.keys())],
            'added': [list(x) for x in sorted(new.keys()-old.keys())],
            'changedExisting': [{'package': list(k), 'before': old[k], 'after': new[k]}
                                for k in sorted(old.keys() & new.keys()) if old[k] != new[k]]}


def validate_committed(repo, pins):
    assert hashes(repo/pins['vendorPath']) == pins['vendorFiles'], 'committed vendor source mismatch'
    assert sha(HERE/'backport.patch') == pins['patchSha256'], 'backport patch mismatch'
    assert sha(HERE/'public-recovery-fixtures.json') == pins['publicFixtureSha256'], 'public fixture mismatch'
    assert sha(repo/'programs/gpu_escrow/src/lib.rs') == pins['financialSourceSha256'], 'financial source changed'
    assert sha(repo/'Cargo.lock') == pins['activeCargoLockSha256'], 'active lock changed'
    base = pins['baseCommit']
    original_manifest = git(repo, 'show', base+':Cargo.toml').decode()
    expected = original_manifest+'\n[patch.crates-io]\nsolana-secp256k1-recover = { path = "'+pins['vendorPath']+'" }\n'
    assert (repo/'Cargo.toml').read_text() == expected, 'unrelated workspace manifest change'
    original_program = git(repo, 'show', base+':programs/gpu_escrow/Cargo.toml').decode()
    assert (repo/'programs/gpu_escrow/Cargo.toml').read_text() == original_program+'\n[dev-dependencies]\nserde_json = "=1.0.151"\n', 'unrelated program dependency change'
    original_lock = tomllib.loads(git(repo, 'show', base+':Cargo.lock').decode())
    candidate_lock = tomllib.loads((repo/'Cargo.lock').read_text())
    assert lock_delta(original_lock, candidate_lock) == pins['lockDelta'], 'unreviewed lock graph change'
    old = {(p['name'], p['version']): p for p in original_lock['package']}
    new = {(p['name'], p['version']): p for p in candidate_lock['package']}
    for key in [('anchor-lang', '0.31.1'), ('borsh', '0.10.4'), ('glib', '0.18.5')]:
        assert old[key] == new[key], 'unreviewed Anchor/Borsh/GLib migration'
    assert not any(n.startswith('libsecp256k1') or (n == 'rand' and v.startswith('0.7.')) for n, v in new), 'old recovery/Rand package still active'
    for name, minimum in [('crypto-bigint', (0, 7, 6)), ('ctutils', (0, 4, 4))]:
        selected = [v for n, v in new if n == name]
        assert selected and all(tuple(map(int, v.split('.'))) >= minimum for v in selected), 'unpatched crypto dependency'


def download(url, target, expected):
    assert url.startswith(('https://static.crates.io/crates/', 'https://raw.githubusercontent.com/'))
    with urllib.request.urlopen(url, timeout=45) as response:
        raw = response.read(4*1024*1024+1)
    assert len(raw) <= 4*1024*1024 and hashlib.sha256(raw).hexdigest() == expected, 'download SHA256 mismatch'
    target.write_bytes(raw)


def extract(archive, destination):
    with tarfile.open(archive) as tar:
        entries = tar.getmembers()
        assert 0 < len(entries) <= 20 and sum(e.size for e in entries) < 4*1024*1024
        for entry in entries:
            p = PurePosixPath(entry.name)
            assert not p.is_absolute() and '..' not in p.parts and p.parts[0] == 'solana-secp256k1-recover-2.2.1'
            assert entry.isfile() or entry.isdir(), 'archive links/special files refused'
        tar.extractall(destination, filter='data')


def rebuild_source(work, repo, pins):
    archive, license_path, upstream = work/'recovery.crate', work/'upstream-LICENSE', work/'upstream-host.rs'
    download('https://static.crates.io/crates/solana-secp256k1-recover/solana-secp256k1-recover-2.2.1.crate', archive, pins['archiveSha256'])
    download('https://raw.githubusercontent.com/anza-xyz/solana-sdk/'+pins['archiveSourceCommit']+'/LICENSE', license_path, pins['licenseSha256'])
    download('https://raw.githubusercontent.com/anza-xyz/solana-sdk/'+pins['upstreamMigrationCommit']+'/secp256k1-recover/src/lib.rs', upstream, pins['upstreamMigrationSourceSha256'])
    extract(archive, work)
    source = work/'solana-secp256k1-recover-2.2.1'
    assert json.loads((source/'.cargo_vcs_info.json').read_text())['git']['sha1'] == pins['archiveSourceCommit']
    assert sha(source/'src/lib.rs') == pins['originalSourceSha256']
    original = (source/'src/lib.rs').read_text()
    assert sha(source/'Cargo.lock') == pins['omittedUnusedSupplierLockSha256']
    subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-i', str(HERE/'backport.patch')], cwd=source, check=True, capture_output=True, timeout=15)
    (source/'Cargo.lock').unlink()
    shutil.copyfile(license_path, source/'LICENSE')
    assert hashes(source) == pins['vendorFiles'], 'backport did not reproduce exact source/license files'
    active = (repo/pins['vendorPath']/'src/lib.rs').read_text()
    marker = '    #[cfg(not(target_os = "solana"))]\n'
    assert active == '// GPUbnb host-only compatibility backport, 2026-11-12. See BACKPORT.md.\n'+original.split(marker)[0]+marker+upstream.read_text().split(marker)[1].replace('to_encoded_point(false)', 'to_sec1_point(false)'), 'host implementation differs from exact upstream adaptation'
    start = original.index('    #[cfg(target_os = "solana")]\n', original.index('pub fn secp256k1_recover('))
    assert hashlib.sha256(original[start:original.index(marker, start)].encode()).hexdigest() == pins['unchangedSolanaSyscallBlockSha256']


def metadata(project, output, log, env):
    with output.open('wb') as stdout, log.open('wb') as stderr:
        subprocess.run(['cargo', 'metadata', '--locked', '--all-features', '--format-version=1'], cwd=project, env=env, stdout=stdout, stderr=stderr, check=True, timeout=900)
    return json.loads(output.read_text())


def run_recovery(project, label, work, env):
    output = work/(label+'-recovery.log')
    command = ['cargo', 'test', '--locked', '-p', 'gpu_escrow', '--test', 'secp256k1_host_compatibility', '--', '--nocapture']
    with output.open('wb') as log:
        result = subprocess.run(command, cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    assert result.returncode == 0, label+' recovery failed; inspect '+str(output)
    text = output.read_text()
    assert 'PUBLIC_RECOVERY_CASES_PASS=1636' in text and re.search(r'test result: ok\. 2 passed; 0 failed; 0 ignored;', text), label+' complete expected test count missing'
    return {'result': 'PASS', 'tests': 2, 'publicRecoveryCases': 1636, 'logSha256': sha(output), 'command': command}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fresh_work_directory', type=Path)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    work = args.fresh_work_directory.resolve()
    work.mkdir(mode=0o700, exist_ok=False)
    pins = json.loads((HERE/'source-pins.json').read_text())
    repo = HERE.parents[1]
    report = {'schemaVersion': 1, 'result': 'FAIL', 'qualificationStatus': 'BLOCKED',
              'SbfRuntime': 'NOT_TESTED', 'transactionsOrPrivateKeys': False,
              'scannerExemptions': False, 'packageVersionsSpoofed': False}
    def save():
        write_json(work/'report.json', report)
    save()
    validate_committed(repo, pins)
    report['executionCommit'] = git(repo, 'rev-parse', 'HEAD').decode().strip()
    report['financialSourceSha256'] = pins['financialSourceSha256']
    report['unchangedSolanaSyscallBlockSha256'] = pins['unchangedSolanaSyscallBlockSha256']
    rebuild_source(work, repo, pins)
    vectors = work/'public-wycheproof.json'
    vector_pin = pins['publicVector']
    download('https://raw.githubusercontent.com/C2SP/wycheproof/'+vector_pin['commit']+'/'+vector_pin['path'], vectors, vector_pin['sha256'])
    fixture = oracle.fixtures(vectors)
    encoded = (json.dumps(fixture, separators=(',', ':'))+'\n').encode()
    assert encoded == (HERE/'public-recovery-fixtures.json').read_bytes(), 'committed fixture differs from independently regenerated oracle'
    (work/'public-recovery-fixtures.json').write_bytes(encoded)
    report.update(sourceReconstruction='PASS', fixtureSha256=hashlib.sha256(encoded).hexdigest(), oracleSummary=fixture['summary'])
    save()
    if args.prepare_only:
        report.update(result='PREPARATION_PASS', hostRecovery='NOT_TESTED');save();print(json.dumps(report));return
    temp = work/'tmp';temp.mkdir(mode=0o700)
    env = os.environ.copy()
    env.update(CARGO_TARGET_DIR=str(work/'target'), CARGO_BUILD_JOBS='2', CARGO_PROFILE_DEV_DEBUG='0', TMPDIR=str(temp), GPUBNB_RECOVERY_FIXTURES=str(work/'public-recovery-fixtures.json'))
    report['toolchain'] = {name: subprocess.check_output([name, '--version'], env=env, text=True).strip() for name in ['cargo', 'rustc']}
    selected = metadata(repo, work/'candidate-metadata.json', work/'candidate-metadata.log', env)
    packages = selected['packages']
    recovery = [p for p in packages if p['name'] == 'solana-secp256k1-recover']
    assert len(recovery) == 1 and recovery[0]['version'] == '2.2.1' and recovery[0]['source'] is None
    assert Path(recovery[0]['manifest_path']).parent == repo/pins['vendorPath'], 'actual vendor source not selected'
    assert not any(p['name'].startswith('libsecp256k1') or (p['name'] == 'rand' and p['version'].startswith('0.7.')) for p in packages), 'old recovery/Rand remains in all-feature graph'
    report['actualCandidateSourceSelected'] = True
    report['selectedCryptoPackages'] = [{'name': p['name'], 'version': p['version'], 'source': p['source']} for p in packages if p['name'] in ['k256', 'ctutils', 'crypto-bigint', 'rand', 'anchor-lang', 'borsh', 'glib']]
    save()
    baseline = work/'baseline'
    subprocess.run(['git', 'worktree', 'add', '--detach', str(baseline), pins['baseCommit']], cwd=repo, check=True, capture_output=True)
    try:
        assert sha(baseline/'programs/gpu_escrow/src/lib.rs') == pins['financialSourceSha256']
        for path in ['programs/gpu_escrow/Cargo.toml', 'programs/gpu_escrow/tests/secp256k1_host_compatibility.rs', 'prototypes/solana-recovery-migration/public-recovery-fixtures.json']:
            destination = baseline/path;destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repo/path, destination)
        lock = (baseline/'Cargo.lock').read_text()
        old = 'name = "gpu_escrow"\nversion = "0.2.0"\ndependencies = [\n "anchor-lang",\n]'
        assert lock.count(old) == 1
        (baseline/'Cargo.lock').write_bytes(lock.replace(old, old.replace(' "anchor-lang",', ' "anchor-lang",\n "serde_json",')).encode())
        report['baseline'] = run_recovery(baseline, 'baseline', work, env);save()
        report['candidate'] = run_recovery(repo, 'candidate', work, env);save()
        validate_committed(repo, pins)
        report.update(result='PASS_HOST_RECOVERY_COMPATIBILITY', hostRecovery='PASS',
                      financialSourceAndWrapperVersionRetained=True, anchorVersionRetained=True,
                      scannerDisposition='BLOCKED pending actual strict scan; no exemption')
        save();print(json.dumps(report, indent=2))
    finally:
        subprocess.run(['git', 'worktree', 'remove', '--force', str(baseline)], cwd=repo, check=True)


if __name__ == '__main__':
    main()
