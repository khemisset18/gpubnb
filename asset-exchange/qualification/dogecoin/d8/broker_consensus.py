"""Private D8 software-broker refunds: script-input verification only.

No node, RPC, mining, transaction admission or hardware driver. Importing this
module neither loads Dogecoin nor creates a signing key. Native execution needs
the frozen, explicitly authorized wrapper and verified D0 evidence.
"""
import argparse
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import tarfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
EXCHANGE = ROOT / 'asset-exchange'
D2 = HERE.parent / 'd2'
WALLET = EXCHANGE / 'wallet-agent/dogecoin'
sys.path.insert(0, str(D2))
sys.path.insert(0, str(WALLET))
from script_diagnostics import (ARCHIVE, SHA256, LIBRARY_MEMBER, LIBRARY_SHA256,
    SOURCE_COMMIT, read_json, require, validate_handoff, validate_namespace,
    validate_spdx_member)
from native_spends import native_verifier, FLAGS
from offline_candidate import build_candidate
from test_signer import EphemeralSigner, transaction

AUTHORIZATION = 'AUTHORIZE_D8_PRIVATE_BROKER_CONSENSUS_REGTEST'
SCOPE = 'CONSENSUS_SCRIPT_INPUT_ONLY'
FEES = ('1000000', '10000000', '100000000')
LIBRARY_NAME = 'libdogecoinconsensus.so.0.0.0'


def manifest():
    return {'schemaVersion': 1, 'phase': 'D8_SOFTWARE_BROKER_CONSENSUS',
        'authorization': AUTHORIZATION, 'scope': SCOPE, 'network': 'regtest',
        'sourceCommit': SOURCE_COMMIT, 'd0ArchiveSha256': SHA256,
        'libraryMember': LIBRARY_MEMBER, 'librarySha256': LIBRARY_SHA256,
        'cAbiVersion': 1, 'inputIndex': 0, 'flags': FLAGS,
        'nodes': 0, 'maxRpc': 0, 'rpcAllowlist': [], 'maxGeneratedBlocks': 0,
        'maxBroadcastFixtures': 0, 'maxFixtureKeys': 2, 'maxNewSignatures': 3,
        'maxSignerChildren': 1, 'maxCabiVerifications': 6, 'feeStepsKoinu': list(FEES),
        'maxWallSeconds': 120, 'maxCpuSeconds': 90, 'maxAddressSpaceMiB': 1024,
        'maxSingleFileMiB': 32, 'hardwareQualified': False,
        'physicalDisplayTested': False, 'automaticSettlement': False,
        'qualificationStatus': 'BLOCKED',
        'notEstablished': ['UTXO existence/value/confirmation', 'transaction finality against a chain tip',
            'mempool standardness, fee policy or admission', 'native consensus activation height',
            'hardware, firmware provenance or physical user approval', 'full D0-D9 qualification']}


def verified_library(evidence, sbom, directory):
    """Reuse the D2 pins/SPDX check; extract only the library, never a daemon."""
    archive = Path(evidence) / ARCHIVE
    require(not archive.is_symlink() and archive.is_file(), 'regular D0 archive required')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == SHA256, 'D0 archive hash mismatch')
    validate_spdx_member(sbom, LIBRARY_MEMBER, LIBRARY_SHA256)
    with tarfile.open(archive, 'r:gz') as source:
        members = [m for m in source.getmembers() if m.name.removeprefix('./') == LIBRARY_MEMBER]
        require(len(members) == 1 and members[0].isfile()
                and 0 < members[0].size <= 32 * 1024**2, 'one bounded regular D0 library required')
        stream = source.extractfile(members[0])
        require(stream is not None, 'D0 library content absent')
        raw = stream.read(32 * 1024**2 + 1)
    require(len(raw) == members[0].size and hashlib.sha256(raw).hexdigest() == LIBRARY_SHA256,
            'qualified consensus library hash mismatch')
    target = Path(directory) / LIBRARY_NAME
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as handle:
            handle.write(raw)
    finally:
        os.close(fd)
    return target


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
    def timeout(_signal, _frame):
        raise TimeoutError('private D8 wall-time bound')
    previous = signal.signal(signal.SIGALRM, timeout)
    signal.alarm(120)
    return previous


