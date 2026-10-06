# GPUbnb Asset Exchange — Asset Taxonomy and Locking Model v0

Status: WORKING DRAFT / PRE-DEVELOPMENT / NO REAL FUNDS

## 1. Purpose

This specification defines the extensible taxonomy used by GPUbnb Asset Exchange to represent
transferable blockchain assets and to decide, independently for every asset, whether it may be:

- displayed;
- listed;
- offered;
- traded;
- cryptographically locked;
- redeemed;
- refunded;
- recovered;
- automatically settled.

The objective is not to claim that every blockchain asset is safely swappable.

The objective is to represent a very broad universe of assets while exposing automatic secure
settlement only where the chain, asset and protocol have passed the required security gates.

## 2. Canonical asset identity

Never identify an asset only by symbol, name or logo.

Canonical identity must include, where applicable:

- asset_id;
- asset_class;
- chain_id;
- network_id;
- protocol_family;
- native_or_contract;
- contract_or_asset_identifier;
- token_id;
- pool / wrapper / bridge identity when security-relevant;
- version when protocol semantics depend on it.

Example:

USDT on Ethereum
is not
USDT on Solana
is not
USDT on Tron.

An NFT collection plus token ID 42 is not token ID 43.

## 3. Universal capability model

Every asset must expose independent capability flags:

- marketplace_enabled;
- new_offers_enabled;
- new_trades_enabled;
- ownership_proof_supported;
- transfer_supported;
- transfer_simulation_supported;
- lock_supported;
- lock_mechanism;
- lock_protocol_version;
- redeem_supported;
- refund_supported;
- recovery_supported;
- automatic_settlement_supported;
- partial_fill_supported;
- bundle_supported;
- privacy_sensitive;
- issuer_controlled;
- upgradeable;
- pausable;
- freezable;
- blacklistable;
- rebasing;
- fee_on_transfer;
- transfer_hook_possible;
- non_transferable_possible;
- risk_level;
- support_status;
- policy_tags.

Security invariant:

automatic_settlement_supported may be true only if locking, redeem, refund and recovery are all
supported by a reviewed protocol for that exact chain/network/asset class.

## 4. Public support statuses

### SECURE

Automatic settlement protocol exists, real chain-enforced locking exists, recovery/refund exist and
the applicable security gates have passed.

### LIMITED

Some support exists but important restrictions remain. Limits, wallet combinations or settlement
paths may be restricted.

### MARKETPLACE ONLY

The asset may be listed and discovered, but GPUbnb does not claim automatic secure settlement.

### QUARANTINED

New exposure is stopped. Existing redeem/refund/recovery must remain possible when the protocol
permits it.

# PART I — ASSET CATEGORIES

## 5. Native UTXO coins

Examples include BTC, DOGE, LTC, BCH and other UTXO chains only after independent validation.

Possible lock families:

- HTLC;
- script-based conditional spend;
- CLTV/CSV constructions;
- adaptor-signature constructions;
- chain-specific covenants or equivalent mechanisms.

Required per-chain review:

- script semantics;
- locktime;
- CLTV;
- CSV;
- malleability;
- RBF;
- CPFP;
- dust;
- mempool relay policy;
- ancestor/descendant limits;
- fee policy;
- reorg behavior.

Rule: a Bitcoin-derived chain is never assumed protocol-compatible merely because it is a fork.

## 6. Native account-based coins

Examples may include ETH, ETC, BNB, AVAX C-Chain native asset and CFX eSpace native asset.

Possible lock mechanisms:

- minimal HTLC-style contract;
- purpose-built escrow contract;
- chain-native conditional mechanism.

Required checks:

- chain ID;
- nonce/order semantics;
- fee market;
- finality/reorg behavior;
- gas availability for refund;
- chain-halt behavior.

## 7. Standard fungible tokens

Examples:

- ERC-20-like tokens;
- SPL tokens;
- equivalent fungible standards.

Subclasses must include:

- simple token;
- mintable;
- burnable;
- pausable;
- blacklistable;
- freezable;
- upgradeable;
- fee-on-transfer;
- rebasing;
- hook/callback-enabled;
- privileged delegate/admin;
- unusual transfer semantics.

A standard interface does not mean a safe settlement asset.

## 8. Stablecoins

Examples include USDT and USDC, always with explicit network.

Additional risks:

