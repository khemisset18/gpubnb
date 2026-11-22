"""Manual POSIX CLI for the private-Regtest external software signer broker.

No device driver or hardware compatibility is implied. New signing requires
independent local receipts and an existing D0-pinned private-Regtest RPC context;
public signed-refund recovery needs neither RPC nor the signing package/key.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import external_signer as broker
import external_transport
import refund_ladder as policy


def _recovery():
    directory = HERE.parents[1] / 'recovery' / 'dogecoin'
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location('gpubnb_doge_broker_recovery', directory / 'recovery_core.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _height_provider(args):
    policy.require(type(args.parent_net_ns) is str and args.parent_net_ns.startswith('net:[')
                   and os.readlink('/proc/self/ns/net') != args.parent_net_ns,
                   'distinct private network namespace required')
    recovery = _recovery()
    rpc = recovery.Rpc(args.rpc_cli, args.rpc_datadir, args.rpc_port,
                       args.parent_net_ns, maximum_calls=16)

    def height():
        chain, _ = recovery.online_context(rpc)
        policy.require(chain['headers'] == chain['blocks'],
                       'private Regtest headers are not synchronized')
        return chain['blocks']

    return height


def _request(args):
    return broker.decode(broker.read_public_file(args.request))


def _paired_arguments(args):
    return dict(pairing=broker.load_pairing(args.pairing, args.pairing_digest),
                trusted_pairing_digest=args.pairing_digest,
                trusted_terms_digest=args.terms_digest,
                trusted_request_digest=args.request_digest,
                journal_directory=args.journal_directory)


def _bundle(request, result, target):
    recovery = _recovery()
    bundle = {'domain': recovery.DOMAIN, 'schemaVersion': 1,
              'network': request['network'], 'genesis': request['genesis'],
              'sourceCommit': request['sourceCommit'], 'contract': request['contract'],
              'funding': request['funding'], 'policy': request['policy'],
              'refunds': result['refunds']}
    bundle_digest = recovery.persist_bundle(target, bundle)
    return {'status': 'SIGNED_PUBLIC_RECOVERY_BUNDLE', 'network': 'regtest',
            'profile': broker.PROFILE, 'hardwareQualified': False,
            'cached': result['cached'], 'requestId': result['requestId'],
            'requestDigest': result['requestDigest'], 'bundleSha256': bundle_digest,
            'bundleFile': str(target), 'refundTxids': [row['txid'] for row in result['refunds']],
            'broadcasts': 0}


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest='command', required=True)
    pair = commands.add_parser('pair', help='explicitly pair a local software signer zipapp')
    pair.add_argument('--adapter-package', required=True)
    pair.add_argument('--adapter-sha256', required=True)
    pair.add_argument('--refund-public-hex', required=True)
    pair.add_argument('--signer-id', required=True)
    pair.add_argument('--pairing-out', required=True)
    pair.add_argument('--authorization', choices=[broker.PAIR_AUTHORIZATION], required=True)
    review = commands.add_parser('review', help='print exact public review fields; no signing')
    sign = commands.add_parser('sign', help='sign once in the private laboratory and persist recovery')
    recover = commands.add_parser('recover', help='recover already-completed public refunds, without signer or RPC')
    for command in (review, sign, recover):
        command.add_argument('--request', required=True)
        command.add_argument('--terms-digest', required=True)
        command.add_argument('--request-digest', required=True)
    review.add_argument('--current-height', type=int, required=True)
    for command in (sign, recover):
        command.add_argument('--pairing', required=True)
        command.add_argument('--pairing-digest', required=True)
        command.add_argument('--journal-directory', required=True)
        command.add_argument('--bundle-out', required=True)
    sign.add_argument('--adapter-package', required=True)
    sign.add_argument('--authorization', choices=[broker.PAIR_AUTHORIZATION], required=True)
    sign.add_argument('--rpc-cli', required=True)
    sign.add_argument('--rpc-datadir', required=True)
    sign.add_argument('--rpc-port', type=int, required=True)
    sign.add_argument('--parent-net-ns', required=True)
    sign.add_argument('--timeout-seconds', type=int, default=15)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        policy.require(os.name == 'posix', 'external software signer CLI requires POSIX')
        if args.command == 'pair':
            package = broker.read_public_file(args.adapter_package, broker.MAX_PACKAGE)
            paired, receipt = broker.create_pairing(package,
                expected_adapter_sha256=args.adapter_sha256,
                refund_public_hex=args.refund_public_hex, signer_id=args.signer_id,
                authorization=args.authorization)
            broker.persist_pairing(args.pairing_out, paired, receipt)
            result = {'status': 'PAIRED_EXTERNAL_SOFTWARE_ONLY', 'pairingDigest': receipt,
                      'pairingFile': args.pairing_out, 'hardwareQualified': False}
        elif args.command == 'review':
            result = policy.signer_review_fields(_request(args),
                trusted_terms_digest=args.terms_digest, trusted_request_digest=args.request_digest,
                current_height=args.current_height)
        else:
            request = _request(args)
            paired = _paired_arguments(args)
            if args.command == 'recover':
                result = broker.recover_completed_refunds(request, **paired)
            else:
                package = broker.read_public_file(args.adapter_package, broker.MAX_PACKAGE)
                result = broker.request_refund_signatures(request, package=package,
                    height_provider=_height_provider(args), timeout_seconds=args.timeout_seconds, **paired)
            result = _bundle(request, result, args.bundle_out)
        print(json.dumps(result, sort_keys=True, indent=2))
        return 0
    except subprocess.SubprocessError:
        # Timeout/exit exceptions can contain CLI arguments and RPC paths.
        print(json.dumps({'status': 'REFUSED', 'reason': 'private Regtest observation unavailable'},
                         sort_keys=True), file=sys.stderr)
        return 2
    except (ValueError, OSError, external_transport.TransportError) as error:
        print(json.dumps({'status': 'REFUSED', 'reason': str(error)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
