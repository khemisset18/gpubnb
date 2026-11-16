"""Fresh measured machine claim, signed by the heartbeat protocol, not TPM attestation."""
from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone


def measure_windows_agent_process(machine_id: str, challenge: str) -> dict | None:
    # A developer Python interpreter must never claim to be the signed Agent EXE.
    if platform.system() != "Windows" or not getattr(sys, "frozen", False):
        return None
    from . import __version__
    from ._build_info import BUILD_COMMIT
    # Only the numeric current PID is interpolated. Paths come from Get-Process,
    # never from a browser, heartbeat field, environment path or a supplied claim.
    command = r"""
$ErrorActionPreference='Stop'
$p=Get-Process -Id __PID__
$path=$p.Path
$start=$p.StartTime.ToUniversalTime().ToString('o')
$hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
$sig=Get-AuthenticodeSignature -LiteralPath $path
if($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate){throw 'agent_signature_invalid'}
$again=Get-Process -Id __PID__
if($again.Path -cne $path -or $again.StartTime -ne $p.StartTime -or
 (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash){throw 'agent_measurement_changed'}
@{pid=$p.Id;startedAt=$start;sha256=$hash;signatureStatus='Valid';signerThumbprint=$sig.SignerCertificate.Thumbprint.ToLowerInvariant()} | ConvertTo-Json -Compress
""".replace("__PID__", str(os.getpid()))
    try:
        # Resolve the OS binary directly: no PATH search for privileged measurement.
        shell = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        output = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", command],
                                check=True, capture_output=True, text=True, timeout=15)
        proof = json.loads(output.stdout)
        if not isinstance(proof, dict) or proof.get("pid") != os.getpid():
            return None
        return {**proof, "schemaVersion": 1, "machineId": machine_id, "challenge": challenge,
                "version": __version__, "commit": BUILD_COMMIT,
                "measuredAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
