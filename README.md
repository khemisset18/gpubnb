# GPUbnb

GPUbnb is a **Devnet-stage GPU rental marketplace** combining a static web
client, a Fastify API, PostgreSQL/Prisma, Redis-backed sessions, a signed GPU
host agent and an Anchor escrow program. It is not approved for public Solana
Mainnet or untrusted production workloads.

## Status and non-negotiable invariants

- Platform commission: **500 basis points (5%)**, computed in integer lamports.
- Escrow refund expiry: **booking end + 3,600 seconds**.
- Public Mainnet: **NO-GO** until `scripts/mainnet-gate.sh` passes using genuine
  external evidence. Never bypass this gate.
- The sandbox is defense in depth, not a substitute for VM isolation or an
  independent host-security assessment.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/api` | Fastify API, Prisma schema/migrations and API tests |
| `apps/web` | canonical static frontend deployed by Netlify and served by the API |
| `programs/gpu_escrow` | canonical Anchor escrow program |
| `agent` | signed NVIDIA telemetry agent |
| `sandbox` | constrained Docker workload launcher and cleanup |
| `infra` | local PostgreSQL and Redis Compose stack |
| `scripts` | local verification, Program ID and release-gate tooling |
| `docs` | architecture, operations, migration and security procedures |
| `audit` | evidence placeholders; never fabricate attestations |

Legacy root copies of API, frontend, agent and deployment files were removed.
The paths in this table are the only canonical implementations.

## Prerequisites

- Node.js 22 and npm 10+
- PostgreSQL 16 and Redis 7 (or Docker Compose)
- Rust/Cargo and the Anchor/Solana toolchain for contract development
- Python 3 with `agent/requirements.txt` for a GPU provider host
- Docker Engine with NVIDIA Container Toolkit for sandbox execution

## Local configuration

```bash
cp .env.example .env
# Replace every placeholder. Never commit .env.
docker compose -f infra/docker-compose.yml up -d
```

`.env.example` documents runtime, Supabase, Redis, Solana and sandbox values.
Secrets must come from a secret manager in production. Never store a Solana
keypair, seed phrase, Supabase service-role key or Google client secret in this
repository. `DIRECT_URL`, Google variables and the Supabase service-role key are
operator-facing placeholders and are not currently consumed by the API.

## API and database

```bash
cd apps/api
npm ci
npx prisma format
npx prisma validate
npx prisma generate
npx prisma migrate deploy
npm run typecheck
npm test
npm run build
npm start
```

Use `prisma migrate deploy`, never `prisma migrate reset`, against persistent
data. Before any production migration follow
[`docs/AUTH_DATA_MIGRATION.md`](docs/AUTH_DATA_MIGRATION.md): back up, run the
collision preflight, restore into staging, migrate and verify row counts and
constraints. Application rollback does not mean destructive database rollback;
retain the additive schema until all readers have migrated.

Health endpoints are `/health` (process/configuration) and `/ready`
(PostgreSQL/Redis dependencies).

## Authentication

The API models a business user separately from external `AuthIdentity` records
and Solana `UserWallet` records. Current code includes email/password signup and
login through Supabase, Google OAuth through Supabase PKCE, Phantom
challenge/signature verification, password recovery, versioned API sessions,
logout-all and CSRF tokens. An authenticated email/Google account can link a
signed Phantom wallet without creating a second business account; wallet
ownership remains globally unique. Authenticated profile read/update endpoints
cover the public pseudonym and core privacy/profile fields.

These flows are **not operational merely by cloning the repository**. Configure
Supabase email confirmation/SMTP and allowed redirects, the Google provider,
and the exact production domain. End-to-end tests against that external setup
remain required. Username/password login is not advertised unless a tested
server-side identifier resolution flow is added.

See [`docs/PRODUCTION_CONFIGURATION.md`](docs/PRODUCTION_CONFIGURATION.md) and
[`docs/AUTH_DATA_MIGRATION.md`](docs/AUTH_DATA_MIGRATION.md).

## Frontend

`apps/web` is framework-free HTML/CSS/JavaScript. Serve it through the API or a
local static server; do not open pages using `file://` for OAuth callbacks.
Populate the public Supabase values in the documented frontend configuration,
never a service-role credential.

```bash
cp apps/web/auth-config.example.js apps/web/auth-config.js
# Set only the public project URL, anon key and exact callback URL.
```

`apps/web/auth-config.js` is intentionally ignored because it is
environment-specific. The API serves this path dynamically from its public
Supabase environment values. A standalone Netlify deployment must generate the
file from the example before publishing `apps/web`.

