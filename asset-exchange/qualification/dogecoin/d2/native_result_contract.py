"""Offline comparison of UNTRUSTED native-report claims, never a native executor.

Artifact hashing is real. A matching report does not authenticate its producer,
authorization, runtime, signatures, UTXOs, namespace or Sigstore provenance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from offline_candidate import SOURCE
from spend_preparation import GENESIS, exact, stable_hash

ARCHIVE = "4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
LIBRARY = "3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b"
MATRIX_SHA256 = "b342a03deb7f4149221964bb984453eed7530365e3f7cf486fd261004af618b5"
HERE = Path(__file__).resolve().parent
HEX = re.compile(r"[a-f0-9]{64}")
NAME = re.compile(r"[a-z][a-z0-9_-]{0,63}\.(json|log|txt)")


def digest(value):
    if type(value) is not str or not HEX.fullmatch(value):
        raise ValueError("exact lowercase digest required")
    return value


def strict_json(raw):
    if type(raw) is not bytes or len(raw) > 262144:
        raise ValueError("bounded JSON report required")
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("nonfinite JSON number")
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid)
    except RecursionError as error:
        raise ValueError("JSON nesting exceeds parser bound") from error
    stable_hash(value)  # Aggregate/type bounds before comparison.
    return value


def scenario_catalog():
    raw = (HERE/'fixtures/native_scenarios_v1.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != MATRIX_SHA256:
        raise ValueError("frozen scenario matrix digest mismatch")
    value = strict_json(raw)
    exact(value, ['schemaVersion', 'sourceCommit', 'scope', 'cases'], 'scenario matrix')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['sourceCommit'] != SOURCE:
        raise ValueError("scenario source/version mismatch")
    if type(value['cases']) is not list or len(value['cases']) != 24:
        raise ValueError("exact scenario inventory required")
    names = set()
    for row in value['cases']:
        exact(row, ['id', 'measurementKind', 'expected', 'predicate'], 'scenario')
        if type(row['id']) is not str or not re.fullmatch('[a-z_]{3,64}', row['id']) or row['id'] in names:
            raise ValueError("duplicate/invalid scenario")
        names.add(row['id'])
        if row['measurementKind'] not in ['NATIVE_CORE', 'NATIVE_POLICY_PROBE', 'OFFLINE_PREFLIGHT']:
            raise ValueError("unknown measurement kind")
        if type(row['expected']) is not dict or not row['expected'] or any(v not in ['PASS', 'REJECT', 'MISSING'] for v in row['expected'].values()):
            raise ValueError("explicit independent outcomes required")
    return value, hashlib.sha256(raw).hexdigest()


def read_artifact(directory, name):
    if os.name != 'posix':
        raise ValueError("artifact reader requires POSIX no-follow semantics; platform not qualified")
    if type(name) is not str or not NAME.fullmatch(name):
        raise ValueError("public artifact basename required; no path traversal")
    fd = os.open(Path(directory)/name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 262144:
            raise ValueError("bounded single-link regular public artifact required")
        data = bytearray()
        while len(data) <= 262144:
            part = os.read(fd, min(16384, 262145-len(data)))
            if not part:
                break
            data.extend(part)
        if len(data) > 262144:
            raise ValueError("artifact exceeds bound")
        return bytes(data)
    finally:
        os.close(fd)


def compare_report(report, artifact_directory):
    """Return auditable comparison, always BLOCKED pending independent native proof verification."""
    stable_hash(report)
    exact(report, ['schemaVersion', 'producer', 'sourceCommit', 'archiveSha256', 'consensusLibrarySha256', 'nativeExecutorCommit', 'network', 'genesis',
        'scenarioMatrixSha256', 'signedFixtureSetDigest', 'context', 'cases', 'artifacts'], 'native report')
    matrix, matrix_hash = scenario_catalog()
    if type(report['schemaVersion']) is not int or report['schemaVersion'] != 1:
        raise ValueError("report schema mismatch")
    if report['producer'] not in ['MODEL', 'NATIVE_DOGECOIN_1_14_9']:
        raise ValueError("unknown report producer")
    if (report['sourceCommit'], report['archiveSha256'], report['consensusLibrarySha256'], report['network'], report['genesis'], report['scenarioMatrixSha256']) != (SOURCE, ARCHIVE, LIBRARY, 'regtest', GENESIS, matrix_hash):
        raise ValueError("pinned provenance/network/scenario mismatch")
    if report['nativeExecutorCommit'] is not None and (type(report['nativeExecutorCommit']) is not str or not re.fullmatch('[a-f0-9]{40}', report['nativeExecutorCommit'])):
        raise ValueError("exact native executor commit required")
    if report['signedFixtureSetDigest'] is not None:
        digest(report['signedFixtureSetDigest'])
    context = report['context']
    exact(context, ['interfaces', 'peers', 'externalConnections', 'walletEnabled', 'acceptNonstandard', 'promiscuousMempoolFlags', 'bip65Enforced'], 'execution context claims')
    if (context['interfaces'] != ['lo'] or type(context['peers']) is not int or context['peers'] != 0 or
        type(context['externalConnections']) is not int or context['externalConnections'] != 0 or
        context['walletEnabled'] is not False or context['acceptNonstandard'] is not False or
        context['promiscuousMempoolFlags'] is not None or context['bip65Enforced'] is not True):
        raise ValueError("unsafe or untyped execution context claims")
    artifacts = report['artifacts']
    if type(artifacts) is not list or len(artifacts) > 24:
        raise ValueError("bounded artifact inventory required")
    verified = set()
    for artifact in artifacts:
        exact(artifact, ['path', 'sha256'], 'public artifact')
        digest(artifact['sha256'])
        if type(artifact['path']) is not str or not NAME.fullmatch(artifact['path']):
            raise ValueError("public artifact basename required")
        if artifact['path'] in verified:
            raise ValueError("duplicate artifact")
        raw = read_artifact(artifact_directory, artifact['path'])
        if hashlib.sha256(raw).hexdigest() != artifact['sha256']:
            raise ValueError("artifact hash mismatch")
        verified.add(artifact['path'])
    if type(report['cases']) is not list or len(report['cases']) > 24:
        raise ValueError("bounded case list required")
    expected = {row['id']: row for row in matrix['cases']}
    seen, mismatches, unmatched_artifacts = set(), [], []
    matched_native_claims = 0
    for row in report['cases']:
        exact(row, ['id', 'measurementKind', 'outcomes', 'artifact'], 'case result')
        if type(row['id']) is not str or row['id'] not in expected or row['id'] in seen:
            raise ValueError("unknown or duplicate result case")
        seen.add(row['id']); wanted = expected[row['id']]
        if row['measurementKind'] != wanted['measurementKind'] or stable_hash(row['outcomes']) != stable_hash(wanted['expected']):
            mismatches.append(row['id'])
        elif report['producer'] == 'NATIVE_DOGECOIN_1_14_9' and row['measurementKind'] != 'OFFLINE_PREFLIGHT':
            matched_native_claims += 1
        if type(row['artifact']) is not str or row['artifact'] not in verified:
            unmatched_artifacts.append(row['id'])
    missing = sorted(set(expected)-seen)
    return {'schemaVersion': 1, 'comparison': 'MATCHED_UNAUTHENTICATED_CLAIMS' if not (missing or mismatches or unmatched_artifacts) else 'INCOMPLETE_OR_MISMATCHED',
        'producerClaim': report['producer'], 'reportedMatchedNativeCases': matched_native_claims,
        'verifiedNativeCases': 0, 'artifactHashesVerified': sorted(verified), 'missingCases': missing,
        'mismatchedCases': mismatches, 'casesWithoutArtifacts': unmatched_artifacts,
        'missingSignedFixtures': report['signedFixtureSetDigest'] is None,
        'missingNativeExecutor': report['nativeExecutorCommit'] is None,
        'authorizationVerified': False, 'producerIdentityVerified': False, 'runtimeContextVerified': False,
        'signatureAndUtxoProofsVerified': False, 'qualificationStatus': 'BLOCKED', 'executableOperations': [],
        'blockingProofs': ['separate exact-scope native authorization', 'signed fixtures and exact native executor commit',
            'Sigstore/runtime identity and original binary provenance', 'independent native signature/UTXO/policy/admission validation']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report_directory', type=Path)
    parser.add_argument('report_name')
    args = parser.parse_args()
    try:
        result = compare_report(strict_json(read_artifact(args.report_directory, args.report_name)), args.report_directory)
    except (ValueError, OSError, UnicodeError) as error:
        result = {'comparison': 'REJECTED', 'error': str(error), 'qualificationStatus': 'BLOCKED', 'executableOperations': []}
    print(json.dumps(result, sort_keys=True))
    return 1  # No path in this offline tool can manufacture native qualification.


if __name__ == '__main__':
    raise SystemExit(main())
