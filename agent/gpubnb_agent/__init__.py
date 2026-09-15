"""GPUbnb Agent: local GPU inventory and signed control plane client."""
from __future__ import annotations

import sys

__version__ = "0.6.6"

_runtime_layers_installed = False


def _service_bootstrap_requested(argv: list[str] | tuple[str, ...] | None = None) -> bool:
    """Return whether this process was launched by the Windows SCM service entry."""
    arguments = sys.argv if argv is None else argv
    return len(arguments) > 1 and arguments[1] == "_service"


def install_runtime_layers() -> None:
    """Install the qualified Workspace/runtime monkey-patch chain exactly once.

    Normal CLI/daemon processes keep the historical package-import behavior. The
    hidden ``_service`` process defers this heavier import graph until after the
    Windows Service Control Manager dispatcher is connected; otherwise a cold
    PyInstaller/boot start can consume SCM's startup deadline before the service
    has had a chance to report itself alive.
    """
    global _runtime_layers_installed
    if _runtime_layers_installed:
        return

    # Install the high-throughput Developer Workspace transport before the CLI imports
    # workspace_gateway. The v2 supervisor subclasses the hardened lifecycle code and
    # only replaces the latency-sensitive tunnel loop; all container/mining safety
    # invariants remain owned by workspace_gateway.py.
    from .workspace_gateway_v2 import install as install_workspace_gateway_v2

    install_workspace_gateway_v2()

    # Apply the live browser-frame compatibility fix after v2. This keeps all v2
    # transport behavior while preventing malformed text/binary metadata from forcing
    # an unsafe UTF-8 decode that tears down VS Code channels.
    from .workspace_gateway_v3 import install as install_workspace_gateway_v3

    install_workspace_gateway_v3()

    # Mirror the API's 10 MiB HTTP request-body invariant on the Host and reject
    # malformed control-plane Base64 before it reaches the HTTP worker queue.
    from .workspace_gateway_v4 import install as install_workspace_gateway_v4

    install_workspace_gateway_v4()

    # Add resource-scoped rental preemption after all transport/security layers. v5
    # only replaces GPU ownership/lifecycle hooks: HTTP, WebSocket and QUIC behavior
    # continues to come from the already-qualified v4/v3/v2 stack.
    from .workspace_gateway_v5 import install as install_workspace_gateway_v5

    install_workspace_gateway_v5()

    # Older qualified builds could leave a local QUARANTINED rental claim after the
    # server had legitimately retired that lease. Recover only when a newly fetched
    # authority carries a strictly newer fence and a fresh physical GPU quiescence
    # proof succeeds; every ambiguous case remains fail-closed.
    from .rental_claim_recovery import install as install_rental_claim_recovery

    install_rental_claim_recovery()

    # Keep local code-server WebSocket opens off the control-message loop. A slow
    # Management channel must not head-of-line block ExtensionHost/reconnect opens or
    # browser frames; v6 preserves ordering with a bounded per-channel pending buffer.
    from .workspace_gateway_v6 import install as install_workspace_gateway_v6

    install_workspace_gateway_v6()

    # Physical beta.84 isolated the remaining reconnect loop to legacy ws_send
    # commands whose binary opcode metadata can be absent even though local opens and
    # signed ACKs are fast. v7 adds an explicit protocol version and a narrow,
    # code-server-only compatibility rule while retaining fail-closed behavior for
    # every ambiguous or modern malformed message.
    from .workspace_gateway_v7 import install as install_workspace_gateway_v7

    install_workspace_gateway_v7()

    # A real browser/network interruption must neither burn purchased minutes nor
    # create free compute. v8 couples the 10-minute commercial reconnect grace to a
    # real Docker pause and resumes the same runtime only after signed API authority
    # confirms that billing can continue.
    from .workspace_gateway_v8 import install as install_workspace_gateway_v8

    install_workspace_gateway_v8()

    # The base gateway already contains the real Selkies launch profiles for Cloud
    # Desktop, Creator, CAD and Gaming. v9 only admits those slugs after all v2-v8
    # transport, fencing and reconnect layers are installed; compatibility remains
    # server-authoritative and requires real desktop GPU rendering capability.
    from .workspace_gateway_v9 import install as install_workspace_gateway_v9

    install_workspace_gateway_v9()
    _runtime_layers_installed = True


# The SCM gives a service a bounded window to connect to its dispatcher. Keep the
# hidden service process bootstrap intentionally small, then install the exact same
# qualified runtime layers from SvcDoRun after ServiceFramework has reported RUNNING.
if not _service_bootstrap_requested():
    install_runtime_layers()
