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
    return str(config.get("diagnosticImage") or "")