```bash
node --check apps/web/auth.js
node --check apps/web/app.js
node --check apps/web/publish.js
node --test test/frontend.test.mjs
```

The requests and proposals screens explicitly contain local demo storage; they
are not production-persistent marketplace features. GPU publishing itself uses
the authenticated API and PostgreSQL.

## Solana Devnet

`Anchor.toml` and the program source must agree on the Program ID. After an ABI
change, regenerate and review the IDL, deploy a fresh build to Devnet, and test
against that exact binary. Run:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
bash scripts/verify-program-id.sh
bash scripts/mainnet-gate.sh   # expected to fail until every external gate exists
```

Consult `docs/MAINNET_GO_LIVE.md`, `docs/MULTISIG_SETUP.md` and
`docs/CHANGES_MAINNET_HARDENING.md` before any release decision.

## GPU agent and sandbox

Install agent dependencies with `python3 -m pip install -r agent/requirements.txt`.
Provision the agent signing key out-of-band with restrictive host permissions.
The launcher requires digest-pinned images, a non-root service account and an
NVIDIA-enabled Docker daemon:

```bash
BOOKING_ID=example123 GPU_DEVICE=0 \
  sandbox/run-workload.sh registry.example/workload@sha256:<64-hex-digest>
```

Implemented controls include no network, read-only root filesystem, dropped
capabilities, no-new-privileges, non-root container user, PID/CPU/RAM/time
limits, controlled bind mounts, path canonicalisation and symlink rejection.
Production isolation still requires a dedicated host/VM boundary, image
signature and vulnerability policy, IOMMU/MIG validation, and monitoring such
as Falco/eBPF where appropriate. See `docs/SANDBOX_SECURITY.md`.

## Docker and Render

```bash
docker build -f apps/api/Dockerfile -t gpubnb-api:local .
docker run --rm --env-file .env -p 8787:8787 gpubnb-api:local
```

The image uses a multi-stage build, Prisma generation, production dependency
pruning, a non-root runtime user and a healthcheck. `render.yaml` points to the
canonical Dockerfile and requires PostgreSQL/Redis plus all production secrets.
Verify migrations, startup, `/ready`, shutdown signals and rollback on staging.

## Verification

```bash
bash scripts/verify.sh
bash -n sandbox/*.sh scripts/*.sh
shellcheck sandbox/*.sh scripts/*.sh        # when installed
python3 -m py_compile agent/agent.py
git diff --check
```

CI additionally performs Prisma checks, API typecheck/tests/build, Cargo fmt,
test and Clippy, Docker build, Gitleaks, ShellCheck and Trivy scanning. A local
pass is not evidence that GitHub Actions is green; inspect every required job.

## Security, incidents and known limits

Report vulnerabilities using [`docs/SECURITY.md`](docs/SECURITY.md), without a
public issue containing exploit details. Incident handling is documented in
[`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md).

Known incomplete or externally dependent areas include production OAuth/SMTP,
real infrastructure E2E, external Anchor and sandbox audits, durable backend
storage for demo-only frontend workflows, image-signature enforcement,
production monitoring, legal review, protected key custody and Mainnet rollout.

## Configuration manuelle après import sur GitHub

1. **GitHub:** create repository/environment secrets required by deployment;
   enable Dependabot/security alerts; restrict Actions permissions; require all
   CI jobs and approving reviews on `main`; disallow force-push and deletion.
2. **Supabase:** set Site URL and exact redirects; enable email confirmation,
   production SMTP, secure templates, password policy and CAPTCHA; configure
   public anon and server-only credentials; review RLS if browser access exists.
3. **Google Cloud:** create the OAuth client and consent screen; enter exact web
   origins and the Supabase callback URI; store its secret only in Supabase.
4. **Render:** provision PostgreSQL and TLS Redis; configure environment values,
   custom domains, healthcheck and migration/release procedure; test rollback.
5. **Solana:** choose Devnet RPC and Program ID, regenerate the IDL after ABI
   changes, protect deploy authority, and keep Mainnet disabled pending multisig
   and independent audit.

Exact settings, placeholders and ownership are in
[`docs/PRODUCTION_CONFIGURATION.md`](docs/PRODUCTION_CONFIGURATION.md). The
proposed repository metadata, first PR text, required checks, branch protection
and post-push checklist are in [`docs/GITHUB_PUBLICATION.md`](docs/GITHUB_PUBLICATION.md).

## License

No public-use license is currently granted; see [`LICENSE`](LICENSE). The owner
must approve an open-source or commercial license before public distribution or
accepting outside contributions.
