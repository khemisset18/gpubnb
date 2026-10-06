# gpu.k.p2p — Fee and Revenue Architecture v0

Status: PRODUCT + PROTOCOL DESIGN / PRE-IMPLEMENTATION / NO REAL FUNDS

## 1. Purpose

This document defines a transparent, non-custodial revenue model for gpu.k.p2p.

Goals:
- generate sustainable platform revenue;
- preserve non-custodial settlement;
- avoid charging users for failed swaps where technically avoidable;
- keep fees simple and visible;
- support fungible assets and NFTs;
- avoid making fee logic a hidden security dependency;
- keep network fees separate from platform fees;
- preserve recovery/refund rights.

## 2. Market reference

Current public marketplace models commonly use percentage fees.

Examples observed in 2026:
- OpenSea platform fee around 1% on NFT sales;
- Magic Eden marketplace fee around 2% on supported NFT transactions;
- centralized exchanges often use maker/taker schedules with volume tiers.

gpu.k.p2p should not copy a competitor blindly. Its security model is different because settlement is non-custodial and cross-chain.

## 3. Recommended V1 pricing

### Fungible asset swaps

Standard platform success fee:
- 0.35% of the taker's received asset value.

High-volume tier candidate:
- 0.25%.

Market-maker / strategic liquidity tier candidate:
- 0.15%.

Launch recommendation:
- keep one simple public rate of 0.35% until meaningful volume exists;
- introduce tiers only after operational data exists.

### NFT trades

Platform fee:
- 1.00% of successful NFT sale value.

Listing fee:
- 0%.

Offer creation:
- 0%.

Offer cancellation before chain commitment:
- 0%.

Creator royalty:
- separate from gpu.k.p2p platform fee;
- passed through according to collection rules, chain capability and active policy;
- never silently treated as platform revenue.

### Network fees

Blockchain gas/miner fees are paid separately by the relevant participant and are not platform revenue.

The UI must distinguish:

Platform fee
Creator royalty
Network fee
Total received / total paid

## 4. Why 0.35% for fungible swaps

0.35% is intended as a commercial starting point balancing:
- sustainable platform revenue;
- lower friction than many centralized retail schedules;
- ability to fund security/audits/infrastructure;
- sufficient room for future volume discounts;
- user simplicity.

It is not a permanent protocol constant.

Fee schedules are versioned configuration and are pinned into signed trade terms.

## 5. Why 1% for NFTs

A 1% NFT platform fee is:
- simple;
- competitive against current NFT marketplaces;
- large enough to support marketplace operations;
- low enough not to dominate creator royalties or network fees.

NFT economics differ from fungible swaps, so one universal percentage is not recommended.

## 6. Core fee principle

A platform fee must never be hidden.

Before any signature the user must see:
- gross amount;
- platform fee;
- creator royalty where applicable;
- estimated network fee;
- net amount sent;
- net amount received;
- exact asset/network used for the platform fee.

The signed terms include the fee schedule.

## 7. Signed fee policy

FeePolicyV1 {
  policy_id
  version
  fee_type
  rate_bps
  minimum_atomic?
  maximum_atomic?
  payer_role
  fee_asset
  fee_recipient_descriptor
  success_condition
  refund_condition
  valid_from
  policy_hash
}

Use basis points or integer rational representation.

Never use floating point.

Example:
35 basis points = 0.35%.

## 8. Immutable fee after acceptance

Once both parties sign terms:
- platform rate cannot change;
- fee recipient cannot change;
- fee asset cannot change;
- royalty terms cannot change;
- payer cannot change.

Any material change requires new signed terms.

## 9. No fee-address substitution

Fee recipient address/script/program ID must be:
- versioned;
- part of signed protocol configuration;
- displayed in advanced verification;
- protected by admin WYSIWYS controls;
- independently audited.

A compromised frontend must not be able to replace the fee destination.

## 10. UTXO challenge

