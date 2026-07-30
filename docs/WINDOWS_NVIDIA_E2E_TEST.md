# Windows NVIDIA end-to-end validation checklist

Date: 2026-07-30. This checklist is mandatory before claiming the GPU rental path is ready beyond a controlled pilot.

## Test machine prerequisites

- Fresh Windows 11 installation or a clean Windows test profile.
- One or more NVIDIA GPUs physically installed.
- Current NVIDIA driver installed from NVIDIA.
- Docker Desktop installed and running.
- NVIDIA Container Toolkit / NVIDIA runtime available to Docker.
- No manually installed Python, custom PATH entries or copied internal GPUbnb files required by the tester.

## Installer and launch

- [ ] Download GPUbnb Host from the PR #36 preview/release link.
- [ ] Record installer filename, version and SHA-256.
- [ ] Confirm SmartScreen behavior and document any warning text.
- [ ] Install with default options.
- [ ] Confirm desktop UI launches from Start Menu.
- [ ] Confirm background service is installed and running.
- [ ] Reboot Windows.
- [ ] Confirm background service restarts automatically.
- [ ] Confirm logs are present and redact secrets, cookies, tokens, signatures and private keys.

## Owner account and pairing

- [ ] Create owner account.
- [ ] Complete profile.
- [ ] Enable owner role.
- [ ] Request a host pairing code on the site.
- [ ] Enter/consume the code in GPUbnb Host.
- [ ] Confirm the code cannot be reused.
- [ ] Confirm browser-closed/reopened polling still reaches the linked machine state.
- [ ] Confirm a machine already linked to another owner is rejected.

## Heartbeat and inventory

- [ ] Confirm signed heartbeats reach the API.
- [ ] Confirm stale/replayed heartbeat challenge is rejected.
- [ ] Confirm every NVIDIA GPU appears as a separate resource.
- [ ] For each GPU, record UUID, index, model, VRAM, driver, CUDA, temperature, utilization and last detection time.

## Docker and diagnostic

- [ ] Confirm Docker daemon is reachable.
- [ ] Confirm NVIDIA runtime is available.
- [ ] Run GPU diagnostic.
- [ ] Verify `nvidia-smi` result.
- [ ] Verify minimal GPU container starts from a digest-pinned official CUDA image.
- [ ] Verify workload result JSON is valid.
- [ ] Verify container stops.
- [ ] Verify container is removed.
- [ ] Verify no diagnostic is marked successful unless cleanup is confirmed.
- [ ] Capture any error code: `NVIDIA_SMI_NOT_FOUND`, `GPU_NOT_FOUND`, `DRIVER_NOT_AVAILABLE`, `DOCKER_NOT_INSTALLED`, `DOCKER_DAEMON_UNREACHABLE`, `NVIDIA_RUNTIME_MISSING`, `GPU_CONTAINER_START_FAILED`, `GPU_WORKLOAD_FAILED`, `GPU_RESULT_INVALID`, `CONTAINER_STOP_FAILED`, `CONTAINER_CLEANUP_UNVERIFIED`.

## Publishing

- [ ] On “My machines”, confirm centralized state progresses to ready-to-publish.
- [ ] Select exactly one GPU.
- [ ] Set title, description, hourly price, Devnet currency, availability, min/max duration, preparation delay, cancellation rules and workload limits.
- [ ] Publish the listing.
- [ ] Confirm immutable hardware fields cannot be edited manually.

## Renter booking and workload

- [ ] Create a second renter account.
- [ ] Enable renter role.
- [ ] Search and filter by GPU model, manufacturer, VRAM, price, availability and online/diagnostic status.
- [ ] Open listing and confirm owner, machine and exact GPU selection.
- [ ] Select a rental period.
- [ ] Obtain quote.
- [ ] Create reservation.
- [ ] Fund on Devnet or approved test Devnet simulation.
- [ ] Start authorized controlled GPU workload.
- [ ] Confirm only allocated GPU is used.
- [ ] Confirm no personal folders are mounted.
- [ ] Confirm CPU/RAM/process/time/network limits.
- [ ] Confirm JSON result is retrievable.
- [ ] Confirm metrics are visible to renter.

## Stop, cleanup and settlement

- [ ] End session normally.
- [ ] Confirm workload/container stops.
- [ ] Confirm temporary files are removed.
- [ ] Confirm temporary secrets are revoked.
- [ ] Confirm allocation is released.
- [ ] Confirm GPU returns to available only after cleanup verification.
- [ ] Trigger owner emergency stop during a test session.
- [ ] Confirm listings suspend and new bookings/allocations are blocked.
- [ ] Confirm renter sees clear interrupted status.
- [ ] Confirm settlement is calculated from validated price, reservation and recorded authorized execution duration.
- [ ] Confirm double settlement is rejected.

## Uninstall

- [ ] Uninstall GPUbnb Host from Windows settings.
- [ ] Confirm background service is removed.
- [ ] Confirm scheduled tasks are removed.
- [ ] Confirm no GPUbnb containers remain.
- [ ] Confirm logs/config retention policy is documented.
- [ ] Confirm reinstall preserves or rotates machine identity according to documented policy.

## Result

- Overall result: **not run yet**.
- Tester:
- Machine model:
- GPU model(s):
- Driver version:
- Docker version:
- GPUbnb Host version:
- API deployment URL:
- Netlify preview URL:
- Evidence folder:
