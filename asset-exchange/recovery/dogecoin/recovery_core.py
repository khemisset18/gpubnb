"""Standalone private-Regtest recovery. No signer, mining or Exchange API.

An independently retained bundle digest is mandatory. RPC observations remain
provisional; this tool never declares an Exchange settlement final.
"""
import argparse
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

try:
    from refund_ladder import validate_refund_ladder, amount
except ModuleNotFoundError as error:
    if error.name != 'refund_ladder':raise
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'wallet-agent'/'dogecoin'))
    from refund_ladder import validate_refund_ladder, amount
from transaction import parse_transaction

DOMAIN='GPUBNB:DOGE:RECOVERY:v1'
SOURCE='e0a1c157791544e818c901bd9341896965afbf9d'
GENESIS='3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5'
CLI_SHA256='2d3c69c56db3c3c51f0f7540ce05e723f0df59b308a3d78e424b5dfff0a1b3b3'
AUTHORIZATION='AUTHORIZE_DOGE_RECOVERY_PRIVATE_REGTEST'
MAX_BYTES=262144
METHODS={'getblockchaininfo','getblockhash','getnetworkinfo','getpeerinfo','getblockheader',
         'getrawtransaction','gettxout','getmempoolentry','getmempoolinfo','sendrawtransaction'}


def require(ok,message):
    if not ok:raise ValueError(message)


def exact(value,keys,label):
    require(type(value) is dict and set(value)==set(keys),'exact '+label+' fields required')


def unique(pairs):
    result={}
    for key,value in pairs:
        require(key not in result,'duplicate JSON key')
        result[key]=value
    return result


def read_regular(path,maximum=MAX_BYTES):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and 0<info.st_size<=maximum,
                'bounded single-link regular file required')
        with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(maximum+1)
    finally:os.close(fd)
    require(len(raw)<=maximum,'file grew beyond bound')
    return raw


def decode_json(raw):
    require(type(raw) is bytes and len(raw)<=MAX_BYTES,'bounded JSON required')
    def invalid(_):raise ValueError('nonfinite JSON number')
    try:return json.loads(raw.decode('utf-8'),object_pairs_hook=unique,parse_constant=invalid)
    except (RecursionError,UnicodeError) as error:raise ValueError('invalid JSON bounds or encoding') from error


def validate_bundle(value):
    exact(value,('domain','schemaVersion','network','genesis','sourceCommit','contract','funding','policy','refunds'),'bundle')
    require(value['domain']==DOMAIN and type(value['schemaVersion']) is int and value['schemaVersion']==1,'recovery domain/version mismatch')
    require(value['network']=='regtest' and value['genesis']==GENESIS and value['sourceCommit']==SOURCE,'wrong recovery network/source')
    entries=validate_refund_ladder(value['refunds'],contract=value['contract'],funding=value['funding'],policy=value['policy'])
    require(amount(value['policy']['minRefundKoinu'])>=1_000_000,'recovery profile excludes soft-dust outputs')
    return entries


def load_bundle(path,expected_sha256):
    require(type(expected_sha256) is str and re.fullmatch('[0-9a-f]{64}',expected_sha256),'independently retained bundle digest required')
    raw=read_regular(path)
    require(hashlib.sha256(raw).hexdigest()==expected_sha256,'bundle digest mismatch')
    value=decode_json(raw);validate_bundle(value)
    return value


def persist_bundle(path,value):
    validate_bundle(value)
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    require(len(raw)<=MAX_BYTES,'recovery bundle size bound')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb',closefd=False) as stream:stream.write(raw);stream.flush();os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(Path(path).parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)
    digest=hashlib.sha256(raw).hexdigest()
    require(load_bundle(path,digest)==value,'durable recovery readback mismatch')
    return digest


class Rpc:
    def __init__(self,binary,datadir,port,parent_namespace):
        links=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
        current=os.readlink('/proc/self/ns/net')
        require(type(parent_namespace) is str and parent_namespace.startswith('net:[') and current!=parent_namespace,
                'distinct private network namespace required')
        require(len(links)==1 and links[0].get('ifname')=='lo' and 'UP' in links[0].get('flags',[]),'loopback-only namespace required')
        require(type(port) is int and 1024<=port<=65535,'bounded RPC port required')
        require(hashlib.sha256(read_regular(binary,16*1024*1024)).hexdigest()==CLI_SHA256,'D0 RPC executable mismatch')
        directory=Path(datadir).resolve()
        self.base=[str(Path(binary).resolve()),'-datadir='+str(directory),'-conf='+str(directory/'dogecoin.conf'),
                   '-regtest=1','-testnet=0','-rpcconnect=127.0.0.1','-rpcport='+str(port)]
        self.calls=[]

    def __call__(self,method,*params,missing_ok=False):
        require(method in METHODS and len(self.calls)<64,'recovery RPC budget/method bound')
        self.calls.append({'method':method,'params':list(map(str,params))})
        result=subprocess.run(self.base+[method,*map(str,params)],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},
                capture_output=True,text=True,timeout=15)
        require(len(result.stdout)<=2*1024*1024 and len(result.stderr)<=8192,'RPC output bound')
        if result.returncode:
            code=re.search(r'^error code: (-?[0-9]+)$',result.stderr,re.MULTILINE)
            if missing_ok and code and int(code[1])==-5:return None
            # Do not leak cookie/config paths or signed material into summaries.
            raise ValueError('RPC '+method+' failed'+(' code '+code[1] if code else ''))
        text=result.stdout.strip()
        if not text:return None
        try:return json.loads(text,parse_float=Decimal)
        except json.JSONDecodeError:return text


