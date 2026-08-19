# Agent qualification version

For the private-beta Compute / `GPU_PROOF` qualification path, Agent `0.6.1` is the minimum qualified runtime.

The version boundary exists because earlier `0.6.0` installers cannot be distinguished by source commit at heartbeat time and may predate the pinned Compute image / pull-timeout and end-to-end GPU proof orchestration fixes.

The API therefore fails closed for job execution by requiring Agent `0.6.1` or newer. This keeps an older binary from appearing compatible and claiming a rental job it may not execute with the qualified runtime behavior.
