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

SUITES={
    'policy':{'suite':'gpubnb_policy','cases':3,'maxBlocks':1594,'maxFixtureBlocks':1354,
              'pressureEntries':2,'markers':('rolling-floor paid=','soft-dust aggregate=','bounded-refund old-fee=')},
    'd3':{'suite':'gpubnb_d3','cases':4,'maxBlocks':2706,'maxFixtureBlocks':1354,
          'pressureEntries':0,'markers':('d3-activation before-height=','d3-finality lock=',
              'd3-sighash type=','d3-single-out-of-range constant-one=true',
              'd3-malleability script-consensus-valid=true')},
    'rbf':{'suite':'gpubnb_rbf','cases':2,'maxBlocks':481,'maxFixtureBlocks':241,
           'pressureEntries':0,'markers':('rbf-count rejected=101 accepted=100 native-code=64 reason=too many potential replacements',
               'pool-after-reject=101 pool-after-accept=2',
               'rbf-new-input unconfirmed=rejected confirmed=accepted identical-signed-bytes=true native-code=64 reason=replacement-adds-unconfirmed',
               'pool-after-reject=2 pool-after-accept=1',
               'blocks=240 signed-fixtures=103 signatures=302 admissions=103',
               'blocks=241 signed-fixtures=3 signatures=4 admissions=4')},
}

def run(binary, expected_sha, parent, output, suite='policy'):
    if suite not in SUITES:raise ValueError('explicit supported diagnostic suite required')
    selection=SUITES[suite]
    links=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
    validate_namespace(parent,os.readlink('/proc/self/ns/net'),links)
    binary=Path(binary).resolve();output=Path(output)
    if len(expected_sha)!=64 or hashlib.sha256(binary.read_bytes()).hexdigest()!=expected_sha:
        raise ValueError('diagnostic executable digest mismatch')
    output.mkdir(mode=0o700,exist_ok=False)
    report={'sourceCommit':'e0a1c157791544e818c901bd9341896965afbf9d','binarySha256':expected_sha,
            'buildKind':'SOURCE_DIAGNOSTIC_NOT_D0','qualificationStatus':'BLOCKED',
            'probeStatus':'FAIL','namespaceBefore':links,'selectedSuite':selection['suite'],
            'selectedCases':selection['cases'],'maxBlocks':selection['maxBlocks'],
            'maxFixtureBlocks':selection['maxFixtureBlocks'],'maxCpuSeconds':180,
            'networkLoadBenchmark':False,'syntheticPressureEntries':selection['pressureEntries'],
            'maxPressureEntriesPerFixture':int(selection['pressureEntries']>0)}
    if suite=='rbf':
        report.update({'nativeObservationKind':'SOURCE_DIAGNOSTIC_GLOBAL_MEMPOOL',
            'maxNativeAdmissionsPerFixture':103,'maxSignedFixturesPerFixture':103,
            'maxSignatureOperationsPerFixture':302,'maxInputs':101,'maxMempoolEntries':101,
            'rpcCalls':0,'p2pTested':False,'previousNativeSuitesRepeated':False})
    resource.setrlimit(resource.RLIMIT_CPU,(180,180))
    resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE,(64*1024**2,64*1024**2))
    try:
        with (output/'policy-tests.log').open('w') as log:
            result=subprocess.run([str(binary),'--run_test='+selection['suite'],'--log_level=message','--report_level=detailed'],
                env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(output)},stdout=log,stderr=subprocess.STDOUT,timeout=240)
        report['exitCode']=result.returncode
        after=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
        validate_namespace(parent,os.readlink('/proc/self/ns/net'),after);report['namespaceAfter']=after
        result.check_returncode()
        log=(output/'policy-tests.log').read_text()
        expected=str(selection['cases'])+' test cases out of '+str(selection['cases'])+' passed'
        if expected not in log or any(marker not in log for marker in selection['markers']):
            raise ValueError('every selected native probe must actually execute and pass')
        report['probeStatus']='PASS'
    finally:
        (output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        (output/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(output.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))

if __name__=='__main__':run(*sys.argv[1:])