- issuer freeze;
- blacklist;
- contract upgrade;
- mint/burn authority;
- sanctions controls;
- contract migration;
- emergency pause;
- bridge dependency.

Technical lockability and policy eligibility are separate questions.

## 9. Asset-referenced / basket / commodity-referenced tokens

May reference:

- currencies;
- commodities;
- baskets;
- indices;
- other assets.

Additional risks:

- issuer;
- redemption;
- oracle dependency;
- transfer restrictions;
- legal classification.

## 10. Wrapped assets

Examples conceptually include wrapped BTC, wrapped ETH and wrapped cross-chain tokens.

Risks:

- custodian;
- multisig;
- bridge;
- smart contract;
- depeg;
- redemption failure;
- issuer freeze;
- upgrade.

GPUbnb should prefer native-to-native settlement where practical.

## 11. Bridged assets

A bridged asset is not automatically equivalent to its origin-chain asset.

Identity must include destination chain, bridge implementation and exact token contract.

Risks:

- bridge compromise;
- verifier compromise;
- synthetic issuance;
- pause;
- governance compromise;
- finality mismatch.

Initial recommendation: marketplace possible, automatic settlement only after bridge-specific review.

## 12. NFTs / unique non-fungible assets

Examples:

- ERC-721-like assets;
- Solana NFTs;
- unique chain-native objects;
- transferable game items.

Canonical identity:

- chain;
- network;
- contract/collection;
- token ID;
- relevant standard/program.

Possible locking:

- NFT escrow contract;
- chain program/PDA escrow;
- chain-specific native mechanism.

Metadata never defines canonical ownership.

## 13. Semi-fungible tokens

Examples include ERC-1155-like assets.

Identity includes:

- chain;
- network;
- contract;
- token ID;
- amount.

Risks include batch-transfer semantics, callbacks and approval-for-all.

## 14. Multi-asset contracts

Some contracts represent many internal asset IDs.

Contract address alone is not sufficient identity.

Required:

- contract;
- internal asset ID;
- amount;
- transfer behavior;
- callback behavior.

## 15. Privacy-native coins

Examples include XMR and other privacy-focused native assets.

Potential settlement research areas:

- adaptor signatures;
- DLEQ-related constructions;
- protocol-specific cross-chain swap mechanisms.

Absolute rule: no invented cryptography.

Automatic settlement requires independent cryptographic review and license review of external
research/code.

## 16. Shielded assets and shielded pools

Protocol generations must be distinct when security assumptions differ.

For Zcash, at minimum distinguish:

- transparent;
- Sapling;
- Orchard;
- Ironwood or future protocol generations when relevant.

Never expose one generic secure flag for every ZEC pool.

## 17. Native escrow-capable ledgers

Some ledgers expose native conditional escrow mechanisms.

XRPL is an example worth independent study.

Possible benefits:

- reduced smart-contract attack surface;
- native preimage/timelock semantics.

Still requires ledger-specific security analysis.

## 18. Smart-contract / program-platform assets

Includes non-EVM programmable chains.

Possible locking:

- smart-contract escrow;
- program escrow;
- PDA/object/capability lock;
- native resource mechanism.

Do not force every programmable chain into an EVM abstraction.

## 19. Solana assets

Distinguish at minimum:

- native SOL;
- classic SPL Token;
- Token-2022;
- explicitly supported NFT/program variants.

For Token-2022 inspect relevant extensions and authorities before each trade.

## 20. EVM-family assets

Potential families include Ethereum, Ethereum Classic, BNB Chain, Avalanche C-Chain and Conflux
eSpace after validation.

Per-token checks may include:

- proxy;
- implementation;
- admin;
- pause;
- blacklist;
- transfer fee;
- rebase;
- callback;
- permit;
- approval semantics;
- code/config changes.

## 21. Governance tokens

Governance is a business category, not a technical settlement guarantee.

A governance asset may be:

- fungible;
- staked;
- vote-escrowed;
- wrapped;
- non-transferable.

Only actually transferable forms are eligible.

## 22. Liquid-staking / staked receipt tokens

Risks:

- slashing;
- withdrawal queue;
- changing exchange rate;
- rebase;
- wrapper;
- protocol insolvency.

The traded asset is the receipt token unless the protocol explicitly guarantees something else.

## 23. Yield-bearing / vault-share tokens

Examples conceptually include lending receipts and vault shares.

Risks:

- share-price changes;
- withdrawal limits;
- protocol insolvency;
- pause;
- underlying asset risk.