Bitcoin-style scripts cannot generally enforce arbitrary output distributions from a later spend without additional covenant-like capabilities.

Therefore a naive design such as:
"redeemer will voluntarily include 0.35% in the redeem transaction"
is not enforceable.

Likewise, taking the fee immediately in the funding transaction charges the user even if the trade later aborts.

Both designs are undesirable as the default.

## 11. Recommended UTXO conditional fee design

For Bitcoin-family protocols, research a separate fee HTLC output associated with the successful trade.

Concept:

Funding side creates:
- principal HTLC output;
- platform-fee HTLC output.

Both use the same success secret hash H but separate refund conditions.

If the swap succeeds and S becomes public:
- counterparty redeems principal according to protocol;
- gpu.k.p2p fee collector can redeem fee output using S under its authorized fee script.

If the swap aborts and S never becomes available:
- original funder recovers the fee output after its defined refund timeout.

Goal:
platform fee becomes collectible only when settlement success reveals the required secret.

## 12. Fee HTLC security constraints

This model is NOT production-approved yet.

Must prove:
- fee output does not change fairness;
- timeout ordering is safe;
- fee refund cannot be stranded;
- platform cannot claim fee before success condition;
- platform cannot claim principal;
- user can recover fee output if trade aborts;
- fee output does not introduce practical pinning;
- added transaction weight does not make recovery uneconomic;
- dust rules are respected;
- txid/replacement assumptions remain valid.

Until proven in G2/G3/G4:
UTXO success-fee enforcement remains BLOCKED.

## 13. Small-trade handling

A percentage fee can become smaller than dust or cost more to collect than its value.

For each chain define:
- minimum economically viable trade size;
- minimum platform fee output;
- dust threshold;
- collection threshold.

If fee output would be uneconomic:
- aggregate only if protocol can do so safely without custody;
- or waive fee;
- or block trade size.

Never create dust intentionally just to collect a platform fee.

## 14. Fee collection key isolation

Fee collection keys are platform treasury keys, not user-custody keys.

Requirements:
- separate from deployment/admin keys;
- separate by environment;
- preferably HSM/hardware-backed or multisig depending on chain;
- withdrawal controls;
- audit trail;
- rotation plan;
- compromised fee key cannot spend user principal.

A fee key compromise must not compromise user recovery.

## 15. Treasury architecture

Platform revenue should flow into dedicated treasury addresses/accounts.

Separate:
- operating treasury;
- tax/accounting reporting;
- security reserve;
- optional insurance/risk reserve.

Do not reuse one hot wallet for every chain.

## 16. Fee withdrawal controls

Treasury withdrawal:
- strong admin authentication;
- WYSIWYS;
- destination allowlist where appropriate;
- velocity/amount limits;
- optional multisig/dual approval;
- audit log.

Treasury security is separate from settlement.

## 17. Fee accounting

Each collected fee records:
- trade_id;
- chain/network;
- asset;
- atomic amount;
- fee policy version;
- transaction/outpoint;
- collection state;
- treasury destination;
- fiat reference value if required for accounting, clearly marked as reference only.

PostgreSQL records accounting metadata.
Blockchain remains source of truth for actual on-chain payment.

## 18. NFT settlement model

For smart-contract/program-based NFT settlement, platform fee should be enforced atomically by the settlement program where technically and legally appropriate.

Successful sale distribution can conceptually be:

gross sale
-> seller proceeds
-> gpu.k.p2p platform fee
-> creator royalty, if applicable/enforced
-> network fee separately

No platform fee on failed/reverted settlement.

## 19. NFT creator royalties

Creator royalties are not platform revenue.

The platform should model:
- REQUIRED_ONCHAIN;
- OPTIONAL_MARKETPLACE;
- NOT_SUPPORTED;
- UNKNOWN.

UI must tell buyer/seller whether royalty is technically enforced or merely marketplace policy.

Do not falsely claim royalty enforcement where chain/token standard does not enforce it.

## 20. NFT fee recommendation

