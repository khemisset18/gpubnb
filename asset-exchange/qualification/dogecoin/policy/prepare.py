"""Add diagnostic test code only; refuse any changed upstream implementation."""
import hashlib
from pathlib import Path
import subprocess
import sys

SOURCE = 'e0a1c157791544e818c901bd9341896965afbf9d'
PINNED = {
    'src/Makefile.test.include':'9acab47e6ef22d78261625ccdd8c0e375572876a9210f04f375d24ab1488eeee',
    'src/dogecoin-fees.cpp':'e35b1290f63dd19732a1971a383f309b687e10680409dc8e7a89a2bb056ff219',
    'src/txmempool.cpp':'144eb2a64976c08e72beb36e0aeaba5daf0d188ba46c97a2d4f627e84b386501',
    'src/validation.cpp':'e9f13df6a83e057fba52f3525fec894ba13a1dcec52be3cf71b13fd181c79e00',
    'src/script/interpreter.cpp':'55a40e7cf109f1c9895675db4b20e8f2e7024cfc1d0c564d3583e8c940b3ac94',
    'src/test/test_bitcoin.cpp':'a03f5ee76434306ff0f1883035d0eebf6526f62eccc92bdb6077b1318e24736e',
    'src/chainparams.cpp':'150d3733903d05f22e2ce3bc195a65f99ced183e16f2e75f52a72d0df8ec5d9c',
    'src/policy/policy.h':'1929f7a8c27228fabed8eb44223dda53dd86ea448f009fdd77e0024f9826ab51',
    'src/test/sighash_tests.cpp':'c052f75eb40df55cb17431157048b86fa3d869928f2561df320eb013d3f717ed',
    'src/test/script_tests.cpp':'abc5ca1f36e8a93bc5315885c5b2f0793665af849968c67448d8bf7ce7289b56',
}

def prepare(root):
    root=Path(root).resolve()
    if subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()!=SOURCE:
        raise ValueError('wrong source commit')
    if subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True).strip():
        raise ValueError('source must be clean')
    for name,digest in PINNED.items():
        p=root/name
        if p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:
            raise ValueError('source file mismatch: '+name)
    make=root/'src/Makefile.test.include'
    original=make.read_text();anchor='  test/mempool_tests.cpp \\\n'
    if original.count(anchor)!=1:raise ValueError('unique test registration required')
    names=('gpubnb_policy_tests.cpp','gpubnb_d3_tests.cpp')
    additions=[]
    for name in names:
        target=root/'src/test'/name
        if target.exists() or target.is_symlink():raise ValueError('test already exists')
        additions.append((target,Path(__file__).with_name(name).read_bytes()))
    # Validate every target/template before the first source-tree mutation.
    for target,data in additions:target.write_bytes(data)
    registrations=''.join('  test/'+name+' \\\n' for name in names)
    make.write_text(original.replace(anchor,anchor+registrations))

if __name__=='__main__':prepare(sys.argv[1])
