# GPU workload sandbox

`sandbox/run-workload.sh` is a hardened baseline, not a security certification. It requires digest-pinned images, no network, read-only root filesystem, no Linux capabilities, no-new-privileges, resource limits, non-root execution and isolated job directories.

Before public Mainnet:
- place workers on dedicated hosts or microVMs;
- do not expose the Docker socket to the API or workload;
- scan and sign allowed images;
- encrypt and erase job storage;
- enforce egress through an explicit proxy when network is needed;
- test GPU reset and cross-tenant memory leakage;
- commission an independent container/microVM escape pentest.
