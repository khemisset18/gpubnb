"""Immutable official runtime images shipped with GPUbnb Host.

Pinned digests make a fresh or upgraded Host immediately usable without asking the
owner to find, paste, or trust a mutable Docker tag.
"""

DEFAULT_DEVELOPER_IMAGE = (
    "ghcr.io/khemisset18/gpubnb-developer@sha256:"
    "bd99f5f169a83adc649e73c3b52d1685548b209eb071ad251baa2f87e1fa8bc4"
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
    return str(config.get("diagnosticImage") or "")
