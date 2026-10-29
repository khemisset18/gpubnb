# Design-only candidate. Build on an isolated runner; this does not activate rentals.
# ComfyUI is source-pinned; no unsigned community nodes are loaded during build.
FROM quay.io/jupyter/pytorch-notebook@sha256:de7e7da7ba3e66cd2720ff9e72c93c43d24cb83478a032862acb7520fa8b2200
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG COMFYUI_COMMIT=fd7639f477050e5c25b68fc38a9c2a6b6d988211
RUN printf '%s' "$COMFYUI_COMMIT" | grep -Eq '^[a-f0-9]{40}$' \
 && git clone https://github.com/Comfy-Org/ComfyUI.git /opt/ComfyUI \
 && git -C /opt/ComfyUI checkout --detach "$COMFYUI_COMMIT" \
 && test "$(git -C /opt/ComfyUI rev-parse HEAD)" = "$COMFYUI_COMMIT" \
 && python -m pip install --no-cache-dir -r /opt/ComfyUI/requirements.txt
COPY --chmod=755 entrypoint.sh /usr/local/bin/gpubnb-ai-image-entrypoint
COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-ai-image-healthcheck
RUN install -d -o jovyan -g users -m 0750 /workspace
USER jovyan
WORKDIR /workspace
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 CMD ["/usr/local/bin/gpubnb-ai-image-healthcheck"]
ENTRYPOINT ["/usr/local/bin/gpubnb-ai-image-entrypoint"]
