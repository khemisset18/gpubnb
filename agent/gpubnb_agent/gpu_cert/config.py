"""
Configuration and environment validation for GPU certification.
"""

from dataclasses import dataclass
import os

def _int_env(name: str, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    v = os.environ.get(name)
    if v is None:
        val = default
    else:
        try:
            val = int(v)
        except Exception:
            raise ValueError(f"invalid integer for {name}: {v!r}")
    if minimum is not None and val < minimum:
        raise ValueError(f"{name} below minimum {minimum}: {val}")
    if maximum is not None and val > maximum:
        raise ValueError(f"{name} above maximum {maximum}: {val}")
    return val

def _float_env(name: str, default: float, minimum: float | None = None, maximum: float | None = None) -> float:
    v = os.environ.get(name)
    if v is None:
        val = default
    else:
        try:
            val = float(v)
        except Exception:
            raise ValueError(f"invalid float for {name}: {v!r}")
    if minimum is not None and val < minimum:
        raise ValueError(f"{name} below minimum {minimum}: {val}")
    if maximum is not None and val > maximum:
        raise ValueError(f"{name} above maximum {maximum}: {val}")
    return val

@dataclass(frozen=True)
class GPUCertConfig:
    max_temperature_c: float
    test_duration_seconds: int
    poll_interval_seconds: float
    process_timeout_seconds: int
    memory_percent: int
    min_free_memory_mib: int
    report_path: str
    enable_compute: bool
    enable_integration: bool
    gpu_uuids: list[str]
    log_level: str

def load_config_from_env() -> GPUCertConfig:
    max_temp = _float_env("GPUBNB_GPU_TEST_MAX_TEMPERATURE_C", 85.0, minimum=40.0, maximum=95.0)
    duration = _int_env("GPUBNB_GPU_TEST_DURATION_SECONDS", 60, minimum=1, maximum=60)
    poll = _float_env("GPUBNB_GPU_TEST_POLL_INTERVAL_SECONDS", 1.0, minimum=0.1, maximum=30.0)
    ptimeout = _int_env("GPUBNB_GPU_TEST_PROCESS_TIMEOUT_SECONDS", 10, minimum=1, maximum=120)
    mem_pct = _int_env("GPUBNB_GPU_TEST_MEMORY_PERCENT", 10, minimum=1, maximum=90)
    min_free_mib = _int_env("GPUBNB_GPU_TEST_MIN_FREE_MEMORY_MIB", 128, minimum=16, maximum=65536)
    report_path = os.environ.get("GPUBNB_GPU_TEST_REPORT_PATH", "/tmp/gpubnb_gpu_cert_report.json")
    enable_compute = os.environ.get("GPUBNB_GPU_TEST_ENABLE_COMPUTE", "0") in {"1", "true", "yes"}
    enable_integration = os.environ.get("GPUBNB_GPU_TEST_ENABLE_INTEGRATION", "0") in {"1", "true", "yes"}
    gpu_uuids_raw = os.environ.get("GPUBNB_GPU_TEST_GPU_UUIDS", "")
    gpu_list = [g.strip() for g in gpu_uuids_raw.split(",") if g.strip()] if gpu_uuids_raw else []
    log_level = os.environ.get("GPUBNB_GPU_TEST_LOG_LEVEL", "INFO").upper()
    return GPUCertConfig(
        max_temperature_c=max_temp,
        test_duration_seconds=duration,
        poll_interval_seconds=poll,
        process_timeout_seconds=ptimeout,
        memory_percent=mem_pct,
        min_free_memory_mib=min_free_mib,
        report_path=report_path,
        enable_compute=enable_compute,
        enable_integration=enable_integration,
        gpu_uuids=gpu_list,
        log_level=log_level,
    )

# Default for programmatic use
default_configuration = load_config_from_env()