Default successful NFT sale:

Platform: 1.00%
Creator royalty: independent
Listing: 0%
Cancellation before settlement: 0%

Future volume/partner discount:
0.75% or 0.50% can be evaluated later.

Avoid launching with complex NFT tiers.

## 21. Primary-sale option

For creators using gpu.k.p2p for a primary NFT sale, future optional pricing may include:

- 1.0% standard marketplace fee;
- optional creator storefront/service fee for advanced tooling;
- no hidden percentage on royalty.

Do not add primary-sale complexity to V1 unless demanded by users.

## 22. Collection verification

NFT fees must not depend on untrusted metadata alone.

Collection identity must use:
- exact chain;
- contract/program;
- token standard;
- collection authority/verified collection semantics;
- token ID.

Do not calculate royalty from a spoofed collection name.

## 23. Fee-on-transfer tokens

Tokens that themselves charge transfer fees can break expected net amounts.

These assets require a risk capability flag.

Before support:
- detect transfer-fee semantics where possible;
- compute or safely bound actual received amount;
- reject unsupported dynamic/opaque fees.

Platform fee is separate from token issuer transfer fee.

## 24. Rebasing and exotic assets

Percentage platform fees are unsafe if the received amount can mutate unexpectedly during settlement.

Assets such as:
- rebasing tokens;
- reflection tokens;
- tax tokens;
- hook-enabled tokens

require specific adapter support or MARKETPLACE ONLY status.

## 25. Stablecoins

USDT/USDC fee policy must bind exact network.

Example:
USDC Ethereum != USDC Solana.

Fee denomination should preferably be the asset received by the fee-paying side when technically enforceable.

Do not silently convert to another token.

## 26. Maker/taker model

V1 UX should remain simple.

Definitions:
- maker creates resting offer;
- taker accepts existing offer.

Recommended public launch:
- taker pays the standard platform fee;
- maker pays 0 platform trading fee.

Advantages:
- easy to understand;
- encourages offer liquidity;
- one fee-paying role;
- avoids double charging.

Future:
maker rebate or lower taker fee can be introduced by volume.

## 27. Recommended launch schedule

Fungible swaps:
- Maker: 0.00%
- Taker: 0.35%

NFT:
- Listing: 0.00%
- Seller platform fee: 1.00%
- Creator royalty: separate
- Buyer platform fee: 0.00%

Network fees:
- paid by whoever creates/broadcasts the relevant transaction.

This should be treated as a commercial starting point, not a permanent promise.

## 28. Failed trade policy

Desired rule:

No successful settlement => no platform success fee.

Exceptions:
- unavoidable blockchain/network fees remain user costs;
- malicious behavior penalties are not introduced in V1.

Any chain where success-only platform fee cannot be implemented safely requires explicit alternative design and disclosure.

## 29. Cancellation

Before fund commitment:
- no platform fee.

After fund commitment:
- protocol recovery applies;
- no extra "cancellation penalty" in V1.

This keeps recovery incentives clean.

## 30. Refund fee

gpu.k.p2p should not charge an additional platform percentage for refund.

User may still pay network miner/gas fee.

Charging users because a trade failed would damage trust and can create perverse incentives.

## 31. Recovery neutrality

Platform fee collection cannot block:
- refund;
- redeem;
- recovery.

Fee collector outage:
- must not strand principal;
- must not prevent user recovery.

Fee collection is lower priority than user fund safety.

## 32. Fee service outage

If platform fee infrastructure is unavailable:
- do not create unsafe new commitments;
- active user recovery continues.

For protocol designs where fee collection is optional after success:
- user principal completion must not depend on platform collecting revenue first.

## 33. Fee policy change

Changing rates:
- affects new terms only;
- version increments;
- admin strong reauthentication;
- audit event;
- UI notice where appropriate.

Existing signed trades keep original fee policy.

## 34. Fee kill switch

Admin may disable charging for new trades.

