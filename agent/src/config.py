"""
Agent configuration and constants.
"""

import os
from pathlib import Path
from typing import Optional


class AgentConfig:
    """Agent configuration."""
    
    # API settings
    API_URL: str = os.getenv('GPUBNB_API', 'https://gpubnb.netlify.app/api')
    API_TIMEOUT: int = 30
    
    # Heartbeat settings
    HEARTBEAT_INTERVAL: int = 30  # seconds
    HEARTBEAT_MAX_AGE: int = 25  # seconds (server side max)
    
    # Workspace settings
    WORKSPACE_MAX_RAM: int = 512  # MiB
    WORKSPACE_MAX_CPU: int = 1  # cores
    WORKSPACE_MAX_STORAGE: int = 1024  # MiB
    
    # Security
    SESSION_TIMEOUT: int = 3600  # 1 hour
    NONCE_TTL: int = 300  # 5 minutes
    
    # Retry settings
    MAX_RETRIES: int = 3
    RETRY_DELAY: int = 5  # seconds
    
    # Logging
    LOG_LEVEL: str = os.getenv('GPUBNB_LOG_LEVEL', 'INFO')
    LOG_FILE: Optional[Path] = None  # Will be set to config_dir/agent.log
    
    @classmethod
    def from_env(cls) -> 'AgentConfig':
        """Load configuration from environment variables."""
        config = cls()
        
        if os.getenv('GPUBNB_API'):
            config.API_URL = os.getenv('GPUBNB_API')
        
        if os.getenv('GPUBNB_LOG_LEVEL'):
            config.LOG_LEVEL = os.getenv('GPUBNB_LOG_LEVEL')
        
        return config
