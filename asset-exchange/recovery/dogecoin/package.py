"""Reproducible standalone recovery zipapp; copies only named public code."""
import hashlib
import json
from pathlib import Path
import zipfile

FILES={'recovery_core.py':'recovery/dogecoin/recovery_core.py',
       'transaction.py':'recovery/dogecoin/transaction.py',
       'refund_ladder.py':'wallet-agent/dogecoin/refund_ladder.py',
       **{name:'qualification/dogecoin/d2/'+name for name in
          ('htlc_codec.py','offline_candidate.py','spend_preparation.py','test_signer.py')}}
ENTRY=b'''import json, sys\nfrom recovery_core import main\ntry:\n    main()\nexcept Exception as error:\n    print(json.dumps({"state":"UNKNOWN","error":str(error),"automaticSettlement":False}),file=sys.stderr)\n    raise SystemExit(1)\n'''


def build_package(destination,exchange_root=None):
    root=Path(exchange_root) if exchange_root else Path(__file__).resolve().parents[2]
    target=Path(destination)
    data={name:(root/path).read_bytes() for name,path in FILES.items()}
    data['__main__.py']=ENTRY
    data['MANIFEST.json']=(json.dumps({'schemaVersion':1,'files':{name:hashlib.sha256(raw).hexdigest()
                            for name,raw in sorted(data.items())}},sort_keys=True)+'\n').encode()
    with target.open('xb') as handle:
        with zipfile.ZipFile(handle,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
            for name,raw in sorted(data.items()):
                info=zipfile.ZipInfo(name,date_time=(2000,1,1,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
                archive.writestr(info,raw,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    return hashlib.sha256(target.read_bytes()).hexdigest()

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('destination')
    args=parser.parse_args();print(build_package(args.destination))
