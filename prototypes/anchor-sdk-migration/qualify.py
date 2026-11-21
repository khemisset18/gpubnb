#!/usr/bin/env python3
"""Reproduce the exact Anchor host/ABI and private SBF candidate qualification.

Only official source/tool downloads and an in-memory VM are used. No RPC,
wallet, network transaction, deployment or vulnerability exemption is present.
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
import urllib.request

from integrity import HERE, canonical, sha, validate_candidate


def run(command, cwd, output, env, timeout=1800):
    with output.open('wb') as log:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log,
                                stderr=subprocess.STDOUT, timeout=timeout)
    assert result.returncode == 0, f'command failed ({result.returncode}): {output}'
    return {'command': list(map(str, command)), 'result': 'PASS', 'logSha256': sha(output)}


def wire_records(log):
    # Rust's harness may prefix a receipt with "test name ...", particularly
    # with one test thread. The receipt itself must remain exact and unique.
    records = sorted(re.findall(r'ANCHOR_WIRE_COMPAT [^\r\n]*',
                                log.read_text(encoding='utf-8')))
    assert len(records) == 38 and len(set(records)) == 38, 'incomplete/duplicate ABI records'
    return records


def checked_download(pin, archive):
    assert pin['url'].startswith('https://github.com/anza-xyz/')
    if not archive.exists():
        with urllib.request.urlopen(urllib.request.Request(pin['url'], headers={
                'User-Agent': 'GPUbnb private SBF internal qualification'}), timeout=60) as response, archive.open('wb') as target:
            total = 0
            while chunk := response.read(1024*1024):
                total += len(chunk)
                assert total <= pin['bytes'], 'tool archive exceeds pinned size'
                target.write(chunk)
    assert archive.stat().st_size == pin['bytes'] and sha(archive) == pin['sha256'], 'tool archive identity mismatch'


def extract_checked(archive, destination):
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, 'r:bz2') as tar:
        members = tar.getmembers()
        assert 0 < len(members) < 250000 and sum(m.size for m in members) < 8*1024**3
        for member in members:
            p = PurePosixPath(member.name)
            assert not p.is_absolute() and '..' not in p.parts, 'archive path traversal'
            assert member.isfile() or member.isdir() or member.issym() or member.islnk(), 'special archive file'
        # Python's data filter also rejects links outside the private extraction root.
        tar.extractall(destination, filter='data')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fresh_work_directory', type=Path)
    parser.add_argument('--mode', choices=['host', 'sbf'], required=True)
    parser.add_argument('--archive-cache', type=Path)
    args = parser.parse_args()
    repo = HERE.parents[1]
    work = args.fresh_work_directory.resolve()
    work.mkdir(mode=0o700, parents=False, exist_ok=False)
    pins = json.loads((HERE/'source-pins.json').read_text(encoding='utf-8'))
    report = {'schemaVersion': 1, 'result': 'FAIL', 'scope': 'internal technical qualification',
              'mode': args.mode, 'networkRpc': False, 'financialDeployment': False,
              'userKeys': False, 'scannerExemptions': False, 'commands': []}
    def save():
        (work/'report.json').write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
    save()
    baseline = work/'baseline'
    baseline_added = False
    try:
        report['candidate'] = validate_candidate(repo, pins)
        report['executionCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
        report['sourceFiles'] = pins['programFiles']
        report['workspaceLockSha256'] = sha(repo/'Cargo.lock')
        report['runtimeLockSha256'] = sha(HERE/'runtime/Cargo.lock')
        report['toolchain'] = {name: subprocess.check_output([name, '--version'], text=True).strip() for name in ['rustc', 'cargo']}
        subprocess.run(['git', 'worktree', 'add', '--detach', str(baseline), pins['baselineCommit']], cwd=repo, check=True, capture_output=True)
        baseline_added = True
        assert sha(baseline/'programs/gpu_escrow/src/lib.rs') == report['candidate']['financialSourceSha256']
        temporary = work/'tmp'; temporary.mkdir(mode=0o700)
        env = os.environ.copy()
        env.update(TMPDIR=str(temporary), CARGO_BUILD_JOBS='2', CARGO_PROFILE_DEV_DEBUG='0',
                   CARGO_TARGET_DIR=os.environ.get('GPUBNB_ANCHOR_TARGET_DIR', str(work/'target')))
        save()
        if args.mode == 'host':
            test_path = 'programs/gpu_escrow/tests/anchor_wire_compatibility.rs'
            shutil.copyfile(repo/test_path, baseline/test_path)
            for label, project, command in [
                ('baseline-wire', baseline, ['cargo', 'test', '--locked', '-p', 'gpu_escrow', '--test', 'anchor_wire_compatibility', '--', '--nocapture']),
                ('candidate-host', repo, ['cargo', 'test', '--locked', '-p', 'gpu_escrow', '--', '--nocapture'])]:
                report['commands'].append(run(command, project, work/(label+'.log'), env)); save()
            old = wire_records(work/'baseline-wire.log'); new = wire_records(work/'candidate-host.log')
            assert old == new, 'wire/accounts/PDA/CPI/error ABI regression'
            record_hash = hashlib.sha256(('\n'.join(old)+'\n').encode()).hexdigest()
            assert record_hash == pins['wireRecordsSha256'], 'golden ABI record identity changed'
            text = (work/'candidate-host.log').read_text(encoding='utf-8')
            counts = [int(n) for n in re.findall(r'test result: ok\. (\d+) passed; 0 failed; 0 ignored;', text)]
            assert counts == [6, 7, 2, 2, 0], 'complete host test counts missing'
            assert 'PUBLIC_RECOVERY_CASES_PASS=1636' in text
            report.update(result='PASS', hostTestsPassed=17, wireRecords=38,
                          wireRecordsSha256=record_hash, publicRecoveryCases=1636,
                          SbfRuntime='NOT_TESTED_BY_HOST_JOB')
        else:
            assert os.name == 'posix' and os.uname().machine == 'x86_64', 'pinned SBF tools require Linux x86_64'
            archive_cache = args.archive_cache.resolve() if args.archive_cache else work/'archives'
            archive_cache.mkdir(parents=True, exist_ok=True)
            tools = work/'tools'; tools.mkdir()
            report['tools'] = []
            for name, pin in pins['sbfTools'].items():
                archive = archive_cache/(name+'.tar.bz2')
                checked_download(pin, archive)
                destination = tools/name
                extract_checked(archive, destination)
                report['tools'].append({'name': name, **pin, 'observedSha256': sha(archive)})
                save()
            cli = tools/'agave/solana-release/bin/cargo-build-sbf'
            platform_dir = tools/'platform-tools'
            mounted = work/'mounted-platform-tools/v1.57/platform-tools'
            mounted.parent.mkdir(parents=True)
            mounted.symlink_to(platform_dir, target_is_directory=True)
            # Isolate rustup's Solana toolchain registration from the host installation.
            host_sysroot = Path(subprocess.check_output(['rustc', '--print', 'sysroot'], text=True).strip())
            rustup = work/'sbf-rustup'; (rustup/'toolchains').mkdir(parents=True)
            (rustup/'toolchains/1.97.1-x86_64-unknown-linux-gnu').symlink_to(host_sysroot, target_is_directory=True)
            sbf_env = env.copy(); sbf_env.update(RUSTUP_HOME=str(rustup), RUSTUP_TOOLCHAIN='1.97.1',
                SOLANA_PLATFORM_TOOLS_DIR=str(work/'mounted-platform-tools'), CARGO_TARGET_DIR=str(work/'sbf-target'))
            report['binaries'] = {}
            for label, project in [('baseline', baseline), ('candidate', repo)]:
                output = work/(label+'-sbf'); output.mkdir()
                command = [str(cli), '--manifest-path', 'programs/gpu_escrow/Cargo.toml', '--skip-tools-install',
                           '--tools-version', 'v1.57', '--arch', 'v0', '--jobs', '2', '--sbf-out-dir', str(output), '--', '--locked']
                report['commands'].append(run(command, project, work/(label+'-sbf-build.log'), sbf_env)); save()
                binary = output/'gpu_escrow.so'
                assert binary.read_bytes()[:4] == b'\x7fELF'
                # cargo-build-sbf creates an unused helper keypair; never retain/publish it.
                helper = output/'gpu_escrow-keypair.json'
                if helper.exists(): helper.unlink()
                digest = sha(binary)
                report['binaries'][label] = {'sha256': digest, 'bytes': binary.stat().st_size,
                    'financialSourceSha256': sha(project/'programs/gpu_escrow/src/lib.rs'), 'lockSha256': sha(project/'Cargo.lock')}
                runtime_env = env.copy(); runtime_env.update(GPUBNB_SBF_PROGRAM=str(binary), GPUBNB_SBF_SHA256=digest)
                command = ['cargo', 'test', '--locked', '--manifest-path', str(HERE/'runtime/Cargo.toml'), '--', '--nocapture']
                log = work/(label+'-sbf-runtime.log')
                report['commands'].append(run(command, repo, log, runtime_env)); save()
                text = log.read_text(encoding='utf-8')
                assert re.search(r'test result: ok\. 6 passed; 0 failed; 0 ignored;', text), 'complete private VM tests missing'
                assert text.count('SBF_CASE_PASS=') == 6 and 'SBF_SYSTEM_CPI_PASS ' in text
                assert 'SBF_ELF_SHA256='+digest in text and 'sigverify=true precompiles=NOT_QUALIFIED' in text
            report.update(result='PASS', privateSbfBaselineTestsPassed=6, privateSbfCandidateTestsPassed=6,
                          instructionCoverage=11, runtime='LiteSVM0.18.2 with pinned mainnet-feature snapshot and standard builtins; optional precompiles NOT_QUALIFIED',
                          signatureAndBlockhashRefusals='PASS', accountSnapshotsAndIndependentRent='PASS',
                          realSystemProgramCpi='PASS', realNetworkConsensus='NOT_TESTED')
        validate_candidate(repo, pins)
        save(); print(json.dumps(report, indent=2))
    except Exception as error:
        report['error'] = str(error); save(); raise
    finally:
        if baseline_added:
            subprocess.run(['git', 'worktree', 'remove', '--force', str(baseline)], cwd=repo, check=True)


if __name__ == '__main__':
    main()
