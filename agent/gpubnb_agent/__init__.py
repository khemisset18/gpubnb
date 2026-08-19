"""GPUbnb Agent: local GPU inventory and signed control plane client."""

__version__ = "0.6.2"

# Install the high-throughput Developer Workspace transport before the CLI imports
# workspace_gateway. The v2 supervisor subclasses the hardened lifecycle code and
# only replaces the latency-sensitive tunnel loop; all container/mining safety
# invariants remain owned by workspace_gateway.py.
from .workspace_gateway_v2 import install as _install_workspace_gateway_v2

_install_workspace_gateway_v2()
del _install_workspace_gateway_v2

# Apply the live browser-frame compatibility fix after v2. This keeps all v2
# transport behavior while preventing malformed text/binary metadata from forcing
# an unsafe UTF-8 decode that tears down VS Code channels.
from .workspace_gateway_v3 import install as _install_workspace_gateway_v3

_install_workspace_gateway_v3()
del _install_workspace_gateway_v3

# Mirror the API's 10 MiB HTTP request-body invariant on the Host and reject
# malformed control-plane Base64 before it reaches the HTTP worker queue.
from .workspace_gateway_v4 import install as _install_workspace_gateway_v4

_install_workspace_gateway_v4()
del _install_workspace_gateway_v4

# Add resource-scoped rental preemption after all transport/security layers.  v5
# only replaces GPU ownership/lifecycle hooks: HTTP, WebSocket and QUIC behavior
# continues to come from the already-qualified v4/v3/v2 stack.
from .workspace_gateway_v5 import install as _install_workspace_gateway_v5

_install_workspace_gateway_v5()
del _install_workspace_gateway_v5
