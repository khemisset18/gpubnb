# Bitcoin Timeout and Confirmation Policy V1

Status: G6 DERIVATION FOUNDATION / REGTEST ONLY / NO PRODUCTION DEFAULTS / NO MAINNET AUTHORIZATION

## 1. Security objective

The refund timeout is not a UX timer.

It is a consensus-enforced recovery boundary that must leave enough block-height budget for:
- funding confirmations;
- counterparty actions;
- watcher uncertainty;
- reorg handling;
- fee-bump/rebroadcast attempts;
- standalone recovery execution;
- operator/human fallback;
- an explicit additional safety margin.

V1 uses block-height CLTV only.

## 2. Consensus facts

BIP65 CHECKLOCKTIMEVERIFY requires:
- lock type consistency between the script argument and transaction nLockTime;
- script lock value <= transaction nLockTime;
- the spending input sequence must not be final.

The current V1 refund uses:
- height-based nLockTime;
- nSequence = 0xfffffffd;
- SIGHASH_ALL.

Bitcoin Core's consensus parameters target roughly 600 seconds between blocks, but block arrival is stochastic. The implementation MUST NOT convert a block budget into a guaranteed wall-clock deadline.

## 3. No hidden production defaults

The timeout derivation module has no default risk budget.

Every component is mandatory:
- maxFundingBroadcastDelayBlocks;
- fundingConfirmations;
- counterpartyActionBudgetBlocks;
- watcherUncertaintyBudgetBlocks;
- reorgSafetyBlocks;
- feeBumpBudgetBlocks;
- recoveryExecutionBlocks;
- operatorFallbackBlocks;
- additionalSafetyBlocks.

Current test values are regtest fixtures only.

They MUST NOT be copied into a production profile without separate review.

## 4. Derivation

Let:

`operationalSafetyBlocks`

be the exact integer sum of all operational components except the pre-broadcast freshness allowance.

Then:

`maxFundingBroadcastHeight = anchorHeight + maxFundingBroadcastDelayBlocks`

`refundWindowBlocks = maxFundingBroadcastDelayBlocks + operationalSafetyBlocks`

`refundLockHeight = anchorHeight + refundWindowBlocks`

The pre-broadcast allowance is added outside the operational budget so that, even if funding is broadcast at the final allowed height, the full signed operational safety budget remains.

## 5. Stale-term protection

Before funding broadcast, the implementation MUST obtain current chain height from validated chain evidence and enforce:

`currentHeight <= maxFundingBroadcastHeight`

and:

`refundLockHeight - currentHeight >= operationalSafetyBlocks`

If either condition fails:
- do not broadcast;
- do not silently extend or mutate the script;
- re-derive the timeout;
- rebuild the P2WSH output;
- obtain new settlement signatures.

This prevents signed settlement terms from aging into an unsafe recovery window before funding.

## 6. Signed-term binding

The Bitcoin settlement digest now binds:
- the complete timeout policy;
- timeout policy hash;
- timeout anchor height;
- maximum funding broadcast height;
- operational safety block count;
- total refund window;
- derived refund lock height;
- required confirmation count.

Changing the allocation of risk blocks changes the signed digest even when the final total window is unchanged.

## 7. Wall-clock interpretation

A target block spacing may be shown as an informational estimate only.

It MUST NOT:
- authorize broadcast;
- authorize refund;
- replace observed chain height;
- be presented as a guaranteed number of minutes/hours.

Consensus validity remains height-based.

## 8. Cross-chain caution

This policy is only the Bitcoin-side derivation primitive.

A production atomic-swap pair also needs reviewed asymmetric timeout ordering across both chain families.

The longer-timeout side must leave enough room for:
- the shorter-timeout chain's confirmation policy;
- secret observation and validation;
- fee/reorg/recovery uncertainty on both chains.

No universal cross-chain timeout constant is defined here.

## 9. Production STOP-SHIP

Mainnet remains blocked until:
- a production Bitcoin risk profile is separately reviewed;
- counter-chain-specific timeout ordering is defined;
- confirmation policy is amount/risk aware;
- watcher freshness requirements are defined;
- fee-bump/recovery budgets are tested under the production node policy profile;
- external audit reviews the timeout model.

The code added here proves deterministic derivation and stale-term rejection. It does not prove that any specific production block budget is sufficient.
