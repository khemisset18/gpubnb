# Production-Scale Load Lab v1

## Purpose

This layer turns the distributed correctness lab into a release-qualification contract for measured fleet scale.

It does **not** provision cloud infrastructure and it does **not** claim that one million live sockets have been measured. It defines the immutable plan, evidence schema, promotion gates and claim boundary that an external multi-region lab must satisfy.

## Stack position

```text
#115 Hyperscale model + single-host live qualification
  -> #116 Distributed multi-Gateway correctness lab
    -> Production-Scale Load Lab v1
```

The production-scale planner consumes the exact `LabManifest` produced by #116. It never invents a second machine namespace or a second capacity model.

## Progressive scale contract

The committed ladder is:

```text
10k -> 50k -> 100k -> 250k -> 500k -> 750k -> 1M
```

Every target is strictly increasing. The final target must equal the distributed manifest fleet size. A stage derives an exact prefix of the immutable distributed shard allocation; the last shard may be partial. This allows a 10k gate even when the release manifest uses 25k-connection shards.

Promotion is evidence-driven. Missing evidence for an earlier stage blocks qualification of later stages.

## Release identity

A production plan is bound to:

- Git SHA;
- Gateway image SHA-256 digest;
- injector image SHA-256 digest;
- configuration bundle SHA-256;
- Redis version and topology;
- OS/kernel;
- instance type;
- CPU/RAM/FD/NIC envelope;
- exact region set from the distributed manifest.

Every stage evidence record repeats the release identity. A mismatch is a hard failure rather than a warning.

## Stage evidence

Each measured stage records at least:

- target and measured simultaneous connections;
- sustained duration;
- expected and observed shard counts;
- connection/heartbeat/presence failure rates;
- conservative connection and Redis-presence p99;
- Gateway peak CPU and FD utilization;
- Gateway UDP error delta;
- injector peak CPU and FD utilization;
- injector UDP error delta;
- Redis p99, peak CPU, blocked-client peak and evictions;
- fault evidence;
- immutable evidence-bundle SHA-256.

A stage cannot pass merely because its local runner exited zero. The production qualifier independently evaluates the recorded resource and protocol gates.

## Required release faults

Final release qualification requires successful evidence for:

- single Gateway loss;
- network impairment;
- Redis HA/failover;
- complete loss of every configured region independently;
- multi-hour soak.

Fault evidence fails closed when recovery required manual intervention or duplicate machine ownership was observed.

## One-million claim boundary

`oneMillionMeasured=true` is emitted only when all of the following are true:

1. the final production ladder stage has been reached;
2. all prior stages pass;
3. measured simultaneous live connections are at least 1,000,000;
4. the final target is backed by the million-fleet distributed manifest;
5. all required fault drills pass;
6. all configured regions have an independent region-loss recovery record;
7. the soak duration passes;
8. the evidence bundle digest is valid;
9. no manual recovery or duplicate ownership is present.

A modeled million-fleet plan alone can never set this flag.

## Provider boundary

v1 is intentionally provider-neutral. Cloud accounts, Kubernetes clusters, Terraform stacks, traffic engineering and Redis HA implementation differ by environment and are not hard-coded into the control-plane repository.

The external lab is responsible for deploying the exact release artifacts and returning evidence that conforms to this contract. This separation prevents provider credentials and staging topology from becoming part of product runtime code.

## Qualification review policy

The qualification code is held to the same strict compiler and lint gates as the production Gateway. A pass must come from correcting the implementation, not from adding lint suppressions or weakening workflow flags. CI contract evidence is synthetic proof of the qualifier's acceptance/rejection logic and is never treated as measured WAN capacity.

The final review branch contains only the read-only production qualification workflow. Strict Clippy runs with `-D warnings` across both the qualification library and `gpubnb-prod-labctl`; temporary source-materialization helpers are removed before review and are not part of the release tree.

## Security

- qualification Redis must remain isolated from production hot state;
- production Agent private keys are forbidden;
- shard identity ranges come only from the immutable plan;
- TLS verification and Ed25519 authentication remain enabled;
- no SLO, backpressure or fencing mechanism may be disabled to obtain a pass;
- failed stages are retained as evidence;
- scale promotion stops on the first failed gate.
