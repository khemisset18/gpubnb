"""
GPUbnb Agent - GPU marketplace agent for Solana
Handles machine registration, GPU detection, heartbeats, and workspace execution
"""

__version__ = "0.5.0"
__author__ = "GPUbnb Team"

from .src.crypto import CryptoManager
from .src.hardware import HardwareDetector
from .src.api import APIClient
from .src.config import AgentConfig

__all__ = [
    "CryptoManager",
    "HardwareDetector", 
    "APIClient",
    "AgentConfig",
]
