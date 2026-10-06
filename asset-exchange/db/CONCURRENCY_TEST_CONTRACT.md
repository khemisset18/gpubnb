# Accept / cancel concurrency test contract

These tests are mandatory before G5 persistence is considered implemented.

## Accept vs accept

Two independent database sessions attempt to consume the same OPEN offer with distinct trade IDs.

Expected:
- exactly one transaction commits a trade;
- exactly one `trades.offer_id` exists;
- offer state is CONSUMED;
- accepted_trade_id references the winner;
- loser receives a conflict/precondition failure;
- no orphan trade/event exists.

## Accept vs cancel

One session accepts while another cancels.

Allowed final states:
- CONSUMED with exactly one trade; or
- CANCELLED with zero trades.

Forbidden:
- CANCELLED plus a trade;
- CONSUMED without accepted_trade_id;
- two terminal histories.

## Retry after ambiguous client failure

Simulate:
1. server commits;
2. response is lost;
3. client retries with same idempotency key/hash.

Expected:
same logical result, no second trade/event.

Retry with same key but different hash:
hard failure.

## Epoch race

Begin mode transition and increment operator epoch while an old accept/lock command is pending.

Expected:
stale epoch cannot create a new acceptance/lock after the fence.

Existing recovery rights are unaffected.

## Expiry boundary

Use database authoritative time, not browser time.

An offer with `expires_at <= clock_timestamp()` cannot be accepted.

## Crash points

Inject crash:
- before row lock;
- after row lock;
- after trade insert before offer update;
- after offer update before event insert;
- after event insert before commit;
- immediately after commit before response.

All pre-commit crashes must roll back.
Post-commit retry must be idempotent.
