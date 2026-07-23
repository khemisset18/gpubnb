#!/usr/bin/env python3
"""Compatibility launcher. The maintained agent lives in agent/."""
import runpy
import sys
from pathlib import Path

agent_dir = Path(__file__).parent / "agent"
sys.path.insert(0, str(agent_dir))
runpy.run_path(str(agent_dir / "agent.py"), run_name="__main__")
