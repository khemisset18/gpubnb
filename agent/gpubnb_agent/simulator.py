"""Deterministic GPU agent simulator.

Lets developers exercise the GPUbnb backend and dashboards without owning real
GPUs. Every simulated machine holds its own Ed25519 identity and speaks the
exact signed link / challenge / heartbeat protocol used by the real agent, so
the security path (signatures, replay counters, telemetry coherence) is
exercised end to end.

Two modes:

* offline (default): evolve realistic, time-varying metrics and print them as
  JSON events. No network access required.
* live (``--api-url`` + ``--codes``): link each machine with a one-time code and
  stream signed heartbeats to a running API.

The simulator is intentionally free of side effects when imported: all
randomness flows through an injected ``random.Random`` so behaviour is fully
reproducible from a seed, which keeps it unit-testable.
"""
from __future__ import annotations

import argparse
import json
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator

import base58
from nacl.signing import SigningKey

from . import __version__

# --- GPU catalogue -----------------------------------------------------------
# Realistic, publicly documented specifications used only to shape simulated
# telemetry. Values are approximate and exist purely for demonstration.


@dataclass(frozen=True)
class GpuProfile:
    vendor: str
    model: str
    vram_mib: int
    power_limit_w: int
    driver_version: str
    cuda_version: str | None
    idle_temp_c: int = 32
    max_temp_c: int = 84


GPU_CATALOG: tuple[GpuProfile, ...] = (
    GpuProfile("NVIDIA", "NVIDIA GeForce RTX 4090", 24564, 450, "550.90.07", "12.4", 34, 83),
    GpuProfile("NVIDIA", "NVIDIA GeForce RTX 3090", 24576, 350, "550.90.07", "12.4", 36, 84),
    GpuProfile("NVIDIA", "NVIDIA GeForce RTX 3080", 10240, 320, "535.183.01", "12.2", 35, 85),
    GpuProfile("NVIDIA", "NVIDIA A100-SXM4-80GB", 81920, 400, "550.90.07", "12.4", 33, 82),
    GpuProfile("NVIDIA", "NVIDIA H100 PCIe", 81559, 350, "550.90.07", "12.4", 32, 80),
    GpuProfile("NVIDIA", "NVIDIA L4", 24564, 72, "550.90.07", "12.4", 34, 80),
    GpuProfile("AMD", "AMD Radeon RX 7900 XTX", 24576, 355, "rocm-6.1", None, 38, 86),
    GpuProfile("INTEL", "Intel Arc A770", 16384, 225, "xpu-1.2", None, 36, 88),
)

# Machine states surfaced to the dashboard.
STATE_AVAILABLE = "AVAILABLE"
STATE_BUSY = "BUSY"
STATE_OFFLINE = "OFFLINE"
STATE_ERROR = "ERROR"
STATE_MAINTENANCE = "MAINTENANCE"

SCENARIOS = ("steady", "idle", "spike", "overheat", "failure", "flapping", "mixed")


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