def online_context(rpc):
    chain=rpc('getblockchaininfo');network=rpc('getnetworkinfo');genesis=rpc('getblockhash',0);peers=rpc('getpeerinfo')
    require(chain.get('chain')=='regtest' and genesis==GENESIS and network.get('version')==1140900,'RPC network/version mismatch')
    require(type(chain.get('blocks')) is int and chain['blocks']>=0 and type(chain.get('headers')) is int
            and chain['headers']>=chain['blocks'],'incoherent chain/header observation')
    require(any(x.get('id')=='bip65' and x.get('reject',{}).get('status') is True for x in chain.get('softforks',[])),
            'BIP65 not active')
    require(type(peers) is list and all(type(x.get('addr')) is str and x['addr'].startswith('127.0.0.1:') for x in peers),
            'unexpected nonlocal peer')
    return chain,network


def active_confirmation(rpc,transaction):
    confirmations=transaction.get('confirmations',0)
    require(type(confirmations) is int,'invalid confirmation observation')
    if confirmations<=0:return False
    block=transaction.get('blockhash')
    require(type(block) is str and re.fullmatch('[0-9a-f]{64}',block),'confirmed transaction missing block')
    header=rpc('getblockheader',block)
    require(type(header.get('height')) is int and header.get('confirmations',0)>0,'inactive confirmation anchor')
    require(rpc('getblockhash',header['height'])==block,'confirmation is outside active chain')
    return True


def observe(bundle,rpc,previous=None):
    validate_bundle(bundle)
    chain,network=online_context(rpc)
    funding=bundle['funding'];known=[]
    fund_tx=rpc('getrawtransaction',funding['txid'],1,missing_ok=True)
    if fund_tx is not None:
        require(fund_tx.get('hex')==funding['transactionHex'],'RPC funding bytes mismatch')
        funding_confirmed=active_confirmation(rpc,fund_tx)
    else:funding_confirmed=False
    for entry in bundle['refunds']:
        value=rpc('getrawtransaction',entry['txid'],1,missing_ok=True)
        if value is None:continue
        require(value.get('hex')==entry['transactionHex'],'RPC refund bytes mismatch')
        confirmed=active_confirmation(rpc,value)
        pending=None if confirmed else rpc('getmempoolentry',entry['txid'],missing_ok=True)
        if confirmed or pending is not None:known.append((entry,confirmed,value))
    require(sum(bool(x[1]) for x in known)<=1,'conflicting active refund observations')
    utxo=rpc('gettxout',funding['txid'],funding['vout'],'true')
    if utxo is not None:
        live_amount=Decimal(str(utxo.get('value')))*100_000_000
        require(live_amount==amount(funding['valueKoinu']) and utxo.get('scriptPubKey',{}).get('hex')==bundle['contract']['outputHex'],
                'live funding UTXO terms mismatch')
    current=rpc('getblockchaininfo')
    require(current.get('bestblockhash')==chain['bestblockhash'] and current.get('blocks')==chain['blocks'],'chain changed during observation; retry required')
    confirmed=next((x for x in known if x[1]),None)
    pending=next((x for x in known if not x[1]),None)
    if confirmed:state='CONFIRMED';entry=confirmed[0]
    elif pending:state='PENDING';entry=pending[0]
    elif utxo is not None and funding_confirmed:state='UTXO_AVAILABLE';entry=None
    elif fund_tx is None:state='FUNDING_UNKNOWN';entry=None
    elif not funding_confirmed:state='FUNDING_UNCONFIRMED';entry=None
    else:state='SPENT_OR_UNKNOWN';entry=None
    transition='REORGED' if previous and previous.get('state')=='CONFIRMED' and state!='CONFIRMED' else state
    return {'schemaVersion':1,'state':state,'transition':transition,'tipHeight':chain['blocks'],'tipHash':chain['bestblockhash'],
            'fundingConfirmed':funding_confirmed,'refundTxid':entry['txid'] if entry else None,
            'confirmedBlock':confirmed[2].get('blockhash') if confirmed else None,'automaticSettlement':False,
            'nodeSynchronized':chain['headers']==chain['blocks'],'qualificationStatus':'BLOCKED','observationOnly':True}


def fee_floor_koinu(rate):
    value=Decimal(str(rate))*100_000_000
    require(value.is_finite() and value>=0 and value==value.to_integral_value(),'invalid fee-rate unit observation')
    return int(value)


