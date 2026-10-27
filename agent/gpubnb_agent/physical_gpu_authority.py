"""Process-local serialization of Windows GPU mutation and physical probes.

Keep this dependency-free: both the inventory and rental/mining modules import
it. The durable claim/runtime stores remain the ownership authority after restart.
"""
import threading

PHYSICAL_GPU_LOCK = threading.RLock()
