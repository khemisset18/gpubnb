"""Run only the diagnostic policy suite inside an already isolated namespace."""
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'d1'))
from network_identity import validate_namespace

def run(binary, expected_sha, parent, output):
    links=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
    validate_namespace(parent,os.readlink('/proc/self/ns/net'),links)
    binary=Path(binary).resolve();output=Path(output)
    if len(expected_sha)!=64 or hashlib.sha256(binary.read_bytes()).hexdigest()!=expected_sha:
        raise ValueError('diagnostic executable digest mismatch')
    output.mkdir(mode=0o700,exist_ok=False)
    report={'sourceCommit':'e0a1c157791544e818c901bd9341896965afbf9d','binarySha256':expected_sha,
            'buildKind':'SOURCE_DIAGNOSTIC_NOT_D0','qualificationStatus':'BLOCKED',
            'probeStatus':'FAIL','namespaceBefore':links,'maxBlocks':240,'maxCpuSeconds':180,
            'networkLoadBenchmark':False,'syntheticPressureEntries':1}
    resource.setrlimit(resource.RLIMIT_CPU,(180,180))
    resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE,(64*1024**2,64*1024**2))
    try:
        with (output/'policy-tests.log').open('w') as log:
            result=subprocess.run([str(binary),'--run_test=gpubnb_policy','--log_level=message','--report_level=detailed'],
                env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(output)},stdout=log,stderr=subprocess.STDOUT,timeout=240)
        report['exitCode']=result.returncode
        after=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
        validate_namespace(parent,os.readlink('/proc/self/ns/net'),after);report['namespaceAfter']=after
        result.check_returncode()
        log=(output/'policy-tests.log').read_text()
        if '2 test cases out of 2 passed' not in log or 'rolling-floor paid=' not in log or 'soft-dust aggregate=' not in log:
            raise ValueError('both native probes must actually execute and pass')
        report['probeStatus']='PASS'
    finally:
        (output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        (output/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(output.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))

if __name__=='__main__':run(*sys.argv[1:])
