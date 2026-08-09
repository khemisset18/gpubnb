"""GPUbnb Agent: local GPU inventory and signed control plane client."""

__version__ = "0.5.0"

# The gateway is part of the long-running agent runtime only. Import lazily to
# avoid circular imports and to keep setup/diagnostic commands side-effect free.
def _start_workspace_gateway_if_runtime() -> None:
    import sys
    import threading
    import time

    runtime_modes = {"start", "_run", "_service"}
    if not any(arg in runtime_modes for arg in sys.argv[1:]):
        return

    def bootstrap() -> None:
        # Let configuration/key loading and the first heartbeat initialize first.
        time.sleep(2)
        try:
            from .workspace_gateway import run_workspace_gateway_forever
            run_workspace_gateway_forever()
        except Exception:
            # The heartbeat supervisor remains authoritative. Gateway failures are
            # fail-closed: no connectionMetadata means the renter cannot open it.
            return

    threading.Thread(target=bootstrap, name="gpubnb-workspace-gateway", daemon=True).start()


_start_workspace_gateway_if_runtime()