Trade terms should use exact token/share units, not implied future redemption value.

## 24. Liquidity-provider positions

Possible forms:

- fungible LP token;
- NFT position;
- custom position object.

Risks:

- changing pool composition;
- fees;
- protocol upgrade;
- lock status;
- underlying asset volatility.

## 25. Lending positions / debt receipts

May include:

- lender receipt;
- transferable debt position;
- collateral position;
- position NFT.

Default status should be marketplace-only until protocol-specific obligations are understood.

## 26. Derivatives and synthetic assets

Examples conceptually:

- synthetic commodities;
- synthetic equities;
- perpetual position tokens;
- options;
- margin positions.

Risks:

- oracle;
- liquidation;
- margin;
- expiry;
- issuer;
- legal classification.

Token transfer atomicity does not eliminate derivative risk.

## 27. Tokenized real-world assets

Examples:

- tokenized bond;
- fund share;
- property-related interest;
- receivable;
- commodity claim;
- tokenized security.

Potential restrictions:

- allowlisted holders;
- KYC;
- accreditation;
- jurisdiction;
- lock-up;
- transfer-agent approval;
- issuer freeze.

Technical transferability does not imply unrestricted legal transferability.

## 28. Security / investment tokens

Potentially regulated instruments require separate policy classification.

Do not infer legal status from token names.

Technical registry support and legal eligibility are separate.

## 29. Tokenized fiat / e-money-like assets

Separate policy class from ordinary generic tokens.

Additional considerations:

- issuer status;
- redemption;
- freeze;
- customer eligibility;
- transfer-information requirements.

## 30. Central-bank / institutional digital assets

Examples conceptually:

- wholesale settlement tokens;
- CBDC-like instruments;
- bank-issued permissioned tokens.

Likely deployment-specific and often permissioned.

## 31. Permissioned-chain assets

Characteristics may include:

- consortium validators;
- membership;
- off-chain identity;
- administrator override.

Security model must explicitly state whether locking is cryptographically irreversible or
administratively overrideable.

## 32. Gaming assets

Possible forms:

- NFT;
- semi-fungible item;
- fungible currency;
- custom object.

Publisher-controlled utility is separate from blockchain ownership.

## 33. Virtual land / metaverse assets

Usually technically an NFT/object.

External rights must not be confused with possession of the on-chain token.

## 34. Blockchain names / domains

Risks include:

- expiry;
- renewal;
- registry upgrade;
- wrappers;
- subname rules.

Identity must bind to exact registry and token/object.

## 35. Membership / access tokens

Can be transferable or non-transferable.

Only transferable forms can be exchange inventory.

## 36. Tokenized tickets

Risks include:

- expiry;
- organizer cancellation;
- resale restriction;
- identity binding.

Policy must honor actual transfer restrictions.

## 37. Loyalty / points tokens

May be transferable, issuer-restricted or non-transferable.

On-chain existence alone does not make the asset eligible.

## 38. Social / creator tokens

Usually technically fungible or NFT-based.

Risks include issuer concentration, changing utility and possible regulatory classification.

## 39. Digital collectibles

Includes art, cards, profile assets, music-related tokens and other collectibles.

Settlement identity uses chain/contract/token ID, never untrusted metadata alone.

## 40. Inscriptions / ordinal-like assets

Risks:

- indexer disagreement;
- UTXO selection;
- accidental burn;
- wallet incompatibility;
- protocol convention changes.

Default: marketplace-only / R&D until deterministic independent tracking is validated.

## 41. UTXO overlay / colored-coin assets

Base-chain coin locking is not necessarily enough to preserve overlay-asset ownership.

Requires deterministic protocol parser and safe UTXO selection.

## 42. Runes / protocol-layer fungible overlays

Identity requires base chain, overlay protocol and overlay asset ID.

Automatic settlement requires proving settlement transactions preserve overlay semantics.

## 43. Cross-chain message-backed assets

Higher-risk class due to:

- relayer;
- verifier;
- light-client;
- bridge;
- oracle;
- finality mismatch.

## 44. Rebasing tokens

Balance can change without ordinary transfer.

Settlement must explicitly model shares/rebase semantics.

Default: not secure until protocol-specific handling exists.

## 45. Fee-on-transfer tokens

A requested transfer of 100 can result in an escrow receiving less than 100.

Naive escrow is unsafe.

Default: block unless protocol measures and accepts actual received amount.

