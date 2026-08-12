"""GPUbnb Agent: local GPU inventory and signed control plane client."""

__version__ = "0.5.6"

# Install the high-throughput Developer Workspace transport before the CLI imports
# workspace_gateway. The v2 supervisor subclasses the hardened lifecycle code and
# only replaces the latency-sensitive tunnel loop; all container/mining safety
# invariants remain owned by workspace_gateway.py.
from .workspace_gateway_v2 import install as _install_workspace_gateway_v2

_install_workspace_gateway_v2()
del _install_workspace_gateway_v2