def fixture_package(broker, request, key, marker):
    """Package the named public fixture sources; no key bytes enter the zipapp."""
    sources = {'__main__.py': HERE / 'fixture_signer.py',
        'external_signer.py': Path(broker.__file__),
        'external_transport.py': WALLET / 'external_transport.py',
        'refund_ladder.py': WALLET / 'refund_ladder.py',
        'transaction.py': EXCHANGE / 'recovery/dogecoin/transaction.py',
        **{name + '.py': D2 / (name + '.py') for name in
           ('htlc_codec', 'offline_candidate', 'spend_preparation', 'test_signer')}}
    data = {name: path.read_bytes() for name, path in sources.items()}
    data['fixture.json'] = broker.encode({'termsDigest': request['termsDigest'],
        'requestDigest': request['requestDigest'], 'keyFile': str(key),
        'markerFile': str(marker), 'syntheticHeight': 1353})
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, raw in sorted(data.items()):
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.external_attr = 0o100600 << 16
            archive.writestr(info, raw)
    return output.getvalue(), {name: hashlib.sha256(raw).hexdigest() for name, raw in data.items()}


def mutated_output(entry, policy):
    decoded = policy.parse_transaction(bytes.fromhex(entry['transactionHex']))
    require(len(decoded['inputs']) == len(decoded['outputs']) == 1, 'one-input/output fixture required')
    vin, vout = decoded['inputs'][0], decoded['outputs'][0]
    return transaction(vin['txid'], vin['vout'], vin['scriptSig'],
        [(vout['valueKoinu'] + 1, vout['scriptPubKey'])], decoded['lockTime'], vin['sequence'])


def execute_fixture(work, verify, report):
    broker = importlib.import_module('external_signer')
    policy = broker.policy
    keys, out = work / 'keys', work / 'evidence'
    claim = EphemeralSigner(keys, 'claim')
    refund = EphemeralSigner(keys, 'refund')
    require({p.name for p in keys.iterdir()} == {'claim.pem', 'refund.pem'}, 'exactly two fixture keys required')
    contract = build_candidate(hashlib.sha256(b'GPUbnb D8 public synthetic broker fixture').digest(),
                               claim.public, refund.public, 1355)
    funding_raw = transaction('01' * 32, 0, b'\x51', [(10_000_000_000, contract.output)])
    request = policy.create_refund_signing_request(
        contract={'redeemHex': contract.redeem.hex(), 'outputHex': contract.output.hex()},
        funding={'txid': policy.txid(funding_raw), 'vout': 0, 'valueKoinu': '10000000000',
                 'transactionHex': funding_raw.hex()},
        policy={'maxFeeKoinu': '100000000', 'minRefundKoinu': '9900000000'},
        destination_hex='76a914' + '11' * 20 + '88ac', fees=list(FEES),
        request_id='d8_native_broker_fixture', created_at_height=1352, request_expires_at_height=1360)
    marker = work / 'child-fixture-receipt.json'
    package, hashes = fixture_package(broker, request, refund.path, marker)
    package_sha = hashlib.sha256(package).hexdigest()
    pairing, receipt = broker.create_pairing(package, expected_adapter_sha256=package_sha,
        refund_public_hex=refund.public.hex(), signer_id='d8_native_fixture_signer',
        authorization=broker.PAIR_AUTHORIZATION)
    result = broker.request_refund_signatures(request, pairing=pairing, trusted_pairing_digest=receipt,
        trusted_terms_digest=request['termsDigest'], trusted_request_digest=request['requestDigest'],
        package=package, height_provider=lambda: 1353, journal_directory=work / 'public-journal',
        timeout_seconds=30)
    require(result['hardwareQualified'] is False and result['cached'] is False,
            'fresh external software signing required')
    refunds = result['refunds']
    require([r['feeKoinu'] for r in refunds] == list(FEES), 'exact three fee steps required')
    require(policy.validate_refund_ladder(refunds, contract=request['contract'], funding=request['funding'],
            policy=request['policy']) == refunds, 'broker output policy verification differs')
    child = read_json(marker)
    require(child['pid'] != os.getpid() and child['parentPid'] == os.getpid()
            and child['networkNamespace'] == os.readlink('/proc/self/ns/net')
            and child['signaturesProduced'] == 3 and child['physicalUserApproval'] is False
            and child['softwareFixtureApproval'] is True
            and child['requestDigest'] == request['requestDigest']
            and child['sessionId'] == result['sessionId'], 'real fixture child receipt differs')
    report.update(fixtureKeysCreated=2, newSignatures=3, signerChildren=1,
        syntheticHeight=1353, heightSource='CONSTANT_TEST_FIXTURE_NOT_CHAIN_OBSERVATION',
        fixtureSourcesSha256=hashes, adapterPackageSha256=package_sha, pairingDigest=receipt,
        requestDigest=request['requestDigest'], termsDigest=request['termsDigest'],
        childReceipt=child, contract=request['contract'], funding=request['funding'], refunds=refunds)
    for row in refunds:
        for kind, raw, expected in [('broker-refund', bytes.fromhex(row['transactionHex']), 1),
                                    ('post-sign-output-mutation', mutated_output(row, policy), 0)]:
            proof = verify(contract.output, raw)
            report['cases'].append({'id': kind + '-' + row['feeKoinu'], 'expectedResult': expected,
                'inputIndex': 0, 'transactionHex': raw.hex(),
                'transactionSha256': hashlib.sha256(raw).hexdigest(), **proof})
            require(proof == {'result': expected, 'error': 0, 'flags': FLAGS},
                    'native script result differs: ' + kind + '-' + row['feeKoinu'])


