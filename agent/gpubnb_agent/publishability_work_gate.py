"""Fail-closed gate for starting new normal Agent jobs.

A successful heartbeat can intentionally return ``publishable: false`` while the
Agent must remain alive for diagnostics, power policy and recovery.  This layer
remembers that explicit server decision and prevents the next normal job poll
until a later accepted heartbeat explicitly restores ``publishable: true``.

Legacy heartbeat responses that omit the field are compatible on a fresh start,
but they never clear a previously observed explicit block.
"""
from __future__ import annotations

import threading
from typing import Any, Callable


def install(cli_module: Any) -> None:
    if getattr(cli_module, "_publishability_work_gate_installed", False):
        return

    original_heartbeat = cli_module.heartbeat
    original_run_next_job = cli_module.run_next_job
    lock = threading.Lock()
    state = {"blocked": False}

    def heartbeat_with_publishability_gate(*args: Any, **kwargs: Any) -> Any:
        result = original_heartbeat(*args, **kwargs)
        if isinstance(result, dict):
            publishable = result.get("publishable")
            if publishable is False:
                with lock:
                    state["blocked"] = True
            elif publishable is True:
                with lock:
                    state["blocked"] = False
        return result

    def run_next_job_with_publishability_gate(*args: Any, **kwargs: Any) -> Any:
        with lock:
            blocked = bool(state["blocked"])
        if blocked:
            event_sink: Callable[[dict[str, Any]], None] | None = kwargs.get("event_sink")
            if callable(event_sink):
                event_sink({
                    "event": "unsafe_work_suspended",
                    "reason": "heartbeat_not_publishable",
                })
            return None
        return original_run_next_job(*args, **kwargs)

    cli_module.heartbeat = heartbeat_with_publishability_gate
    cli_module.run_next_job = run_next_job_with_publishability_gate
    cli_module._publishability_work_gate_installed = True
