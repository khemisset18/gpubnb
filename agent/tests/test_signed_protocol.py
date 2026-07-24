from __future__ import annotations

import base58
from nacl.signing import SigningKey, VerifyKey

from gpubnb_agent.client import EMPTY_BODY_SHA256, request_body_sha256, signed_headers


def verify_v2(headers: dict[str, str], key: SigningKey, machine_id: str, method: str, path: str) -> None:
    canonical = "|".join([
        method.upper(),
        path,
        machine_id,
        headers["x-agent-timestamp"],
        headers["x-agent-nonce"],
        headers["x-agent-body-sha256"],
    ])
    VerifyKey(bytes(key.verify_key)).verify(
        canonical.encode("utf-8"),
        base58.b58decode(headers["x-agent-signature-v2"]),
    )


def test_empty_body_hash_is_stable() -> None:
    assert request_body_sha256(None) == EMPTY_BODY_SHA256


def test_v2_signature_binds_body_hash() -> None:
    key = SigningKey.generate()
    machine_id = "machine-123"
    path = "/agent/jobs/next/machine-123"
    body = {"machineId": machine_id, "counter": 7}

    headers = signed_headers(key, machine_id, "POST", path, body)

    assert headers["x-agent-signature-version"] == "2"
    assert headers["x-agent-body-sha256"] == request_body_sha256(body)
    assert headers["x-agent-nonce"]
    verify_v2(headers, key, machine_id, "POST", path)


def test_changing_body_changes_hash_and_signature() -> None:
    key = SigningKey.generate()
    first = signed_headers(key, "machine-1", "POST", "/agent/heartbeat", {"counter": 1})
    second = signed_headers(key, "machine-1", "POST", "/agent/heartbeat", {"counter": 2})

    assert first["x-agent-body-sha256"] != second["x-agent-body-sha256"]
    assert first["x-agent-signature-v2"] != second["x-agent-signature-v2"]
    assert first["x-agent-nonce"] != second["x-agent-nonce"]