def validate_report(report):
    require(report['experimentStatus'] == 'PASS' and report['manifest'] == manifest()
            and report['scope'] == SCOPE and report['qualificationStatus'] == 'BLOCKED',
            'bounded D8 consensus-only evidence required')
    for field in ('rpcCalls', 'generatedBlocks', 'broadcasts', 'nodesStarted'):
        require(type(report[field]) is int and report[field] == 0, 'D8 zero-effect counter differs')
    for field, value in [('fixtureKeysCreated', 2), ('newSignatures', 3), ('signerChildren', 1)]:
        require(type(report[field]) is int and report[field] == value, 'D8 signer/key evidence differs')
    require(report['keysRemoved'] is True, 'D8 fixture keys were not removed')
    require(report['hardwareQualified'] is False and report['physicalDisplayTested'] is False
            and report['fundingObservedOnChain'] is False and report['mempoolChecked'] is False
            and report['transactionFinalityVerified'] is False and report['automaticSettlement'] is False,
            'script-only evidence cannot claim chain/policy/hardware qualification')
    expected = [(kind + '-' + fee, value) for fee in FEES
                for kind, value in [('broker-refund', 1), ('post-sign-output-mutation', 0)]]
    require([(c['id'], c['expectedResult']) for c in report['cases']] == expected,
            'all and only six new native observations required')
    require(len(report['refunds']) == 3 and [r['feeKoinu'] for r in report['refunds']] == list(FEES)
            and all(report['cases'][2 * i]['transactionHex'] == row['transactionHex']
                    for i, row in enumerate(report['refunds'])),
            'native accepted bytes differ from broker refunds')
    policy = importlib.import_module('refund_ladder')
    require(all(report['cases'][2 * i + 1]['transactionHex'] == mutated_output(row, policy).hex()
                for i, row in enumerate(report['refunds'])),
            'native rejected bytes differ from exact broker-refund mutation')
    for case, (_, value) in zip(report['cases'], expected):
        require(type(case['expectedResult']) is int and type(case['result']) is int and case['result'] == value
                and type(case['error']) is int and case['error'] == 0
                and type(case['flags']) is int and case['flags'] == FLAGS
                and type(case['inputIndex']) is int and case['inputIndex'] == 0,
                'native C ABI observation differs')
        require(type(case['transactionHex']) is str and len(case['transactionHex']) <= 20_000
                and re.fullmatch(r'(?:[0-9a-f]{2})+', case['transactionHex'])
                and hashlib.sha256(bytes.fromhex(case['transactionHex'])).hexdigest() == case['transactionSha256'],
                'retained native transaction bytes differ')
    return report


