# GPU rental final gap analysis — PR #36

Date: 2026-07-30. Branch intended: `fix/complete-netlify-host-flow`.

> Scope: GPU rental only. Cryptocurrency mining is not part of the user-facing MVP and must remain disabled, inaccessible, and unable to start a real process. Technical mining remnants are future-only and should return `MINING_FEATURE_NOT_AVAILABLE` if activation is attempted.

## Status categories

- **fonctionnelle**: implemented with real persisted state and tests or direct code evidence.
- **partiellement fonctionnelle**: usable foundation exists but at least one required end-to-end condition is missing.
- **simulée**: behavior exists as a mock, placeholder, or local-only proof without real production integration.
- **absente**: no meaningful implementation found in the repository.
- **bloquante**: prevents safe real rental completion.
- **prête pour test réel**: ready for a controlled real NVIDIA GPU validation, but not production.
- **prête pour production**: production-ready with automated and real validation evidence. None of the audited areas qualify yet.

## Executive conclusion

GPUbnb has meaningful foundations for authentication, owner profiles, signed host heartbeats, multi-GPU inventory, booking/payment primitives, and host desktop orchestration. The rental flow is **not production-ready** because a real Windows NVIDIA end-to-end run, installer artifact verification, real controlled workload execution, cleanup proof, and settlement proof are still missing. The safest current classification for the whole marketplace is **partiellement fonctionnelle / bloquante**.

## Capability matrix

| Area | Category | Evidence | Gap / required action |
| --- | --- | --- | --- |
| Authentication | partiellement fonctionnelle | Wallet and Supabase auth routes issue sessions and expose `/auth/me`. | Needs full E2E account creation tests with owner and renter roles in the deployed preview. |
| Profiles and roles | fonctionnelle | `/profile` validates `canRent` / `canHost` and persists profile completion. | Add UI regression for role switching and empty-role rejection. |
| GPUbnb Host desktop UI | partiellement fonctionnelle | Tauri host status, pairing configuration, readiness and emergency stop commands exist. | Windows installer must be validated on a clean NVIDIA PC; no production claim until artifact SHA-256 and bundled agent checks pass. |
| Local agent | partiellement fonctionnelle | Python agent modules include signing, telemetry and Windows service support. | Need packaged install without Python/PATH/terminal assumptions verified on Windows. |
| Machine linking | partiellement fonctionnelle | Link codes are Redis-backed and consumed with `getdel`. | Polling must use explicit proof of code consumption and heartbeat arrival; collision and same-host relink tests should be expanded. |
| Signed heartbeats | fonctionnelle | Agent challenge and heartbeat routes verify request signatures, replay challenge and counters. | Need deployed API integration test under Render/Netlify preview. |
| Multi-GPU detection | partiellement fonctionnelle | Accelerator tables and public/owner accelerator views exist. | Listing and booking APIs still primarily use machine/listing level selection; renter must select exact accelerator for all paths. |
| Diagnostics | partiellement fonctionnelle | Host native diagnostic scaffolding and GPU diagnostic container source exist. | Must pin the official CUDA image by digest, verify container cleanup, and expose all required stable error codes. |
| Machine state | fonctionnelle | A centralized backend `computeMachineState` service now produces state, next action, blocking reason, evidence time and capability gates. | Wire all frontend pages to consume this API state instead of local recalculation. |
| My machines page | partiellement fonctionnelle | `/machines/mine` returns owner machines and centralized state. | UI still needs complete per-GPU diagnostics, listing, active booking/session, logs, unlink/offline and emergency actions. |
| Listing publication | partiellement fonctionnelle | Listings require owner machine, moderation clear, price, heartbeat/CUDA freshness to activate. | Must require exact GPU selection, verified diagnostic, availability rules and workload limits before activation. |
| Search and filters | partiellement fonctionnelle | Active listings are filtered by online, moderation clear, CUDA probe and fresh heartbeat. | Add model/vendor/VRAM/price/availability/duration/owner/location filters and non-reservable states. |
| Reservations | partiellement fonctionnelle | Booking creation is idempotent and checks overlapping bookings for a listing. | Required state model differs from schema names; concurrency must lock exact GPU periods, not just listings. |
| Allocations | partiellement fonctionnelle | Machine and accelerator allocation schema/services exist. | Allocation must become the mandatory source of truth for every session start and cleanup release. |
| Workspaces | partiellement fonctionnelle | Workspace session/job preparation routes exist. | Controlled CUDA benchmark needs real execution and artifact retrieval proof. |
| Sessions | partiellement fonctionnelle | Job completion updates workspace sessions. | Need explicit authorized session start/end lifecycle tied to funded booking and allocation. |
| Metrics | partiellement fonctionnelle | Heartbeat telemetry records GPU utilization, temperature, memory and power. | Need renter-facing session metrics linked to active workload and booking. |
| Devnet payments | partiellement fonctionnelle | Escrow transaction building and deposit confirmation exist behind program configuration. | Need Devnet workflow proof, refund/expiration/double-settlement tests and deployed program evidence. |
| Settlement | partiellement fonctionnelle | Settlement calculation and preview exist. | Settlement must use authorized execution duration only and be proven on Devnet. |
| Security | partiellement fonctionnelle | Helmet, rate limits, request IDs, redacted Fastify logger fields and signed agent requests exist. | Standardize user-facing errors with stable code, safe message, action and request ID across routes. |
| Netlify | partiellement fonctionnelle | Netlify function for host download and config files exist. | Need current preview URL, downloadable release artifact and SHA-256 verification. |
| Render | partiellement fonctionnelle | Render config exists. | Need current API deployment health and readiness proof. |
| Releases | partiellement fonctionnelle | SHA manifests and host release docs exist. | Windows installer must include desktop, agent, service, dependencies and uninstaller. |
| Tests | partiellement fonctionnelle | API, agent and host tests exist; centralized machine state tests added. | Add required integration, concurrency and Playwright E2E coverage; run Windows NVIDIA manual test. |

## Mining separation audit

Search terms reviewed: `mining`, `miner`, `crypto`, `idle mining`, `ravencoin`. Mining remains present in technical architecture and host internals, but it must not be advertised in primary UI or used by rental tests. The desktop activation command now fail-closes with `MINING_FEATURE_NOT_AVAILABLE`. Technical documentation should state only: “Fonction prévue après finalisation complète de la location GPU.”

## Blocking gaps before marking PR ready

1. Real Windows NVIDIA E2E validation is not yet documented as passed.
2. Host installer contents and SHA-256 release artifacts are not proven in this environment.
3. Exact accelerator selection is not mandatory throughout listing, booking, allocation and session start.
4. Controlled CUDA workload execution and cleanup proof are not fully wired to renter session completion.
5. Devnet funding and settlement need current on-chain workflow evidence.
6. Frontend must consume centralized machine state everywhere instead of local heuristics.
7. Mining remnants must remain hidden from primary UI and rejected by APIs/commands.

## Recommendation

Keep PR #36 in draft. Continue with GPU rental hardening only, prioritizing exact GPU allocation, controlled workload execution, cleanup verification, Devnet settlement proof, and the Windows NVIDIA checklist.
