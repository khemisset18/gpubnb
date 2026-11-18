#!/usr/bin/env python3
"""Qualify the active, immutable official GTK migration in a disposable checkout.

This is a qualification runner, not an application feature or scanner exception.
It retains the historical GLib backport reconstruction, proves the replacement
source identities, and repeats only the Rust/native behaviors affected by GTK.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def selected_sources(metadata, project, pins):
    packages = metadata['packages']
    by_name = {}
    for package in packages:
        by_name.setdefault(package['name'], []).append(package)
    assert [p['version'] for p in by_name.get('glib', [])] == [pins['safeGlibVersion']], 'unexpected GLib branch'
    assert [p['version'] for p in by_name.get('gtk', [])] == [pins['gtkVersion']], 'unexpected GTK branch'
    assert all(p['source'] == 'registry+https://github.com/rust-lang/crates.io-index' for p in by_name['glib'])
    assert not any(p['name'].startswith('libsecp256k1') or
                   (p['name'] == 'rand' and p['version'].startswith('0.7.'))
                   for p in packages), 'removed recovery/Rand chain reintroduced'
    receipts = []
    for name, pin in pins['patches'].items():
        expected = 'git+' + pin['git'] + '?rev=' + pin['rev'] + '#' + pin['rev']
        found = by_name.get(name, [])
        assert len(found) == 1 and found[0]['source'] == expected, f'wrong official source: {name}'
        manifest = Path(found[0]['manifest_path'])
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=manifest.parent, text=True).strip()
        assert revision == pin['rev'], f'checkout identity mismatch: {name}'
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=manifest.parent, check=True, capture_output=True)
        receipts.append({'name': name, 'version': found[0]['version'], 'source': expected,
                         'manifestSha256': digest(manifest), 'checkoutCommit': revision})
    glib = by_name['glib'][0]
    variant = Path(glib['manifest_path']).parent / 'src/variant_iter.rs'
    assert variant.is_file(), 'GLib Variant iterator source missing'
    return {'officialGitPackages': receipts, 'glibVersion': glib['version'],
            'glibVariantIteratorSha256': digest(variant), 'oldGlibSelected': False,
            'gtkVersion': by_name['gtk'][0]['version'], 'removedUnsafeChainsAbsent': True}


def financial_graph(lock, root='gpu_escrow'):
    """Compare resolved package/checksum/edge identities, not lockfile shorthand."""
    by_name = {}
    for p in lock['package']:
        by_name.setdefault(p['name'], []).append(p)
    roots = by_name[root] if root else lock['package']
    assert root is None or len(roots) == 1
    todo = roots[:]
    result = {}
    while todo:
        p = todo.pop()
        key = (p['name'], p['version'], p.get('source'))
        if key in result:
            continue
        edges = []
        for dependency in p.get('dependencies', []):
            fields = dependency.split()
            matches = by_name[fields[0]]
            if len(fields) > 1:
                matches = [v for v in matches if v['version'] == fields[1]]
            if len(fields) > 2:
                expected_source = fields[2].strip('()')
                # Cargo dependency edges omit the resolved #commit fragment;
                # the target package still carries its exact immutable source.
                matches = [v for v in matches if v.get('source') == expected_source or
                           (v.get('source') or '').split('#', 1)[0] == expected_source]
            assert len(matches) == 1, f'ambiguous edge: {dependency}'
            target = matches[0]
            edges.append((target['name'], target['version'], target.get('source')))
            todo.append(target)
        result[key] = (p.get('checksum'), sorted(edges, key=repr))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fresh_work_directory', type=Path)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    work = args.fresh_work_directory.resolve()
    work.mkdir(mode=0o700, parents=False, exist_ok=False)
    pins = json.loads((HERE / 'source-pins.json').read_text())
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--',
                    'Cargo.toml', 'Cargo.lock', 'apps/host-desktop/src-tauri',
                    'prototypes/gtk-migration', 'prototypes/rust-compatible-backports',
                    'vendor/security/glib-0.18.5'], cwd=ROOT, check=True)
    report = {'schemaVersion': 1, 'result': 'FAIL', 'executionCommit': revision,
              'qualificationKind': 'internal experimental GTK migration',
              'externalAudit': 'NOT_PERFORMED', 'scannerExemptionsAdded': False,
              'packageVersionsSpoofed': False, 'nativeBlockchainEffects': False,
              'fullGuiAndIpc': 'NOT_TESTED_BY_THIS_RUNNER', 'commands': []}
    def save():
        (work / 'report.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    save()
    spec = importlib.util.spec_from_file_location('historical_glib_backport', ROOT / 'prototypes/rust-compatible-backports/prepare.py')
    historical = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(historical)
    # Keep independent reconstruction of the original source repair. It remains
    # historical evidence and is never misrepresented as the active dependency.
    previous = json.loads((ROOT / 'prototypes/rust-compatible-backports/source-pins.json').read_text())
    verified = work / 'verified-historical-sources'
    verified.mkdir()
    for pin in previous['patches']:
        archive = work / (pin['name'] + '.crate')
        historical.download(f"https://static.crates.io/crates/{pin['name']}/{pin['name']}-{pin['version']}.crate", archive, pin['archiveSha256'])
        prefix = pin['name'] + '-' + pin['version']
        historical.extract(archive, verified, prefix)
        source = verified / prefix
        assert json.loads((source / '.cargo_vcs_info.json').read_text())['git']['sha1'] == pin['archiveGitCommit']
        historical.patch_source(source, pin)
        assert historical.file_hashes(source) == historical.file_hashes(ROOT / pin['vendorPath']), 'historical backport modified'
    report['historicalBackportReconstructedUnchanged'] = True
    manifest = tomllib.loads((ROOT / 'Cargo.toml').read_text())
    assert 'glib' not in manifest['patch']['crates-io'], 'old GLib remains active'
    for name, pin in pins['patches'].items():
        assert manifest['patch']['crates-io'][name] == pin, f'manifest source mismatch: {name}'
    desktop = tomllib.loads((ROOT / 'apps/host-desktop/src-tauri/Cargo.toml').read_text())
    assert desktop['dependencies']['tauri']['version'] == pins['runtime']['tauri']
    assert desktop['build-dependencies']['tauri-build']['version'] == pins['runtime']['tauri-build']
    assert desktop['package']['rust-version'] == pins['runtime']['rust-version']
    baseline = tomllib.loads(subprocess.check_output(['git', 'show', pins['baseReferenceCommit'] + ':Cargo.lock'], cwd=ROOT, text=True))
    current = tomllib.loads((ROOT / 'Cargo.lock').read_text())
    assert financial_graph(current) == financial_graph(baseline), 'financial dependency graph changed: requires separate qualification'
    subprocess.run(['git', 'diff', '--exit-code', pins['baseReferenceCommit'], '--', 'programs/gpu_escrow'], cwd=ROOT, check=True)
    report.update(financialDependencyGraphUnchanged=True,
                  financialResolvedPackageCount=len(financial_graph(current)),
                  activeCargoLockSha256=digest(ROOT / 'Cargo.lock'))
    if args.prepare_only:
        report.update(result='PREPARATION_PASS', nativeTests='NOT_TESTED')
        save()
        return
    project = work / 'project'
    subprocess.run(['git', 'worktree', 'add', '--detach', str(project), revision], cwd=ROOT, check=True, capture_output=True)
    try:
        private_tmp = work / 'tmp'
        private_tmp.mkdir(mode=0o700)
        env = os.environ.copy()
        env.update(CARGO_TARGET_DIR=str(work / 'target'), CARGO_BUILD_JOBS='2',
                   CARGO_PROFILE_DEV_DEBUG='0', TMPDIR=str(private_tmp))
        report['toolchain'] = {v: subprocess.check_output([v, '--version'], env=env, text=True).strip() for v in ['rustc', 'cargo']}
        def command(label, argv, *, metadata=False):
            if metadata:
                with (work / (label + '.json')).open('wb') as out, (work / (label + '.log')).open('wb') as err:
                    subprocess.run(argv, cwd=project, env=env, stdout=out, stderr=err, check=True, timeout=1800)
                report[label] = selected_sources(json.loads((work / (label + '.json')).read_bytes()), project, pins)
            else:
                historical.run(argv, project, work / (label + '.log'), env=env, timeout=1800)
            report['commands'].append({'name': label, 'command': argv, 'result': 'PASS'})
            save()
        command('active-metadata', ['cargo', 'metadata', '--locked', '--all-features', '--format-version=1'], metadata=True)
        # This only adds the regression package to the disposable workspace and
        # names the GLib package already selected by the actual native runtime.
        cargo_manifest = project / 'Cargo.toml'
        value = cargo_manifest.read_text()
        assert value.count('members = [') == 1
        cargo_manifest.write_text(value.replace('members = [', 'members = [\n  "prototypes/gtk-migration/probe",', 1))
        with (project / 'Cargo.lock').open('a') as lock:
            lock.write('\n[[package]]\nname = "gpubnb-gtk-migration-probe"\nversion = "0.0.0"\ndependencies = [\n "glib",\n]\n')
        dist = ROOT / 'apps/host-desktop/dist'
        assert dist.is_dir(), 'actual frontend build required'
        shutil.copytree(dist, project / 'apps/host-desktop/dist')
        report['frontendAssetSha256'] = historical.file_hashes(dist)
        command('probe-metadata', ['cargo', 'metadata', '--locked', '--all-features', '--format-version=1'], metadata=True)
        def unchanged_lock_except_probe():
            observed = financial_graph(tomllib.loads((project / 'Cargo.lock').read_text()), root=None)
            probe_key = ('gpubnb-gtk-migration-probe', '0.0.0', None)
            assert probe_key in observed, 'regression probe is not selected'
            del observed[probe_key]
            assert observed == financial_graph(current, root=None), 'unexpected migration regression lock change'
        unchanged_lock_except_probe()
        for label, argv in [
            ('security-regressions', ['cargo', 'test', '--locked', '--release', '-p', 'gpubnb-gtk-migration-probe', '--', '--nocapture']),
            ('anchor-host', ['cargo', 'test', '--locked', '-p', 'gpu_escrow']),
            ('desktop-host', ['cargo', 'test', '--locked', '-p', 'gpubnb-host-desktop', '--all-targets']),
            ('tauri-native-compile', ['cargo', 'check', '--locked', '-p', 'gpubnb-host-desktop', '--features', 'desktop-runtime', '--all-targets']),
        ]:
            command(label, argv)
        assert 'GLIB_BACKPORT_PASS independent_value_comparisons=2080' in (work / 'security-regressions.log').read_text(), 'complete independent comparison proof missing'
        unchanged_lock_except_probe()
        selected_sources(json.loads((work / 'probe-metadata.json').read_bytes()), project, pins)
        shutil.copyfile(project / 'Cargo.lock', work / 'candidate-Cargo.lock')
        report.update(result='PASS', qualificationStatus='SOFTWARE_REGRESSIONS_PASS',
                      fullQualification='PENDING_SEPARATE_3OS_INSTALLERS_GUI_AND_STRICT_SCANNER')
        save()
    finally:
        subprocess.run(['git', 'worktree', 'remove', '--force', str(project)], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
