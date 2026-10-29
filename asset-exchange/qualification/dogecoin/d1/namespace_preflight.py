"""Linux isolation smoke only; no node, wallet or Dogecoin executable is used."""
import json
import os
import subprocess
import sys

from network_identity import validate_namespace

if len(sys.argv) != 2:
    raise SystemExit("usage: namespace_preflight.py <parent-network-namespace>")
links = json.loads(subprocess.check_output(["ip", "-json", "link", "show"], text=True))
validate_namespace(sys.argv[1], os.readlink("/proc/self/ns/net"), links)
print("Loopback-only namespace preflight PASS; no node executed; D1 remains unqualified")
