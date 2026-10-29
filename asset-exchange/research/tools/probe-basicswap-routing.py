#!/usr/bin/env python3
"""Offline, digest-pinned inspection of two pure upstream routing methods.

No upstream application import, wallet, node, signature or transaction. The
source checkout must be supplied locally; this tool has no network dependency.
"""
import argparse
import ast
import enum
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
ledger = json.loads((repo / 'docs/asset-exchange/research/2026-10-29/SOURCE_INVENTORY.json').read_text())
source = next(s for s in ledger['sources'] if s['id'] == 'basicswap')
texts = {}
for name in ['basicswap/basicswap.py', 'basicswap/chainparams.py', 'basicswap/basicswap_util.py']:
    raw = (args.source / name).read_bytes()
    pin = next(f['sha256'] for f in source['files'] if f['path'] == name)
    if hashlib.sha256(raw).hexdigest() != pin:
        raise ValueError('upstream source differs from reviewed digest: ' + name)
    texts[name] = raw.decode('utf8')
tree = ast.parse(texts['basicswap/basicswap.py'])
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'BasicSwap')
methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in ['is_reverse_ads_bid', 'validateSwapType']]
assert len(methods) == 2
chain = ast.parse(texts['basicswap/chainparams.py'])
coins = next(n for n in chain.body if isinstance(n, ast.ClassDef) and n.name == 'Coins')
assigns = [n for n in chain.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ['scriptless_coins', 'coins_without_segwit'] for t in n.targets)]
namespace = {'IntEnum': enum.IntEnum}
exec(compile(ast.fix_missing_locations(ast.Module(body=[coins] + assigns, type_ignores=[])), 'pinned-enums', 'exec'), namespace)

util_tree = ast.parse(texts['basicswap/basicswap_util.py'])
swap_types = next(n for n in util_tree.body if isinstance(n, ast.ClassDef) and n.name == 'SwapTypes')
namespace['auto'] = enum.auto
exec(compile(ast.fix_missing_locations(ast.Module(body=[swap_types], type_ignores=[])), 'pinned-swap-types', 'exec'), namespace)
SwapTypes = namespace['SwapTypes']
module = ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Probe', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[]))
exec(compile(module, 'pinned-pure-routing-methods', 'exec'), namespace)
p = namespace['Probe']()
p.balance_only_coins = (namespace['Coins'].LTC_MWEB,)
p.scriptless_coins = namespace['scriptless_coins']
p.coins_without_segwit = namespace['coins_without_segwit']
p.adaptor_swap_only_coins = p.scriptless_coins + (namespace['Coins'].PART_BLIND, namespace['Coins'].BCH)
p.settings = {}
p.chain = 'mainnet'  # Branch-selection string only; no node or network exists.
results = []
for a in ['BTC', 'DOGE', 'LTC', 'BCH', 'XMR']:
    for b in ['BTC', 'DOGE', 'LTC', 'BCH', 'XMR']:
        if a == b:
            continue
        try:
            p.validateSwapType(namespace['Coins'][a], namespace['Coins'][b], SwapTypes.XMR_SWAP)
            result = 'ADMITTED_BY_TYPE_VALIDATOR_ONLY'
        except ValueError as error:
            result = str(error)
        results.append({'from': a, 'to': b, 'result': result, 'reverseBid': p.is_reverse_ads_bid(namespace['Coins'][a], namespace['Coins'][b])})
print(json.dumps({'commit': source['commit'], 'scope': 'Digest-pinned pure type/routing methods only; no application import, node, wallet, signing, transaction or network. Admission is not a successful swap.', 'sourceSha256': next(f['sha256'] for f in source['files'] if f['path'] == 'basicswap/basicswap.py'), 'results': results}, indent=2))
