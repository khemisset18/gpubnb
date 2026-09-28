from __future__ import annotations

from gpubnb_agent import workspace_gateway as legacy
from gpubnb_agent import workspace_gateway_v8 as v8
from gpubnb_agent import workspace_gateway_v9 as v9


def test_v9_adds_only_desktop_slugs_to_linux_gateway(monkeypatch):
    original = frozenset({
        "developer", "data", "ai", "video", "audio", "api", "mobile", "security-lab"
    })
    monkeypatch.setattr(legacy, "GATEWAY_WORKSPACE_SLUGS", original)
    monkeypatch.setattr(v9.platform, "system", lambda: "Linux")

    v9.install()

    assert legacy.GATEWAY_WORKSPACE_SLUGS == original | {
        "cloud-desktop", "creator", "cad", "gaming"
    }


def test_v9_never_enables_selksies_desktop_slugs_on_windows(monkeypatch):
    original = frozenset({
        "developer", "data", "ai", "video", "audio", "api", "mobile", "security-lab"
    })
    monkeypatch.setattr(legacy, "GATEWAY_WORKSPACE_SLUGS", original)
    monkeypatch.setattr(v9.platform, "system", lambda: "Windows")

    v9.install()

    assert legacy.GATEWAY_WORKSPACE_SLUGS == original


def test_v9_does_not_replace_v8_supervisor(monkeypatch):
    monkeypatch.setattr(v9.platform, "system", lambda: "Linux")
    # v9 expands the server-authorized slug set only. Reconnect/billing pause
    # semantics remain owned by the already-qualified v8 supervisor.
    before = legacy.GatewaySupervisor
    v9.install()
    assert legacy.GatewaySupervisor is before
    assert issubclass(legacy.GatewaySupervisor, v8.qualified.GatewaySupervisor)
