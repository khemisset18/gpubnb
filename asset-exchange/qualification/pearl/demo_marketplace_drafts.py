"""Offline PRL/DOGE draft/cancel walkthrough using bundled public fake data only."""
from __future__ import annotations

import json
from pathlib import Path

from marketplace_draft_lab import SyntheticDraftLedger


def main() -> None:
    request = (Path(__file__).with_name("fixtures") / "public_prl_offer_v1.json").read_bytes()
    ledger = SyntheticDraftLedger()
    draft = ledger.create(actor_label="lab_demo", command_id="cmd_demo_create_001",
                          raw_request=request, now_tick=100, expires_tick=200)
    print(json.dumps(draft, sort_keys=True))
    cancelled = ledger.cancel(actor_label="lab_demo", draft_id=draft["draftId"],
                              command_id="cmd_demo_cancel_001", expected_revision=1,
                              now_tick=110)
    print(json.dumps(cancelled, sort_keys=True))


if __name__ == "__main__":
    main()