Admin cannot:
- retroactively increase rate;
- redirect existing signed fee output;
- remove user refund path.

## 35. Promotions

Future promotion examples:
- 0% first N trades;
- volume tier;
- verified maker discount;
- campaign code.

Promotion rules:
- signed into terms;
- server evaluated before acceptance;
- cannot alter chain security.

Avoid coupon complexity in V1.

## 36. Subscription revenue

Optional future secondary revenue:
- professional analytics;
- API plans;
- business operator plans;
- white-label/self-hosted licenses.

These are safer revenue sources because they do not alter settlement cryptography.

They should supplement, not replace, trading fees.

## 37. Enterprise/self-hosted revenue

Mode SOUVERAIN deployments can support:
- annual software license;
- support/SLA;
- paid updates;
- managed infrastructure;
- security/audit package.

Operator may configure its own end-user fee schedule within allowed technical limits.

The commercial license model is separate from KYC policy.

## 38. No dark patterns

Forbidden:
- hidden spread;
- undisclosed markup;
- changing fee at final click;
- fee buried in exchange rate;
- default creator royalty misrepresented as network fee;
- charging platform fee twice.

## 39. Price reference

Platform percentage should be computed from the actual atomic traded amount, not a volatile fiat conversion, whenever possible.

Fiat values may be displayed for convenience/accounting.

Do not make cryptographic fee amount depend on one external price oracle unless protocol explicitly requires it.

## 40. Fee rounding

All fee math uses integers.

Recommended deterministic formula:

fee = floor(amount_atomic * fee_bps / 10_000)

or another explicitly chosen rounding policy.

Rounding policy must be fixed in signed FeePolicy.

Check overflow using sufficiently wide integer arithmetic.

## 41. Minimum fee

Do not impose a universal fixed minimum until per-chain economics are known.

Per-chain FeePolicy may define minimum_atomic only after dust and network-fee analysis.

## 42. Maximum fee

For very large trades, a future fee cap can make the platform attractive to institutional users.

Do not launch with a cap before revenue/risk data exists.

Architecture should support optional maximum_atomic.

## 43. NFT high-value cap

Optional future rule:
a maximum platform fee for very high-value NFT sales.

Not recommended for V1 until marketplace behavior is observed.

## 44. Fee tax/compliance

Platform fees are business revenue and require:
- accounting;
- tax treatment;
- invoices/receipts where applicable;
- legal entity analysis;
- jurisdiction review.

Do not treat on-chain fees as outside normal accounting obligations.

## 45. KYC separation

Fee collection does not change the product separation rule.

Exchange KYC/Compliance, where required, remains inside gpu.k.p2p.

Platform fee collection must not impose Exchange KYC on:
- mining;
- rental;
- Core services.

## 46. CONFORMITE mode

Fee policy can integrate:
- required disclosures;
- tax/accounting metadata;
- regulated fee schedules where applicable;
- operator-specific restrictions.

Cryptographic fee safety remains identical.

## 47. SOUVERAIN mode

Operator may configure:
- platform rate;
- fee recipient;
- revenue model;
subject to protocol safety constraints.

No software-level forced universal KYC.

SOUVERAIN still does not imply legal exemption.

## 48. Admin fee security

Critical fee administration actions:
- set fee recipient;
- set rate;
- activate policy;
- retire policy.

Require:
- WebAuthn/passkey;
- fresh challenge;
- WYSIWYS;
- target deployment;
- old/new rate;
- old/new recipient;
- config hash;
- audit.

Fee recipient change is treated like a treasury/security event.

## 49. Fee recipient rotation

Rotation procedure:
- create new recipient;
- verify ownership;
- security approval;
- policy version bump;
- new trades use new recipient;
- existing trades keep old signed recipient where needed;
- monitor both until old exposure ends.

Do not mutate existing signed fee scripts.

## 50. Threats