def rebroadcast(bundle,rpc,previous=None):
    status=observe(bundle,rpc,previous)
    if status['state']=='CONFIRMED':return {**status,'action':'ALREADY_CONFIRMED'}
    require(status['nodeSynchronized'],'node has an unresolved header lead; no broadcast')
    require(status['state'] in ('UTXO_AVAILABLE','PENDING'),'funding unavailable or ambiguous; no broadcast')
    chain=rpc('getblockchaininfo');info=rpc('getmempoolinfo');network=rpc('getnetworkinfo')
    rate=max(fee_floor_koinu(info['mempoolminfee']),fee_floor_koinu(network['relayfee']))
    eligible=[]
    for entry in bundle['refunds']:
        required=(rate*(len(entry['transactionHex'])//2)+999)//1000
        if amount(entry['feeKoinu'])>=required:eligible.append(entry)
    require(eligible,'no pre-signed refund covers current fee floor; signatory or new authorization required')
    if status['state']=='PENDING':
        # A falling fee floor must not switch an already-pending higher-fee
        # refund to a cheaper conflicting variant. Re-relay its exact bytes.
        entry=next((x for x in eligible if x['txid']==status['refundTxid']),None)
        require(entry is not None,'pending refund no longer covers fee floor; automatic non-RBF replacement forbidden')
    else:
        entry=min(eligible,key=lambda x:amount(x['feeKoinu']))
    lock=entry['lockTime'];cutoff=chain['blocks']+1 if lock<500_000_000 else chain['mediantime']
    require(lock<cutoff,'refund is not final for next block')
    require(rpc('sendrawtransaction',entry['transactionHex'])==entry['txid'],'broadcast acknowledgement mismatch')
    after=observe(bundle,rpc,status)
    require(after['refundTxid']==entry['txid'] and after['state'] in ('PENDING','CONFIRMED'),'broadcast not independently observed')
    return {**after,'action':'REBROADCAST_IDENTICAL_PRESIGNED_BYTES','selectedFeeKoinu':entry['feeKoinu']}


def save_observation(path,value,bundle_sha):
    target=Path(path);require(not target.is_symlink(),'journal symlink forbidden')
    raw=(json.dumps({'bundleSha256':bundle_sha,**value},sort_keys=True)+'\n').encode()
    fd,name=tempfile.mkstemp(prefix=target.name+'.',dir=target.parent)
    temporary=Path(name)
    try:
        with os.fdopen(fd,'wb',closefd=False) as stream:stream.write(raw);stream.flush();os.fsync(fd)
    finally:os.close(fd)
    try:os.replace(temporary,target)
    finally:
        if temporary.exists():temporary.unlink()
    directory=os.open(target.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('inspect','observe','rebroadcast'))
    parser.add_argument('--bundle',required=True);parser.add_argument('--bundle-sha256',required=True)
    parser.add_argument('--rpc-cli');parser.add_argument('--rpc-datadir');parser.add_argument('--rpc-port',type=int)
    parser.add_argument('--parent-net-ns');parser.add_argument('--authorization');parser.add_argument('--journal');parser.add_argument('--rpc-trace')
    args=parser.parse_args(argv)
    paths=[str(Path(path).resolve()) for path in (args.bundle,args.journal,args.rpc_trace) if path]
    require(len(paths)==len(set(paths)),'bundle, observation journal and trace must be distinct files')
    bundle=load_bundle(args.bundle,args.bundle_sha256)
    if args.command=='inspect':
        result={'network':bundle['network'],'fundingTxid':bundle['funding']['txid'],'refunds':len(bundle['refunds']),
                'maxFeeKoinu':bundle['policy']['maxFeeKoinu'],'qualificationStatus':'BLOCKED','action':'INSPECTED'}
    else:
        require(args.authorization==AUTHORIZATION,'exact private recovery scope required')
        require(all(x is not None for x in (args.rpc_cli,args.rpc_datadir,args.rpc_port,args.parent_net_ns)),'RPC recovery parameters required')
        rpc=Rpc(args.rpc_cli,args.rpc_datadir,args.rpc_port,args.parent_net_ns)
        previous=None
        if args.journal and Path(args.journal).exists():
            previous=decode_json(read_regular(args.journal))
            require(previous.get('bundleSha256')==args.bundle_sha256,'journal belongs to different recovery bundle')
        try:
            result=(observe if args.command=='observe' else rebroadcast)(bundle,rpc,previous)
            result['rpcCalls']=len(rpc.calls)
            if args.journal:save_observation(args.journal,result,args.bundle_sha256)
        finally:
            if args.rpc_trace:save_observation(args.rpc_trace,{'calls':rpc.calls},args.bundle_sha256)
    print(json.dumps(result,sort_keys=True))
    return result

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,subprocess.SubprocessError) as error:
        print(json.dumps({'state':'UNKNOWN','error':str(error),'automaticSettlement':False}),file=sys.stderr)
        raise SystemExit(1)
