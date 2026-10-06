# Bitcoin Confirmation Policy V1

Status: G6 FOUNDATION / REGTEST ONLY / NO MAINNET DEFAULTS

## Purpose

Bitcoin does not define one universally correct confirmation count for every economic risk.

The policy implemented here makes the decision explicit and signed instead of hiding it in application code.

The required confirmation count is:

`max(amount-band confirmations, risk-class floor)`

Both inputs are mandatory.

## Research basis

Bitcoin documentation describes confirmations as an increasing confidence measure against chain replacement. Zero-confirmation acceptance requires separate risk analysis.

Bitcoin developer documentation notes that six confirmations are commonly used for high-value or higher-risk transfers, while also explicitly describing that number as somewhat arbitrary.

Therefore gpu.k.p2p does not encode a universal Mainnet constant.

## Amount bands

A policy defines an ordered list of amount bands.

Requirements:
- values are integer satoshis;
- maxima must be strictly increasing;
- confirmation counts may only stay equal or increase as amount increases;
- a final catch-all band is mandatory;
- no hidden default band exists.

## Risk classes

V1 defines four policy labels:
- LOW
- STANDARD
- HIGH
- EXTREME

The policy must explicitly provide a confirmation floor for every class.

Floors must be monotonic:

`LOW <= STANDARD <= HIGH <= EXTREME`

These names are policy inputs, not claims about objective real-world safety.

## Signed-term binding

Bitcoin settlement terms bind:
- the complete confirmation policy;
- its policy hash;
- the selected risk class;
- selected amount-band index;
- amount-band confirmation requirement;
- risk-floor confirmation requirement;
- final required confirmation count.

The timeout policy must use the exact same final confirmation count.

If the amount, risk class, confirmation policy, or timeout funding-confirmation count changes, new settlement terms must be derived and signed.

## Fail-closed rules

Reject:
- missing bands;
- missing risk floors;
- decreasing amount thresholds;
- decreasing confirmation requirements;
- missing catch-all;
- unknown risk class;
- non-integer satoshi amounts;
- timeout/confirmation mismatch;
- settlement required-confirmation mismatch.

## Production restriction

The current policy module is regtest-only.

Values used in unit tests are fixtures and MUST NOT be copied into Mainnet configuration.

A production policy still requires:
- reviewed economic-risk thresholds;
- amount-aware limits;
- operational reorg assumptions;
- current chain monitoring;
- external security review;
- explicit release approval.

No confirmation count makes a Bitcoin transaction mathematically irreversible.