FEE-001 frontend changes fee address.
FEE-002 compromised admin raises fee silently.
FEE-003 user charged after failed trade.
FEE-004 fee output blocks refund.
FEE-005 fee output below dust.
FEE-006 fee collection key spends principal.
FEE-007 fee computation overflow/rounding mismatch.
FEE-008 creator royalty spoofing.
FEE-009 token transfer tax causes wrong net amount.
FEE-010 stale fee policy replay.
FEE-011 fee recipient rotation breaks active trades.
FEE-012 accounting DB disagrees with chain.
FEE-013 operator fee server outage blocks recovery.
FEE-014 user bypasses non-enforceable UTXO fee.
FEE-015 malicious party pins conditional fee/refund path.

## 51. Mandatory tests

Before fees are enabled:

1. exact integer fee vectors;
2. max integer/overflow vectors;
3. rounding boundary;
4. changed fee recipient invalidates signed terms;
5. changed fee rate invalidates signed terms;
6. old policy cannot authorize new trade after expiry;
7. failed swap does not collect success fee in supported protocol;
8. refund recovers principal and refundable fee output;
9. fee collector unavailable does not block principal recovery;
10. dust threshold test;
11. fee spike test;
12. pinning test;
13. reorg after fee-secret revelation;
14. treasury-key compromise simulation;
15. NFT royalty/fee separation;
16. fee-on-transfer asset rejection;
17. UI shows exact total before signing.

## 52. Accounting reconciliation

Daily/periodic reconciliation:
- expected platform fees from signed trades;
- actual chain-collected fees;
- unclaimed conditional fee outputs;
- refunded fee outputs;
- reorged collections;
- treasury balances.

Mismatch raises alert.

Accounting service cannot alter settlement state.

## 53. User receipt

After completion, provide receipt containing:
- trade ID;
- gross values;
- platform fee;
- royalty;
- network fee where observable;
- transaction identifiers;
- fee policy version.

No sensitive KYC data in receipt.

## 54. Revenue dashboard

Future internal dashboard may show:
- gross volume;
- platform fee revenue;
- revenue by chain;
- revenue by asset family;
- NFT revenue;
- unclaimed conditional fees;
- fee refunds;
- average fee per trade.

Dashboard is read-only from financial truth sources.

## 55. Business recommendation

Recommended commercial launch:

CRYPTO / FUNGIBLE
- maker: 0%
- taker: 0.35%
- listing: 0%
- cancellation before lock: 0%
- failed settlement platform success fee: 0%
- network costs: separate

NFT
- listing: 0%
- seller platform fee on successful sale: 1.00%
- buyer platform fee: 0%
- creator royalty: separate and explicitly displayed
- network cost: separate

ENTERPRISE / SOUVERAIN
- optional software/SLA/license revenue
- configurable operator fee policy within security constraints

## 56. Why this model

It:
- encourages makers to create liquidity;
- is easy to explain;
- keeps NFT pricing competitive;
- avoids charging users simply for listing;
- aligns platform revenue with successful transactions;
- separates blockchain costs from company revenue;
- gives future room for volume discounts;
- supports additional enterprise revenue without weakening protocol safety.

## 57. Implementation blockers

Before enabling on UTXO real settlement:
- conditional fee HTLC fully specified;
- script reviewed;
- timeout interaction modeled;
- dust/fee economics tested;
- pinning analyzed;
- regtest tests passed;
- formal model updated;
- G3 recovery includes fee output;
- external review.

Before enabling NFT fees:
- settlement contract/program architecture;
- royalty semantics per chain;
- reentrancy/approval/upgradeability review;
- transfer-tax/hook detection where applicable;
- contract/program audit.

## 58. Current status

Commercial fee model: PROPOSED.
Recommended public rates: DEFINED FOR REVIEW.
UTXO cryptographic fee enforcement: RESEARCH / BLOCKED.
NFT atomic fee enforcement: NOT IMPLEMENTED.
Treasury: NOT PROVISIONED.
Accounting: NOT IMPLEMENTED.
Real fee collection: FORBIDDEN.
