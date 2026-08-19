# Agent qualification version

For the private-beta Compute / `GPU_PROOF` qualification path, Agent `0.6.2` is the minimum qualified runtime.

The version boundary exists because earlier installers cannot be distinguished by source commit at heartbeat time and may predate runtime-behavior fixes that matter for a renter-billed job:

- `0.6.0`: may predate the pinned Compute image / pull-timeout and end-to-end GPU proof orchestration fixes.
- `0.6.1`: predates the exact-GPU-by-hardwareUuid fix. `gpu_proof_command()` used to hardcode `--gpus=device=0` for every GPU_PROOF job regardless of which accelerator the rental resource authority actually leased for the session - on a multi-GPU host this could attach the wrong physical GPU to a renter's paid job. No `0.6.1`-labeled Host installer was ever published, but the version still moved to keep it that way: an already-built local/test `0.6.1` binary must never be trusted as if it carried this fix.

The API therefore fails closed for job execution by requiring Agent `0.6.2` or newer. This keeps an older binary from appearing compatible and claiming a rental job it may not execute with the qualified runtime behavior.
