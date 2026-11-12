"""Evaluate the actual manual routing expressions against an independent matrix."""
import ast
from pathlib import Path
import re
import unittest

ROOT=Path(__file__).resolve().parents[4]


def condition(text,job):
    section=text.split('\n  '+job+':\n',1)[1].split('\n  ',1)[0]
    return re.search(r'^    if: (.+)$',section,re.M)[1]


def permitted(expression,**values):
    for original,name in [('github.event_name','event'),('inputs.doge_suite','suite'),
        ('inputs.diagnostic_suite','suite'),('github.repository_id','repo_id'),
        ('github.repository','repo'),('github.ref','ref')]:expression=expression.replace(original,name)
    tree=ast.parse(expression.replace('&&',' and ').replace('||',' or '),mode='eval')
    allowed=(ast.Expression,ast.BoolOp,ast.And,ast.Or,ast.Compare,ast.Eq,ast.NotEq,ast.Name,ast.Load,ast.Constant)
    if any(not isinstance(n,allowed) or isinstance(n,ast.Name) and n.id not in values for n in ast.walk(tree)):
        raise ValueError('unsupported workflow expression')
    return eval(compile(tree,'<workflow-condition>','eval'),{'__builtins__':{}},values)


class RbfManualRoutes(unittest.TestCase):
    def test_every_doge_mode_keeps_its_exact_manual_repository_and_branch(self):
        text=(ROOT/'.github/workflows/workspace-reliability.yml').read_text()
        jobs=['doge-d3-private-manual','doge-recovery-multinode-private-manual',
              'doge-source-audit-manual','doge-rbf-boundaries-private-manual']
        expressions={job:condition(text,job) for job in jobs}
        branches={
            'base':'asset-exchange/doge-independent-recovery-20261111',
            'fee':'asset-exchange/doge-fee-pinning-20261111',
            'vm':'asset-exchange/doge-vm-recovery-20261111',
            'aux':'asset-exchange/doge-auxpow-boundaries-20261111',
            'audit':'asset-exchange/doge-audit-candidate-20261112',
            'rbf':'asset-exchange/doge-rbf-boundaries-20261112',
            'main':'main','dev':'dev'}
        expected={('base','both'):{jobs[0],jobs[1]},('base','d3'):{jobs[0]},('base','multinode'):{jobs[1]},
            ('fee','fee-pinning'):{jobs[1]},('vm','vm-recovery'):{jobs[1]},('aux','auxpow-expanded'):{jobs[1]},
            ('audit','source-audit'):{jobs[2]},('rbf','rbf-boundaries'):{jobs[3]}}
        for event in ['workflow_dispatch','pull_request','push','schedule']:
            for repo,repo_id in [('khemisset18/gpubnb','1305325878'),('other/gpubnb','1305325878'),('khemisset18/gpubnb','1')]:
                for branch,ref in branches.items():
                    for suite in ['both','d3','multinode','fee-pinning','vm-recovery','auxpow-expanded','source-audit','rbf-boundaries']:
                        got={job for job,expr in expressions.items() if permitted(expr,event=event,suite=suite,repo=repo,repo_id=repo_id,ref='refs/heads/'+ref)}
                        want=expected.get((branch,suite),set()) if event=='workflow_dispatch' and repo=='khemisset18/gpubnb' and repo_id=='1305325878' else set()
                        self.assertEqual(got,want,(event,repo,repo_id,branch,suite))

    def test_child_policy_rbf_cannot_run_on_another_branch_or_event(self):
        text=(ROOT/'.github/workflows/asset-exchange-dogecoin-policy.yml').read_text()
        expr=condition(text,'policy')
        for event in ['workflow_dispatch','push','pull_request','schedule']:
            for suite in ['policy','d3','rbf']:
                for branch in ['asset-exchange/doge-rbf-boundaries-20261112','asset-exchange/doge-independent-recovery-20261111','main','dev']:
                    got=permitted(expr,event=event,suite=suite,repo='khemisset18/gpubnb',repo_id='1305325878',ref='refs/heads/'+branch)
                    want=event=='workflow_dispatch' and ((suite=='rbf' and branch.endswith('doge-rbf-boundaries-20261112')) or (suite!='rbf' and branch.endswith('doge-independent-recovery-20261111')))
                    self.assertEqual(got,want,(event,suite,branch))


if __name__=='__main__':unittest.main()