## 46. Blacklist/freeze tokens

Issuer action can break transfer or refund.

A cryptographically valid refund path that an issuer can freeze has a different residual-risk class
from a censorship-resistant native asset.

## 47. Pausable tokens

Required:

- pre-trade pause-state check;
- authority inspection;
- active-trade monitoring;
- recovery policy.

## 48. Upgradeable tokens

Contract behavior can change after offer publication.

Required:

- implementation identity;
- admin identity;
- pre-trade revalidation;
- settlement-time revalidation;
- upgrade incident policy.

## 49. Hook/callback tokens

Risks:

- reentrancy;
- unexpected external calls;
- transfer failure;
- malicious callback.

Settlement must be explicitly safe against token callbacks.

## 50. Non-transferable / soulbound credentials

Not exchangeable inventory.

Default:

- marketplace_enabled = false;
- transfer_supported = false;
- lock_supported = false.

May still be usable for identity or eligibility.

## 51. Expiring assets

Examples include tickets, options, memberships and time-limited rights.

Expiry must be represented when it changes transfer/value semantics.

## 52. Fractionalized assets

The fractional token is its own asset.

Never silently represent it as direct ownership of an external underlying object.

## 53. Fractional NFTs

Usually represented by a wrapper/vault/share token.

The wrapper asset, not only the original NFT, must be identified.

## 54. Basket / index tokens

One transferable token can represent many underlying assets.

GPUbnb trades the basket token itself, not a guaranteed composition unless explicitly specified.

## 55. Native multi-asset bundles

Future architecture may support:

Bundle A:
- asset 1;
- asset 2;
- asset 3;

against Bundle B:
- asset 4;
- asset 5.

V1 remains one asset against one asset.

# PART II — LOCKING MODEL

## 56. Lock mechanism taxonomy

Every settlement-enabled asset must reference exactly one reviewed lock-protocol family for that
trade.

Possible families:

- LOCK_UTXO_HTLC;
- LOCK_UTXO_SCRIPT;
- LOCK_UTXO_COVENANT;
- LOCK_ADAPTOR_SIGNATURE;
- LOCK_SMART_CONTRACT_ESCROW;
- LOCK_NATIVE_ESCROW;
- LOCK_PROGRAM_ESCROW;
- LOCK_TOKEN_ACCOUNT;
- LOCK_MULTISIG_PROTOCOL;
- LOCK_CHANNEL;
- LOCK_CHAIN_SPECIFIC;
- LOCK_NONE.

Multisig alone is not proof of atomic or safe settlement.

## 57. Lock capability descriptor

Conceptual fields:

- mechanism;
- protocol_family;
- protocol_version;
- cryptographically_enforced;
- counterparty_cannot_unilaterally_spend_after_lock;
- redeem_supported;
- refund_supported;
- recovery_supported;
- timeout_type;
- timeout_policy_id;
- observation_policy_id;
- fee_policy_id;
- confirmation_policy_id;
- wallet_requirements;
- signing_requirements;
- known_limitations;
- reviewed;
- audited;
- mainnet_allowed.

## 58. Absolute lock invariant

Never display FUNDS LOCKED unless chain state proves the asset is actually committed under the
settlement protocol.

The following are NOT locks:

- frontend status;
- database reservation;
- observed wallet balance;
- signed intent;
- chat message;
- API flag.

## 59. Generic lock lifecycle

- UNLOCKED;
- PREPARING;
- LOCK_TX_SIGNED;
- LOCK_BROADCAST;
- LOCK_SEEN;
- LOCK_CONFIRMED;
- LOCK_FINAL_ENOUGH_FOR_POLICY;
- REDEEM_AVAILABLE;
- REFUND_WAIT;
- REFUND_AVAILABLE;
- REDEEMED;
- REFUNDED;
- REORGED;
- RECOVERY_REQUIRED.

Chain-specific adapters can refine this lifecycle but cannot remove recovery-critical states.

## 60. Timeout safety

Timeouts must account for:

- chain liveness/block times;
- confirmation requirement;
- reorg margin;
- fee margin;
- wallet offline margin;
- network latency;
- counterparty response;
- operational recovery margin.

No universal timeout for all chains.

# PART III — ELIGIBILITY LEVELS

## 61. Four independent questions

For every asset:

1. Can it be represented?
2. Can it be listed?
3. Can ownership/transferability be validated?
4. Can it be securely locked, redeemed and refunded by a reviewed protocol?

