import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./workspace-bookings.js', import.meta.url), 'utf8');

// Real confusion reported live: rowHTML()'s badge showed the bare Compute/GPU_PROOF job
// status (e.g. "RUNNING") with no framing. That reads exactly like
// WorkspaceSessionStatus.RUNNING (the Developer/Data/... workspace itself is open and
// billing), which is a completely different, much later state - the renter kept waiting
// for an "Ouvrir mon espace" button that was never going to appear because the GPU
// verification job, not any interactive workspace, was what was actually still running.
test('the Compute job status badge in rowHTML() is never a bare, unframed status word', () => {
  const start = source.indexOf('function rowHTML(');
  assert.ok(start >= 0, 'rowHTML must exist');
  const end = source.indexOf('\n  }', start);
  const body = source.slice(start, end);
  assert.doesNotMatch(
    body,
    /badge \$\{badgeClass\}">\$\{escapeHTML\(job\.status\)\}/,
    'the job-status badge must never render as a bare status word - it must be scoped (e.g. "Vérification GPU : ...") so it can never be mistaken for WorkspaceSessionStatus.RUNNING (the actual workspace, not its GPU verification job)',
  );
  assert.match(
    body,
    /Vérification GPU : \$\{escapeHTML\(job\.status\)\}/,
    'the badge must explicitly scope the raw job status to the GPU verification job',
  );
});