@dataclass
class SimulatedGpu:
    """A single simulated GPU with an inertial thermal/utilisation model."""

    profile: GpuProfile
    uuid: str
    utilization: int = 0
    memory_used_mib: int = 0
    temperature_c: int = 0
    power_watts: float = 0.0
    fan_percent: int = 0
    state: str = STATE_AVAILABLE
    cuda_probe_ok: bool = True
    _target_util: float = 0.0

    def __post_init__(self) -> None:
        if self.temperature_c == 0:
            self.temperature_c = self.profile.idle_temp_c

    def _pick_target(self, rng: random.Random, scenario: str, step: int) -> float:
        if scenario == "idle":
            return rng.uniform(0, 8)
        if scenario == "steady":
            return rng.uniform(45, 70)
        if scenario == "spike":
            return rng.uniform(85, 100) if step % 6 < 2 else rng.uniform(5, 25)
        if scenario == "overheat":
            return rng.uniform(92, 100)
        if scenario in {"failure", "flapping"}:
            return rng.uniform(30, 80)
        return rng.uniform(0, 100)  # mixed / unknown

    def tick(self, rng: random.Random, scenario: str, step: int) -> None:
        """Advance one interval, evolving metrics toward a scenario target."""
        if self.state in {STATE_OFFLINE, STATE_ERROR, STATE_MAINTENANCE}:
            # A machine that is not serving reports no live work.
            self.utilization = 0
            self.memory_used_mib = max(0, int(self.memory_used_mib * 0.5))
            self.temperature_c = int(_clamp(self.temperature_c - 4, self.profile.idle_temp_c - 5, self.profile.max_temp_c))
            self.power_watts = round(self.profile.power_limit_w * 0.05, 1)
            self.fan_percent = 15
            self.cuda_probe_ok = False
            return

        self._target_util = self._pick_target(rng, scenario, step)
        # Inertia: move a fraction of the way toward the target plus small noise.
        self.utilization = int(_clamp(self.utilization + (self._target_util - self.utilization) * 0.5 + rng.uniform(-4, 4), 0, 100))

        vram = self.profile.vram_mib
        baseline = int(vram * 0.06)
        target_mem = baseline + int((vram - baseline) * (self.utilization / 100.0) * rng.uniform(0.6, 0.95))
        self.memory_used_mib = int(_clamp(target_mem, 0, vram))

        hot = self.profile.idle_temp_c + (self.profile.max_temp_c - self.profile.idle_temp_c) * (self.utilization / 100.0)
        if scenario == "overheat":
            hot += 8
        self.temperature_c = int(_clamp(self.temperature_c + (hot - self.temperature_c) * 0.4 + rng.uniform(-1, 1), self.profile.idle_temp_c - 5, 105))

        self.power_watts = round(_clamp(self.profile.power_limit_w * (0.15 + 0.85 * self.utilization / 100.0), 5, self.profile.power_limit_w), 1)
        self.fan_percent = int(_clamp((self.temperature_c - self.profile.idle_temp_c) * 2.2, 10, 100))
        self.cuda_probe_ok = True
        self.state = STATE_BUSY if self.utilization > 10 else STATE_AVAILABLE

    def snapshot(self) -> dict[str, Any]:
        return {
            "gpuVendor": self.profile.vendor,
            "gpuModel": self.profile.model,
            "gpuUuid": self.uuid,
            "vramMiB": self.profile.vram_mib,
            "memoryUsedMiB": self.memory_used_mib,
            "memoryFreeMiB": max(0, self.profile.vram_mib - self.memory_used_mib),
            "driverVersion": self.profile.driver_version,
            "cudaVersion": self.profile.cuda_version,
            "gpuUtilization": self.utilization,
            "temperatureC": self.temperature_c,
            "powerWatts": self.power_watts,
            "powerLimitW": self.profile.power_limit_w,
            "fanPercent": self.fan_percent,
            "cudaProbeOk": self.cuda_probe_ok,
            "state": self.state,
        }