Never reduce this to one boolean called supported.

## 62. Capability maturity

L0 — KNOWN
Registry identity exists.

L1 — MARKETPLACE
Can be listed.

L2 — VALIDATED_TRANSFER
Ownership/transferability can be checked.

L3 — TESTNET_LOCK
Lock/redeem/refund validated in controlled environment.

L4 — REVIEWED_SETTLEMENT
Protocol passed required independent review.

L5 — MAINNET_CANARY
Strict caps and limited pairs.

L6 — PRODUCTION_SECURE
Approved for production within configured limits.

# PART IV — COMMERCIAL OPERATING MODES

## 63. Invariant across all modes

Cryptographic safety does not change by jurisdiction.

All modes preserve:

- non-custodial design;
- no server private keys/seeds;
- signed immutable terms;
- real locking;
- refund;
- recovery;
- replay protection;
- idempotency;
- chain-risk validation;
- GPUbnb Core isolation.

Policy may prevent a new trade.

Policy may not weaken existing fund-safety guarantees.

## 64. Mode Conformité Europe

Commercial label:

Mode Conformité Europe

Technical state:

CONFORMITE

Possible configurable modules:

- identity;
- KYC;
- AML;
- sanctions;
- Travel Rule workflow where applicable;
- jurisdiction controls;
- asset eligibility;
- transaction limits;
- risk scoring;
- audit;
- reporting;
- retention;
- regulatory workflows.

Law must not be permanently hardcoded into settlement cryptography.

The policy engine must be versioned because legal requirements and supervisory guidance evolve.

## 65. Mode Souverain

Commercial label:

Mode Souverain

Purpose:

- self-hosted;
- operator-controlled;
- configurable for non-EU and other deployment environments.

Operator may configure:

- KYC required or not according to applicable obligations/policy;
- identity provider;
- AML modules;
- sanctions modules;
- transaction limits;
- assets;
- networks;
- RPC/nodes;
- reporting;
- privacy/retention;
- settlement limits.

Important:

Mode Souverain does NOT mean:
- no law;
- no KYC guaranteed;
- illegal mode;
- automatically unregulated.

The operator remains responsible for applicable law in its jurisdiction.

## 66. Jurisdiction policy profiles

Policy is separate from settlement cryptography.

Conceptual JurisdictionProfile:

- profile_id;
- version;
- effective_from;
- jurisdiction_tags;
- identity_policy;
- kyc_policy;
- aml_policy;
- sanctions_policy;
- travel_rule_policy;
- asset_policy;
- limits_policy;
- reporting_policy;
- retention_policy;
- legal_review_reference.

Potential commercial profile names:

- EU_ENTERPRISE;
- EU_RESTRICTED;
- SELF_HOSTED_DEFAULT;
- OPERATOR_CUSTOM.

These are configuration bundles, never legal guarantees.

## 67. Operator responsibility boundary

GPUbnb software may provide:

- secure technical controls;
- configurable policy;
- audit evidence;
- policy templates;
- documentation.

It must not claim that selecting one mode automatically makes an operator compliant, or that
selecting Sovereign mode removes applicable law.

## 68. Pre-trade policy decision

Before any new trade combine:

- asset registry;
- technical settlement capability;
- chain-risk state;
- operator policy;
- jurisdiction profile;
- user eligibility;
- trade limits.

Decision:

- ALLOW;
- DENY;
- REVIEW;
- MARKETPLACE_ONLY.

Already-existing refund/recovery rights must not be removed by a later policy decision when the
protocol permits safe recovery.

## 69. Mode switch

Only authorized administrators may switch modes.

Transition must preserve:

- mode epoch fencing;
- new offers off;
- new trades off;
- existing settlement safe;
- redeem on;
- refund on;
- recovery on.

# PART V — REGISTRY

## 70. Suggested Asset record

Fields:

- asset_id;
- canonical_name;
- symbol;
- aliases;
- asset_class;
- asset_subclass;
- chain_id;
- network_id;
- protocol_family;
- native;
- contract;
- asset_identifier;
- token_id;
- decimals;
- amount_model;
- issuer;
- issuer_controlled;
- transferable;
- transfer_restrictions;
- ownership_proof_supported;
- wallet_support;
- marketplace_enabled;
- new_offers_enabled;
- new_trades_enabled;
- lock_supported;
- lock_capability_id;
- settlement_enabled;
- redeem_enabled;
- refund_enabled;
- recovery_enabled;
- support_status;
- risk_level;
- confirmation_policy_id;
- fee_policy_id;
- timeout_policy_id;
- policy_tags;
- first_seen;
- last_validated;
- registry_version.

