"""Two-machine Direct QUIC qualification helper; emits non-sensitive JSON only."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import sys
import time
from pathlib import Path
from typing import Any

import base58
from aioquic.quic.configuration import QuicConfiguration
from nacl.signing import SigningKey

from gpubnb_agent.p2p_connectivity import Candidate, discover_then_verify_ticket
from gpubnb_agent.p2p_direct_quic import (
    DIRECT_ALPN,
    ReplayCache,
    connect_direct_quic_first,
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


def _write_ephemeral_public_key(path: Path, signing_key: SigningKey) -> None:
    public = base58.b58encode(bytes(signing_key.verify_key)) + b"\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(public)
        handle.flush()
        os.fsync(handle.fileno())


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


def _identity(config: dict[str, Any]) -> dict[str, str]:
    identity = config.get("identity")
    if not isinstance(identity, dict):
        raise ValueError("qualification_identity_invalid")
    return identity


async def _file_ticket_provider(
    config: dict[str, Any], candidates: tuple[Candidate, ...]
) -> dict[str, Any]:
    rendezvous = config.get("rendezvous")
    if not isinstance(rendezvous, dict):
        raise ValueError("qualification_rendezvous_invalid")
    output = Path(rendezvous["candidateOutputFile"])
    ticket_path = Path(rendezvous["ticketInputFile"])
    # Qualification-only: keep the already reserved UDP socket alive while humans
    # exchange candidate files. This does not relax the signed ticket's 120s TTL.
    timeout = float(rendezvous.get("waitTimeoutSeconds", 600))
    poll = float(rendezvous.get("pollSeconds", 0.25))
    if not 1 <= timeout <= 1800 or not 0.05 <= poll <= 1:
        raise ValueError("qualification_rendezvous_timeout_invalid")
    if output.exists() or ticket_path.exists():
        raise ValueError("qualification_rendezvous_stale_file")
    payload = json.dumps(
        {"candidates": [candidate.as_dict() for candidate in candidates]},
        separators=(",", ":"),
    ).encode()
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        if ticket_path.is_file():
            if ticket_path.stat().st_size > 64 * 1024:
                raise ValueError("qualification_ticket_size_invalid")
            value = json.loads(ticket_path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError("qualification_ticket_invalid")
            return value
        await asyncio.sleep(poll)
    raise TimeoutError("qualification_ticket_timeout")


async def _run(config: dict[str, Any]) -> dict[str, Any]:
    role = config.get("role")
    if role not in {"HOST", "RENTER"}:
        raise ValueError("qualification_role_invalid")
    identity = _identity(config)
    signing_key = _key(config.get("ephemeralPrivateKeyBase58"))
    discovery_config = dict(config.get("discovery", {}))
    discovery, ticket = await discover_then_verify_ticket(
        discovery_config,
        lambda active: _file_ticket_provider(config, active.candidates),
        config["controlVerifyingKeyBase58"],
        session_id=identity["sessionId"],
        machine_id=identity["machineId"],
        lease_id=identity["leaseId"],
        fencing_token=identity["fencingToken"],
    )
    started = time.monotonic()
    if role == "HOST":
        authenticated = asyncio.Event()
        replay_cache = ReplayCache()

        def handler(_reader, writer):
            authenticated.set()
            writer.close()

        await punch_signed_candidates(discovery.socket, ticket, "HOST")
        transport, server = await listen_reserved_socket(
            discovery.socket, _tls(config, role), ticket, signing_key,
            replay_cache, lambda _l, _f: True, handler,
        )
        try:
            await asyncio.wait_for(authenticated.wait(), float(config.get("totalTimeoutSeconds", 15)))
            return {"role": role, "result": "DIRECT_HOST", "success": True, "latencyMs": int((time.monotonic() - started) * 1_000)}
        except asyncio.TimeoutError:
            return {"role": role, "result": "TIMEOUT", "success": False, "latencyMs": int((time.monotonic() - started) * 1_000)}
        finally:
            server.close()
            transport.close()

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
    parser.add_argument(
        "--ephemeral-public-key-output", type=Path,
        help="Create a Base58 public-only exchange file before discovery",
    )
    args = parser.parse_args()
    try:
        config = _load(args.config)
        if args.ephemeral_public_key_output is not None:
            _write_ephemeral_public_key(
                args.ephemeral_public_key_output,
                _key(config.get("ephemeralPrivateKeyBase58")),
            )
        result = asyncio.run(_run(config))
    except Exception as exc:
        code = getattr(exc, "code", "QUALIFICATION_FAILED")
        print(json.dumps({"success": False, "result": code}, separators=(",", ":")))
        return 1
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0 if result.get("success") is True else 1


if __name__ == "__main__":
    sys.exit(main())