@dataclass
class SimulatedMachine:
    """A simulated host: one Ed25519 identity, one GPU, static system info."""

    name: str
    key: SigningKey
    gpu: SimulatedGpu
    system: dict[str, Any]
    scenario: str = "steady"
    online: bool = True
    counter: int = 0
    machine_id: str | None = None
    _flap_rng: random.Random = field(default_factory=lambda: random.Random(0))

    @property
    def public_key(self) -> str:
        return base58.b58encode(bytes(self.key.verify_key)).decode("ascii")

    def inventory(self) -> dict[str, Any]:
        snap = self.gpu.snapshot()
        return {
            "agentVersion": f"{__version__}+sim",
            "system": {
                "os": self.system["os"],
                "osVersion": self.system["osVersion"],
                "cpu": self.system["cpu"],
                "cpuCount": self.system["cpuCount"],
                "ramTotalMiB": self.system["ramTotalMiB"],
                "diskTotalMiB": self.system["diskTotalMiB"],
                "dockerAvailable": self.system["dockerAvailable"],
                "nvidiaRuntimeAvailable": self.system["nvidiaRuntimeAvailable"],
                "virtualizationAvailable": self.system["virtualizationAvailable"],
            },
            "gpus": [{
                "gpuModel": snap["gpuModel"],
                "gpuUuid": snap["gpuUuid"],
                "vramMiB": snap["vramMiB"],
                "driverVersion": snap["driverVersion"],
                "cudaVersion": snap["cudaVersion"],
                "gpuVendor": snap["gpuVendor"],
            }],
        }

    def tick(self, rng: random.Random, step: int) -> None:
        """Evolve the machine, applying connectivity effects of its scenario."""
        if self.scenario == "flapping":
            # Roughly one interval in five is a dropped connection.
            self.online = self._flap_rng.random() > 0.2
        elif self.scenario == "failure":
            # Fail permanently after a few intervals.
            if step >= 4:
                self.online = True
                self.gpu.state = STATE_ERROR
        self.gpu.tick(rng, self.scenario, step)
        if not self.online:
            self.gpu.state = STATE_OFFLINE

    def heartbeat_payload(self, challenge: str, timestamp: str, session_id: str | None = None) -> dict[str, Any]:
        """Build a signed heartbeat identical in shape to the real agent's."""
        if self.machine_id is None:
            raise RuntimeError("machine must be linked before heartbeat")
        self.counter += 1
        snap = self.gpu.snapshot()
        probe = bool(snap["cudaProbeOk"])
        util = snap["gpuUtilization"] if probe else 0
        canonical = "|".join([
            self.machine_id, str(self.counter), challenge, timestamp,
            snap["gpuUuid"], snap["gpuModel"], str(snap["vramMiB"]), snap["driverVersion"],
            str(util), str(snap["memoryUsedMiB"]), str(snap["temperatureC"]),
            str(probe).lower(), session_id or "",
        ])
        signature = base58.b58encode(self.key.sign(canonical.encode()).signature).decode("ascii")
        return {
            "machineId": self.machine_id,
            "counter": self.counter,
            "challenge": challenge,
            "timestamp": timestamp,
            "gpuUuid": snap["gpuUuid"],
            "gpuModel": snap["gpuModel"],
            "vramMiB": snap["vramMiB"],
            "driverVersion": snap["driverVersion"],
            "cudaVersion": snap["cudaVersion"],
            "gpuVendor": snap["gpuVendor"],
            "gpuUtilization": util,
            "memoryUsedMiB": snap["memoryUsedMiB"],
            "temperatureC": snap["temperatureC"],
            "powerWatts": snap["powerWatts"],
            "cudaProbeOk": probe,
            "sessionId": session_id,
            "signature": signature,
            "agentVersion": f"{__version__}+sim",
            "os": self.system["os"],
            "osVersion": self.system["osVersion"],
            "cpu": self.system["cpu"],
            "cpuCount": self.system["cpuCount"],
            "ramTotalMiB": self.system["ramTotalMiB"],
            "diskTotalMiB": self.system["diskTotalMiB"],
            "dockerAvailable": self.system["dockerAvailable"],
            "nvidiaRuntimeAvailable": self.system["nvidiaRuntimeAvailable"],
            "hardwareChanged": False,
        }


def _system_profile(rng: random.Random, vendor: str) -> dict[str, Any]:
    cpus = rng.choice([8, 12, 16, 24, 32, 64])
    return {
        "os": "Linux",
        "osVersion": rng.choice(["6.8.0-45-generic", "5.15.0-119-generic", "6.5.0-41-generic"]),
        "cpu": rng.choice([
            "AMD Ryzen 9 7950X 16-Core Processor",
            "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz",
            "AMD EPYC 7543 32-Core Processor",
        ]),
        "cpuCount": cpus,
        "ramTotalMiB": cpus * 4096,
        "diskTotalMiB": rng.choice([512_000, 1_024_000, 2_048_000]),
        "dockerAvailable": True,
        "nvidiaRuntimeAvailable": vendor == "NVIDIA",
        "virtualizationAvailable": True,
    }


def build_fleet(count: int, seed: int = 1, scenario: str = "steady") -> list[SimulatedMachine]:
    """Create ``count`` reproducible simulated machines from a seed."""
    if count < 1:
        raise ValueError("count must be >= 1")
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario: {scenario}")
    rng = random.Random(seed)
    machines: list[SimulatedMachine] = []
    for index in range(count):
        profile = GPU_CATALOG[rng.randrange(len(GPU_CATALOG))]
        key = SigningKey(bytes(bytearray(rng.getrandbits(8) for _ in range(32))))
        uuid = f"GPU-{profile.vendor[:2].lower()}-{index:03d}-{rng.getrandbits(32):08x}"
        gpu = SimulatedGpu(profile=profile, uuid=uuid)
        machine_scenario = scenario
        if scenario == "mixed":
            machine_scenario = ("steady", "idle", "spike", "overheat", "failure", "flapping")[index % 6]
        machines.append(SimulatedMachine(
            name=f"sim-{index:03d}",
            key=key,
            gpu=gpu,
            system=_system_profile(rng, profile.vendor),
            scenario=machine_scenario,
            _flap_rng=random.Random(seed * 100 + index),
        ))
    return machines


