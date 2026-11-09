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
    target=root/'src/test/gpubnb_policy_tests.cpp'
    if target.exists():raise ValueError('test already exists')
    target.write_bytes(Path(__file__).with_name('gpubnb_policy_tests.cpp').read_bytes())
    make.write_text(original.replace(anchor,anchor+'  test/gpubnb_policy_tests.cpp \\\n'))

if __name__=='__main__':prepare(sys.argv[1])