def run(args):
    require(args.authorization == AUTHORIZATION, 'exact private D8 authorization required')
    for commit in (args.execution_commit, args.harness_commit):
        require(type(commit) is str and re.fullmatch('[0-9a-f]{40}', commit), 'exact frozen D8 commit required')
    require(sys.platform == 'linux' and type(args.parent_net_ns) is str
            and re.fullmatch(r'net:\[[0-9]+\]', args.parent_net_ns), 'private Linux namespace identity required')
    current = os.readlink('/proc/self/ns/net')
    links = json.loads(subprocess.check_output(['ip', '-json', 'link', 'show'], text=True))
    validate_namespace(args.parent_net_ns, current, links)
    evidence, verification, work = (Path(p).resolve() for p in (args.evidence, args.verification, args.work))
    sbom = read_json(evidence / 'dogecoin-1.14.9-internal-reproduction.spdx.json')
    validate_handoff(read_json(verification / 'provenance.json'), read_json(verification / 'sbom.json'), sbom)
    require(not work.exists(), 'fresh private D8 work directory required')
    work.mkdir(mode=0o700)
    bins, out, keys = work / 'bin', work / 'evidence', work / 'keys'
    for path in (bins, out, keys):
        path.mkdir(mode=0o700)
    report = {'experimentStatus': 'FAIL', 'qualificationStatus': 'BLOCKED', 'scope': SCOPE,
        'manifest': manifest(), 'executionCommit': args.execution_commit, 'harnessCommit': args.harness_commit,
        'namespaceBefore': links, 'networkNamespace': current, 'rpcCalls': 0, 'generatedBlocks': 0,
        'broadcasts': 0, 'nodesStarted': 0, 'hardwareQualified': False, 'physicalDisplayTested': False,
        'fundingObservedOnChain': False, 'mempoolChecked': False, 'transactionFinalityVerified': False,
        'automaticSettlement': False, 'keysRemoved': False, 'cases': []}
    previous_alarm = None
    try:
        previous_alarm = limits()
        library = verified_library(evidence, sbom, bins)
        verify = native_verifier(library)  # Exact SHA256 and ABI before either fixture key.
        execute_fixture(work, verify, report)
        after = json.loads(subprocess.check_output(['ip', '-json', 'link', 'show'], text=True))
        after_namespace = os.readlink('/proc/self/ns/net')
        validate_namespace(args.parent_net_ns, after_namespace, after)
        require(after_namespace == current, 'private D8 namespace changed')
        report['namespaceAfter'] = after
        report['experimentStatus'] = 'PASS'
    finally:
        if previous_alarm is not None:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous_alarm)
        for label in ('claim', 'refund'):
            (keys / (label + '.pem')).unlink(missing_ok=True)
        report['keysRemoved'] = not list(keys.iterdir())
        try:
            if report['experimentStatus'] == 'PASS':
                validate_report(report)
        except (ValueError, KeyError, TypeError):
            report['experimentStatus'] = 'FAIL'
            raise
        finally:
            target = out / 'broker-consensus-report.json'
            target.write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
            (out / 'SHA256SUMS').write_text(hashlib.sha256(target.read_bytes()).hexdigest()
                                           + '  ' + target.name + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', action='store_true')
    for name in ('evidence', 'verification', 'work', 'authorization', 'parent-net-ns',
                 'execution-commit', 'harness-commit'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    if args.manifest:
        print(json.dumps(manifest(), sort_keys=True, indent=2))
    else:
        run(args)


if __name__ == '__main__':
    main()