def simulate_offline(fleet: list[SimulatedMachine], steps: int, seed: int = 1) -> Iterator[dict[str, Any]]:
    """Yield metric events per machine per step without any network access."""
    rng = random.Random(seed + 7)
    for step in range(steps):
        for machine in fleet:
            machine.tick(rng, step)
            snap = machine.gpu.snapshot()
            yield {
                "event": "metric",
                "step": step,
                "machine": machine.name,
                "scenario": machine.scenario,
                "online": machine.online,
                **snap,
            }


# --- Live mode ---------------------------------------------------------------


def link_live(client: Any, machine: SimulatedMachine, code: str) -> str:
    result = client.link(code.strip().upper(), machine.public_key, machine.inventory())
    machine_id = result.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError(f"invalid link response for {machine.name}: {result}")
    machine.machine_id = machine_id
    return machine_id


def heartbeat_live(client: Any, machine: SimulatedMachine) -> dict[str, Any]:
    from .client import signed_headers

    machine_id = machine.machine_id
    if not machine_id:
        raise RuntimeError("machine must be linked before heartbeat")
    challenge_path = f"/agent/challenge/{machine_id}"
    challenge = client.request_with_retry(
        challenge_path, headers=signed_headers(machine.key, machine_id, "GET", challenge_path)
    )["challenge"]
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    payload = machine.heartbeat_payload(challenge, timestamp)
    return client.request_with_retry("/agent/heartbeat", "POST", payload)


def run_live(api_url: str, codes: Iterable[str], scenario: str, seed: int, interval: int, steps: int) -> int:
    from .client import ApiClient

    codes = list(codes)
    fleet = build_fleet(len(codes), seed=seed, scenario=scenario)
    client = ApiClient(api_url)
    for machine, code in zip(fleet, codes):
        machine_id = link_live(client, machine, code)
        print(json.dumps({"event": "linked", "machine": machine.name, "machineId": machine_id}))
    rng = random.Random(seed + 7)
    for step in range(steps):
        for machine in fleet:
            machine.tick(rng, step)
            if not machine.online:
                print(json.dumps({"event": "offline_skip", "step": step, "machine": machine.name}))
                continue
            try:
                result = heartbeat_live(client, machine)
                print(json.dumps({"event": "heartbeat", "step": step, "machine": machine.name, "result": result}))
            except Exception as exc:  # noqa: BLE001 - report and keep the fleet running
                print(json.dumps({"event": "heartbeat_error", "step": step, "machine": machine.name, "error": str(exc)[:300]}))
        time.sleep(interval)
    return 0


def add_simulate_parser(commands: argparse._SubParsersAction) -> None:  # type: ignore[type-arg]
    sim = commands.add_parser("simulate", help="simuler des machines GPU pour tester le site")
    sim.add_argument("--count", type=int, default=3, help="nombre de machines simulées (mode hors-ligne)")
    sim.add_argument("--scenario", choices=SCENARIOS, default="mixed", help="profil de charge simulé")
    sim.add_argument("--steps", type=int, default=10, help="nombre d'intervalles à simuler")
    sim.add_argument("--interval", type=int, default=5, help="secondes entre heartbeats (mode live)")
    sim.add_argument("--seed", type=int, default=1, help="graine pour une simulation reproductible")
    sim.add_argument("--api-url", help="URL de l'API pour le mode live (HTTPS ou localhost)")
    sim.add_argument("--codes", help="codes de liaison séparés par des virgules (mode live)")
    sim.set_defaults(handler=command_simulate)


def command_simulate(args: argparse.Namespace) -> int:
    if args.api_url and args.codes:
        codes = [c for c in args.codes.split(",") if c.strip()]
        if not codes:
            print("Aucun code de liaison fourni.")
            return 2
        return run_live(args.api_url, codes, args.scenario, args.seed, args.interval, args.steps)
    fleet = build_fleet(args.count, seed=args.seed, scenario=args.scenario)
    for event in simulate_offline(fleet, args.steps, seed=args.seed):
        print(json.dumps(event, ensure_ascii=False))
    return 0
