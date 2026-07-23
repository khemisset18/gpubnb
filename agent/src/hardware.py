"""
Hardware detection utilities for GPU, CPU, RAM, storage, and system info.
"""

import subprocess
import os
import re
import json
from typing import Optional, Dict, List, Tuple
from pathlib import Path


class HardwareDetector:
    """Detects GPU, CPU, RAM, storage, and system capabilities."""

    def __init__(self):
        self.gpu_info: Optional[Dict] = None
        self.system_info: Optional[Dict] = None

    def detect_all(self) -> Dict:
        """
        Detect all system information.
        
        Returns:
            Dict with GPU, CPU, RAM, disk, and software capabilities
        """
        return {
            'system': self.detect_system(),
            'gpu': self.detect_gpu(),
            'cpu': self.detect_cpu(),
            'memory': self.detect_memory(),
            'storage': self.detect_storage(),
            'software': self.detect_software(),
        }

    def detect_system(self) -> Dict:
        """Detect OS and system info."""
        try:
            import platform
            return {
                'os': platform.system(),
                'osVersion': platform.release(),
                'architecture': platform.machine(),
            }
        except Exception as e:
            print(f"⚠️  Failed to detect system: {e}")
            return {}

    def detect_gpu(self) -> List[Dict]:
        """
        Detect GPUs using nvidia-smi.
        
        Returns:
            List of GPU dicts with model, VRAM, driver version
        """
        try:
            result = subprocess.run(
                ['nvidia-smi', '--query-gpu=gpu_uuid,name,memory.total,driver_version,compute_cap',
                 '--format=csv,noheader,nounits'],
                capture_output=True,
                text=True,
                timeout=10,
            )
            
            if result.returncode != 0:
                print("⚠️  nvidia-smi not found or failed")
                return []
            
            gpus = []
            for line in result.stdout.strip().split('\n'):
                if not line.strip():
                    continue
                
                parts = [p.strip() for p in line.split(',')]
                if len(parts) >= 4:
                    gpus.append({
                        'gpuUuid': parts[0],
                        'gpuModel': parts[1],
                        'vramMiB': int(float(parts[2])) if parts[2] else None,
                        'driverVersion': parts[3],
                        'cudaVersion': self._extract_cuda_version(),
                    })
            
            return gpus
        except FileNotFoundError:
            print("⚠️  nvidia-smi not found - GPU support unavailable")
            return []
        except Exception as e:
            print(f"⚠️  Failed to detect GPU: {e}")
            return []

    def _extract_cuda_version(self) -> Optional[str]:
        """Extract CUDA version from nvidia-smi."""
        try:
            result = subprocess.run(
                ['nvidia-smi'],
                capture_output=True,
                text=True,
                timeout=10,
            )
            
            match = re.search(r'CUDA Version:\s+([\d.]+)', result.stdout)
            if match:
                return match.group(1)
        except Exception:
            pass
        
        return None

    def detect_cpu(self) -> Dict:
        """Detect CPU info."""
        try:
            import psutil
            cpu_count = psutil.cpu_count(logical=False)
            cpu_count_logical = psutil.cpu_count(logical=True)
            
            return {
                'cpu': self._get_cpu_model(),
                'cpuCount': cpu_count,
                'cpuCountLogical': cpu_count_logical,
            }
        except Exception as e:
            print(f"⚠️  Failed to detect CPU: {e}")
            return {}

    def _get_cpu_model(self) -> Optional[str]:
        """Get CPU model name."""
        try:
            if os.name == 'nt':  # Windows
                import wmi
                c = wmi.WMI()
                for processor in c.Win32_Processor():
                    return processor.Name
            else:  # Linux
                with open('/proc/cpuinfo', 'r') as f:
                    for line in f:
                        if line.startswith('model name'):
                            return line.split(':', 1)[1].strip()
        except Exception:
            pass
        
        return None

    def detect_memory(self) -> Dict:
        """Detect RAM size."""
        try:
            import psutil
            ram_total = psutil.virtual_memory().total
            return {
                'ramTotalMiB': int(ram_total / (1024 * 1024)),
            }
        except Exception as e:
            print(f"⚠️  Failed to detect memory: {e}")
            return {}

    def detect_storage(self) -> Dict:
        """Detect storage size."""
        try:
            import psutil
            disk_total = psutil.disk_usage('/').total
            return {
                'diskTotalMiB': int(disk_total / (1024 * 1024)),
            }
        except Exception as e:
            print(f"⚠️  Failed to detect storage: {e}")
            return {}

    def detect_software(self) -> Dict:
        """Detect Docker and virtualization support."""
        return {
            'dockerAvailable': self._check_docker(),
            'nvidiaRuntimeAvailable': self._check_nvidia_runtime(),
            'virtualizationAvailable': self._check_virtualization(),
        }

    def _check_docker(self) -> bool:
        """Check if Docker is available."""
        try:
            result = subprocess.run(
                ['docker', '--version'],
                capture_output=True,
                timeout=5,
            )
            return result.returncode == 0
        except Exception:
            return False

    def _check_nvidia_runtime(self) -> bool:
        """Check if NVIDIA Container Runtime is available."""
        try:
            result = subprocess.run(
                ['docker', 'run', '--rm', '--gpus', 'all', 'nvidia/cuda:12.0-base', 'nvidia-smi'],
                capture_output=True,
                timeout=30,
            )
            return result.returncode == 0
        except Exception:
            return False

    def _check_virtualization(self) -> bool:
        """Check if virtualization is available."""
        try:
            if os.name == 'nt':  # Windows
                import subprocess
                result = subprocess.run(
                    ['Get-WmiObject', 'Win32_Processor', '|', 'Select', 'VirtualizationFirmwareEnabled'],
                    capture_output=True,
                    shell=True,
                )
                return 'True' in result.stdout.decode()
            else:  # Linux
                with open('/proc/cpuinfo', 'r') as f:
                    return any('vmx' in line or 'svm' in line for line in f)
        except Exception:
            return False

    def diagnose(self) -> str:
        """
        Run full diagnostics and return human-readable report.
        
        Returns:
            Formatted diagnostic report
        """
        info = self.detect_all()
        
        lines = [
            "\n🔍 GPUbnb Agent Hardware Diagnostics",
            "=" * 50,
        ]
        
        # System
        if info['system']:
            lines.append(f"\n📱 System:")
            lines.append(f"   OS: {info['system'].get('os')} {info['system'].get('osVersion')}")
            lines.append(f"   Arch: {info['system'].get('architecture')}")
        
        # GPU
        if info['gpu']:
            lines.append(f"\n🎮 GPU(s):")
            for gpu in info['gpu']:
                lines.append(f"   Model: {gpu.get('gpuModel')}")
                lines.append(f"   VRAM: {gpu.get('vramMiB')} MiB")
                lines.append(f"   Driver: {gpu.get('driverVersion')}")
                lines.append(f"   CUDA: {gpu.get('cudaVersion')}")
        else:
            lines.append(f"\n❌ GPU: Not detected")
        
        # CPU
        if info['cpu']:
            lines.append(f"\n⚙️  CPU:")
            lines.append(f"   Model: {info['cpu'].get('cpu')}")
            lines.append(f"   Cores: {info['cpu'].get('cpuCount')}")
        
        # Memory
        if info['memory']:
            lines.append(f"\n💾 Memory:")
            lines.append(f"   RAM: {info['memory'].get('ramTotalMiB')} MiB")
        
        # Storage
        if info['storage']:
            lines.append(f"\n💿 Storage:")
            lines.append(f"   Disk: {info['storage'].get('diskTotalMiB')} MiB")
        
        # Software
        if info['software']:
            lines.append(f"\n📦 Software:")
            lines.append(f"   Docker: {'✅' if info['software'].get('dockerAvailable') else '❌'}")
            lines.append(f"   NVIDIA Runtime: {'✅' if info['software'].get('nvidiaRuntimeAvailable') else '❌'}")
            lines.append(f"   Virtualization: {'✅' if info['software'].get('virtualizationAvailable') else '❌'}")
        
        lines.append("\n" + "=" * 50 + "\n")
        return '\n'.join(lines)