## 71. Dynamic risk record

States:

- NORMAL;
- WATCH;
- RESTRICTED;
- QUARANTINE.

Each risk state can separately control:

- new_offers_allowed;
- new_trades_allowed;
- settlement_allowed;
- redeem_allowed;
- refund_allowed;
- recovery_allowed.

Invariant:

Incident response may stop NEW exposure without destroying EXISTING recovery rights.

# PART VI — PRE-TRADE REVALIDATION

## 72. Universal checks

Before settlement:

- canonical asset exists;
- correct chain;
- correct network;
- correct contract/asset ID;
- amount valid;
- current owner;
- available balance;
- transferable now;
- not already committed;
- support status valid;
- risk state valid;
- policy allows;
- settlement protocol enabled;
- wallet implementation supported.

## 73. Contract-token checks

When relevant:

- implementation identity;
- proxy target;
- admin/owner;
- pause;
- blacklist/freeze;
- transfer fee;
- rebase;
- hooks;
- delegate;
- mint/burn authority;
- transfer restrictions.

## 74. NFT checks

- collection/contract;
- token ID;
- owner;
- approval/operator;
- frozen/delegated state;
- transferability;
- standard/program;
- malicious metadata isolation.

## 75. Chain health checks

- chain reachable;
- independent evidence sufficient;
- height/tip consistent;
- reorg condition acceptable;
- fees acceptable;
- relay/mempool usable;
- no active quarantine;
- protocol assumptions still true.

# PART VII — V1 AND FUTURE

## 76. V1 user scope

V1 should expose only:

one transferable asset
against
one transferable asset.

With:

- whole fills;
- explicit network;
- explicit asset identity;
- small reviewed chain set;
- strict settlement limits.

## 77. Settlement family priority

1. UTXO:
   BTC, DOGE, LTC, BCH.

2. Then:
   XMR research and ZEC transparent.

3. EVM:
   ETH, ETC, BNB, AVAX, CFX eSpace.

4. Then:
   SOL, XRP.

5. Additional mining/GPU ecosystems only after capability review.

The registry can contain far more assets than the secure settlement engine.

## 78. Future bundle support

Future possibilities:

- fungible + fungible bundles;
- NFT bundles;
- fungible + NFT;
- multi-chain portfolio bundles.

Requires separate atomicity/recovery specification.

# PART VIII — MANDATORY NEW-ASSET SECURITY REVIEW

## 79. Onboarding checklist

For every asset/network ask:

1. What uniquely identifies it?
2. Who can mint?
3. Who can burn?
4. Who can pause?
5. Who can freeze?
6. Who can blacklist?
7. Can logic upgrade?
8. Can balance change without transfer?
9. Can transfer invoke external code?
10. Is there a transfer fee?
11. Can ownership be proven?
12. Can transferability be simulated?
13. Can funds be cryptographically locked?
14. Can the counterparty bypass that lock?
15. How is redeem performed?
16. How is refund performed?
17. What happens if the chain halts?
18. What happens under reorg?
19. What happens under fee spike?
20. What if the primary RPC lies?
21. What if the wallet closes?
22. What if GPUbnb disappears?
23. What if a worker crashes after broadcast?
24. Can recovery be performed independently?
25. Is the asset eligible under deployment policy?
26. Are dependencies/licenses commercially acceptable?
27. Has the lock protocol passed its required security gate?

If any fund-safety answer is unknown:

automatic_settlement_supported = false.

# PART IX — COMMERCIAL PRODUCT PRINCIPLE

## 80. Sell a secure framework, not unsafe promises

Commercial strength should come from:

- broad asset representation;
- modular adapters;
- explicit risk states;
- jurisdiction policy profiles;
- real non-custodial settlement where proven;
- transparent support levels;
- self-hosted deployment options;
- strong recovery.

The product may know thousands of assets while automatically settling only the subset that passed
security gates.

That is a security feature.

## 81. Non-authorization

Registry presence is not marketplace approval.
Marketplace approval is not settlement approval.
Settlement approval is not SECURE status.

No asset is authorized for Mainnet merely by appearing in this taxonomy.
