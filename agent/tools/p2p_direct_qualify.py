"""Two-machine Direct QUIC qualification helper; emits non-sensitive JSON only."""
from __future__ import annotations

import argparse
import asyncio
import json
import ssl
import sys
import time
from pathlib import Path
from typing import Any

import base58
from aioquic.quic.configuration import QuicConfiguration
from nacl.signing import SigningKey

from gpubnb_agent.p2p_connectivity import discover_candidates, verify_rendezvous_ticket_details
from gpubnb_agent.p2p_direct_quic import (
    DIRECT_ALPN,
    ReplayCache,
    connect_direct_quic_first,
    host_handshake,
    listen_reserved_socket,
    punch_signed_candidates,
)


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("qualification_config_invalid")
    return value


def _key(value: Any) -> SigningKey:
    raw = base58.b58decode(value) if isinstance(value, str) else b""
    if len(raw) != 32:
        raise ValueError("qualification_ephemeral_key_invalid")
    return SigningKey(raw)


def _tls(config: dict[str, Any], role: str) -> QuicConfiguration:
    tls = config.get("tls")
    if not isinstance(tls, dict):
        raise ValueError("qualification_tls_invalid")
    result = QuicConfiguration(
        is_client=role == "RENTER",
        alpn_protocols=[DIRECT_ALPN],
        verify_mode=ssl.CERT_REQUIRED,
        server_name=tls.get("serverName") if role == "RENTER" else None,
    )
    result.load_cert_chain(str(tls["certificate"]), str(tls["privateKey"]))
    result.load_verify_locations(str(tls["caCertificate"]))
    return result


def _verified(config: dict[str, Any]):
    identity = config.get("identity")
    if not isinstance(identity, dict):
        raise ValueError("qualification_identity_invalid")
    return verify_rendezvous_ticket_details(
        config["ticket"], config["controlVerifyingKeyBase58"],
        session_id=identity["sessionId"], machine_id=identity["machineId"],
        lease_id=identity["leaseId"], fencing_token=identity["fencingToken"],
    )


async def _run(config: dict[str, Any]) -> dict[str, Any]:
    role = config.get("role")
    if role not in {"HOST", "RENTER"}:
        raise ValueError("qualification_role_invalid")
    ticket = _verified(config)
    signing_key = _key(config.get("ephemeralPrivateKeyBase58"))
    discovery_config = dict(config.get("discovery", {}))
    local_candidates = ticket.host_candidates if role == "HOST" else ticket.renter_candidates
    local_address, local_port = local_candidates[0].endpoint.rsplit(":", 1)
    del local_address
    discovery_config["bindPort"] = int(local_port)
    discovery = discover_candidates(discovery_config)
    started = time.monotonic()
    if role == "HOST":
        authenticated = asyncio.Event()
        failure: list[str] = []
        tasks: set[asyncio.Task[Any]] = set()

        async def authenticate(reader, writer):
            try:
                await host_handshake(reader, writer, ticket, signing_key, ReplayCache(), lambda _l, _f: True)
                authenticated.set()
            except Exception:
                failure.append("AUTH_FAILED")
                authenticated.set()
            finally:
                writer.close()

        def handler(reader, writer):
            task = asyncio.create_task(authenticate(reader, writer))
            tasks.add(task)
            task.add_done_callback(tasks.discard)

        await punch_signed_candidates(discovery.socket, ticket, "HOST")
        transport, server = await listen_reserved_socket(discovery.socket, _tls(config, role), handler)
        try:
            await asyncio.wait_for(authenticated.wait(), float(config.get("totalTimeoutSeconds", 15)))
            code = failure[0] if failure else "DIRECT_HOST"
            return {"role": role, "result": code, "success": not failure, "latencyMs": int((time.monotonic() - started) * 1_000)}
        except asyncio.TimeoutError:
            return {"role": role, "result": "TIMEOUT", "success": False, "latencyMs": int((time.monotonic() - started) * 1_000)}
        finally:
            server.close()
            transport.close()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    outcome = await connect_direct_quic_first(
        discovery.socket, ticket, _tls(config, role), signing_key,
        authority_check=lambda _l, _f: True,
    )
    if outcome.session is not None:
        await outcome.session.close()
    result = outcome.metrics.as_telemetry()
    result.update({"role": role, "result": outcome.code.value})
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Qualify one side of a GPUbnb Direct QUIC session")
    parser.add_argument("--config", required=True, type=Path, help="ACL-protected JSON configuration; never logged")
    args = parser.parse_args()
    try:
        result = asyncio.run(_run(_load(args.config)))
    except Exception as exc:
        code = getattr(exc, "code", "QUALIFICATION_FAILED")
        print(json.dumps({"success": False, "result": code}, separators=(",", ":")))
        return 1
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0 if result.get("success") is True else 1


if __name__ == "__main__":
    sys.exit(main())
