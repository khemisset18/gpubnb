"""Immutable official runtime images shipped with GPUbnb Host.

Pinned digests make a fresh or upgraded Host immediately usable without asking the
owner to find, paste, or trust a mutable Docker tag.
"""

DEFAULT_DEVELOPER_IMAGE = (
    "ghcr.io/khemisset18/gpubnb-developer@sha256:"
    "bd99f5f169a83adc649e73c3b52d1685548b209eb071ad251baa2f87e1fa8bc4"
)
DEFAULT_COMPUTE_IMAGE = (
    "ghcr.io/khemisset18/gpu-proof-workspace@sha256:"
    "8ac92e956dd7f6a0c55ef6f24165165d16d519e995e0847fd6f42a72ce1ea662"
)
# Official upstream Jupyter Docker Stacks image (jupyter/docker-stacks project,
# published at quay.io/jupyter since the project's 2023 migration off Docker Hub).
# Digest is the multi-arch manifest-list digest for tag 2026-08-31, resolved via
# the quay.io API (https://quay.io/api/v1/repository/jupyter/datascience-notebook/tag/?specificTag=2026-08-31)
# so Docker picks the right arch automatically. No GPUbnb-built image exists for
# Data Workspace - unlike Developer, the data-science toolchain here needs no
# OS-level customization, so the trusted official image is used directly.
DEFAULT_DATA_IMAGE = (
    "quay.io/jupyter/datascience-notebook@sha256:"
    "20cbe280416d58b27e5fa1353a6ab849853103eca05f9e310608370f266c3dc4"
)
# Same publisher/project as DEFAULT_DATA_IMAGE (jupyter/docker-stacks), a
# variant that additionally bundles CUDA + PyTorch. Digest is the multi-arch
# manifest-list digest for tag cuda12-pytorch-2.11.0, resolved via the
# quay.io API (https://quay.io/api/v1/repository/jupyter/pytorch-notebook/tag/?specificTag=cuda12-pytorch-2.11.0).
# Same jovyan/uid-1000/gid-100/tini+start-notebook.py conventions as Data's
# image, so workspace_gateway.py's launch args are shared between the two -
# only GPU passthrough differs. No GPUbnb-built image exists for this either.
DEFAULT_AI_IMAGE = (
    "quay.io/jupyter/pytorch-notebook@sha256:"
    "de7e7da7ba3e66cd2720ff9e72c93c43d24cb83478a032862acb7520fa8b2200"
)
# Same exact image/digest as DEFAULT_DATA_IMAGE, deliberately kept as its own
# named constant (not a shared reference) so Video's image can be reconfigured
# independently of Data's later. Confirmed live: this image's ffmpeg build
# already includes real hardware h264_nvenc/hevc_nvenc/av1_nvenc encoders
# (Debian's ffmpeg package, not something GPUbnb added) - a real encode test
# (--gpus=device=0, testsrc -> h264_nvenc) produced a genuine 444KB mp4 at
# 32fps, not a software-encoder fallback. No DaVinci Resolve or Blender GUI
# is included (no official free-redistributable Linux container exists for
# DaVinci; Blender's GUI needs a desktop-streaming runtime this doesn't have
# - see workspace-manifests.ts's technologies list, updated to not overclaim).
DEFAULT_VIDEO_IMAGE = (
    "quay.io/jupyter/datascience-notebook@sha256:"
    "20cbe280416d58b27e5fa1353a6ab849853103eca05f9e310608370f266c3dc4"
)
# Same exact image/digest again, own named constant for the same reason as
# Video. Confirmed live: its ffmpeg build has real audio DSP filters
# (loudnorm EBU R128 normalization, acompressor, equalizer/superequalizer/
# firequalizer) - a real loudnorm pass on a real sine-wave test signal ran
# successfully. No GPU needed for audio DSP (unlike Video's NVENC), matching
# Data's existing no-GPU precedent on this GPU-rental platform. No Ardour or
# Audacity GUI is included (both need the same broken-on-this-host desktop-
# streaming path as Creator's Blender) - see workspace-manifests.ts.
DEFAULT_AUDIO_IMAGE = (
    "quay.io/jupyter/datascience-notebook@sha256:"
    "20cbe280416d58b27e5fa1353a6ab849853103eca05f9e310608370f266c3dc4"
)
# Same exact image/digest again. API Workspace does not run JupyterLab or any
# notebook GUI at all - workspace_gateway.py launches this image with
# DOCKER_STACKS_JUPYTER_CMD=server and every UI extension (jupyterlab,
# notebook, nbclassic, jupyterlab_git, nbdime) explicitly disabled via
# --ServerApp.jpserver_extensions, leaving only jupyter_server's own
# documented REST + WebSocket kernel API (confirmed live: /lab and /tree both
# 404, /api/kernels and a real kernel execute round-trip both work). This is a
# genuinely different product surface from Data/Video/Audio, not a relabeled
# notebook - a renter calls it from their own scripts/CI, not by clicking
# around in a browser. No GPU: CPU-only code execution, matching the original
# manifest's minimum (no vramMiB/cuda) - see workspace-manifests.ts.
DEFAULT_API_IMAGE = (
    "quay.io/jupyter/datascience-notebook@sha256:"
    "20cbe280416d58b27e5fa1353a6ab849853103eca05f9e310608370f266c3dc4"
)
# Custom GPUbnb image (workspaces/mobile/Dockerfile), built and used
# LOCALLY on this dev/test host only - NOT published to any registry (no
# credentials, and publishing is a separate decision the user has not made).
# This means Mobile Workspace is only actually runnable on a host machine
# that has this exact image built locally, unlike every other workspace's
# image here, which is a registry-pulled reference any host can fetch. Built
# FROM the already-proven Developer image (same code-server terminal/editor,
# same coder uid/gid 1000, same HTTP-on-3000 surface) plus a real Android
# SDK (platform-tools, build-tools;36.1.0, platforms;android-36) and a real
# Gradle 9.7.1 install, both from their official upstream distributions with
# integrity verified against the real published checksums. No emulator/
# system-images: /dev/kvm is confirmed absent on this host and there is no
# honest software fallback - this is a real headless Android build & dev
# environment, not a device emulator (see docs/SESSION_RESUME.md). Pinned by
# a real content-addressed digest, exactly like every other workspace here -
# `docker build -t gpubnb-mobile-workspace:local` gets a local `RepoDigests`
# entry even without ever being pushed (confirmed live: `docker run
# gpubnb-mobile-workspace@sha256:<id>` resolves and runs) - it is just not
# fetchable from any registry, so only a host that ran this exact build can
# use it. See PINNED_MOBILE_IMAGE in workspace_gateway.py.
DEFAULT_MOBILE_IMAGE = (
    "gpubnb-mobile-workspace@sha256:"
    "93c5903b3acccddd9b7c64a7274c0d93239b32c31f64979d09b77b813d87afd8"
)
# Same "built and used locally only" status as DEFAULT_MOBILE_IMAGE - see
# its comment. Product scope decided explicitly with the user before this
# was built (a real DEFENSIVE analysis lab, not an offensive pentesting
# toolkit): tshark, YARA and radare2, all real, official Ubuntu 24.04
# packages (GPL/BSD, freely redistributable, no manual download/checksum
# dance needed unlike Mobile's Android SDK). No nmap/sqlmap/hydra/
# Metasploit - every session's real container has zero route to the public
# internet or to any other machine (same guarantee every workspace here
# already has), so an offensive tool would have zero reachable target; only
# added "pentesting toolkit" labeling risk, no real capability. No Burp
# Suite: its Community Edition EULA does not permit bundling into a
# redistributable image. Confirmed live: a real crafted-in-userspace pcap
# parsed correctly by tshark, a real YARA rule match, and a real radare2
# analysis of an actual ELF binary - all under --network=none,
# --cap-drop=ALL, --read-only. See workspaces/security-lab/Dockerfile and
# docs/SESSION_RESUME.md.
DEFAULT_SECURITY_LAB_IMAGE = (
    "gpubnb-security-lab-workspace@sha256:"
    "c7e647638b34934d27a04516b702df23e238325e8d2490144e5bb84d7bf2c379"
)
LEGACY_DEVELOPER_IMAGES = {
    "ghcr.io/khemisset18/gpubnb-developer@sha256:"
    "26700fdc955495b610bbcf8a912110395fc72181a236de2b70b539a0c02150b7",
}


def workspace_image(config: dict, slug: str) -> str:
    images = config.get("workspaceImages")
    configured = images.get(slug) if isinstance(images, dict) else None
    if configured and str(configured) not in LEGACY_DEVELOPER_IMAGES:
        return str(configured)
    if slug == "developer":
        return DEFAULT_DEVELOPER_IMAGE
    if slug == "compute":
        return DEFAULT_COMPUTE_IMAGE
    if slug == "data":
        return DEFAULT_DATA_IMAGE
    if slug == "ai":
        return DEFAULT_AI_IMAGE
    if slug == "video":
        return DEFAULT_VIDEO_IMAGE
    if slug == "audio":
        return DEFAULT_AUDIO_IMAGE
    if slug == "api":
        return DEFAULT_API_IMAGE
    if slug == "mobile":
        return DEFAULT_MOBILE_IMAGE
    if slug == "security-lab":
        return DEFAULT_SECURITY_LAB_IMAGE
    return str(config.get("diagnosticImage") or "")
