"""Exact, fail-closed identities for the reviewed Anchor migration.

The graph includes every target/feature/dev edge retained by Cargo.lock. Desktop
nodes outside that closure are independently qualified by the GTK source runner.
"""
import hashlib
import json
from pathlib import Path
import re
import tomllib

HERE = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def financial_graph(lock):
    packages = tomllib.loads(Path(lock).read_text(encoding='utf-8'))['package']
    def identity(p):
        return (p['name'], p['version'], p.get('source', 'workspace-or-reviewed-vendor'))
    def resolve(dep):
        match = re.fullmatch(r'([^ ]+)(?: ([^ ]+))?(?: \((.+)\))?', dep)
        assert match, 'malformed Cargo dependency'
        name, version, source = match.groups()
        found = [p for p in packages if p['name'] == name and
                 (version is None or p['version'] == version) and
                 (source is None or p.get('source') == source)]
        assert len(found) == 1, 'ambiguous or missing Cargo dependency: '+dep
        return found[0]
    roots = [p for p in packages if p['name'] == 'gpu_escrow']
    assert len(roots) == 1
    selected = {}
    todo = roots[:]
    while todo:
        package = todo.pop()
        key = identity(package)
        if key in selected:
            continue
        deps = [resolve(d) for d in package.get('dependencies', [])]
        selected[key] = {'name': package['name'], 'version': package['version'],
                         'source': key[2], 'checksum': package.get('checksum'),
                         'dependencies': sorted(identity(d) for d in deps)}
        todo.extend(deps)
    graph = [selected[k] for k in sorted(selected)]
    for p in graph:
        assert not p['name'].startswith('libsecp256k1'), 'old recovery chain reintroduced'
        assert not (p['name'] == 'rand' and p['version'].startswith('0.7.')), 'Rand0.7 reintroduced'
        assert not (p['name'] == 'borsh' and not p['version'].startswith('1.')), 'pre-1.0 Borsh remains'
    assert any(p['name'] == 'anchor-lang' and p['version'] == '1.2.2' for p in graph)
    assert any(p['name'] == 'solana-secp256k1-recover' and p['version'] == '2.2.1' and
               p['source'] == 'workspace-or-reviewed-vendor' for p in graph)
    return graph


def validate_candidate(repo, pins=None):
    repo = Path(repo)
    pins = pins or json.loads((HERE/'source-pins.json').read_text(encoding='utf-8'))
    for path, expected in pins['programFiles'].items():
        assert sha(repo/path) == expected, 'unreviewed program/test source: '+path
    actual = sorted(str(p.relative_to(repo)).replace('\\', '/')
                    for p in (repo/'programs/gpu_escrow').rglob('*')
                    if p.is_file() and 'target' not in p.parts and p.name != 'contract-test.log')
    assert actual == sorted(pins['programFiles']), 'unexpected program source file'
    graph = financial_graph(repo/'Cargo.lock')
    assert hashlib.sha256(canonical(graph)).hexdigest() == pins['financialGraphSha256'], 'unreviewed financial dependency graph'
    vendor = pins['reviewedRecoveryVendor']
    manifest = tomllib.loads((repo/'Cargo.toml').read_text(encoding='utf-8'))
    assert manifest['profile']['release'] == pins['releaseProfile'], 'unreviewed financial release profile'
    assert manifest['workspace']['resolver'] == pins['workspaceResolver'], 'unreviewed workspace feature resolver'
    assert manifest['patch']['crates-io']['solana-secp256k1-recover'] == {'path': vendor['path']}, 'unreviewed recovery source override'
    actual_vendor = {str(p.relative_to(repo/vendor['path'])).replace('\\', '/'): sha(p)
                     for p in sorted((repo/vendor['path']).rglob('*')) if p.is_file()}
    assert actual_vendor == vendor['files'], 'unreviewed recovery vendor source'
    for path, expected in pins['runtimeFiles'].items():
        assert sha(repo/path) == expected, 'unreviewed private runtime harness: '+path
    runtime_packages = tomllib.loads((repo/'prototypes/anchor-sdk-migration/runtime/Cargo.lock').read_text(encoding='utf-8'))['package']
    for p in runtime_packages:
        assert not (p['name'] == 'rand' and p['version'].startswith('0.7.')), 'Rand0.7 reintroduced by test tooling'
        assert not (p['name'] == 'ed25519-dalek' and p['version'].startswith('1.')), 'obsolete verifier reintroduced by test tooling'
        assert not (p['name'] == 'curve25519-dalek' and p['version'].startswith('3.')), 'obsolete curve reintroduced by test tooling'
    return {'financialGraphSha256': pins['financialGraphSha256'], 'packages': len(graph),
            'financialSourceSha256': pins['programFiles']['programs/gpu_escrow/src/lib.rs'],
            'anchorVersion': '1.2.2', 'borsh010ParentsRemaining': 0}
