"""Immutable official runtime images shipped with GPUbnb Host.

Pinned digests make a fresh or upgraded Host immediately usable without asking the
owner to find, paste, or trust a mutable Docker tag.
"""

DEFAULT_DEVELOPER_IMAGE = (
    "ghcr.io/khemisset18/gpubnb-developer@sha256:"
    "26700fdc955495b610bbcf8a912110395fc72181a236de2b70b539a0c02150b7"
)


def workspace_image(config: dict, slug: str) -> str:
    images = config.get("workspaceImages")
    configured = images.get(slug) if isinstance(images, dict) else None
    if configured:
        return str(configured)
    if slug == "developer":
        return DEFAULT_DEVELOPER_IMAGE
    return str(config.get("diagnosticImage") or "")
