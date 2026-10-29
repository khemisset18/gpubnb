# CLI/Batch Blender studio, intentionally NOT the GUI Creator /dev/dri studio.
FROM ghcr.io/khemisset18/gpubnb-developer@sha256:bd99f5f169a83adc649e73c3b52d1685548b209eb071ad251baa2f87e1fa8bc4
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends blender \
 && rm -rf /var/lib/apt/lists/*
COPY gpu-render-smoke.py /opt/gpubnb-render/gpu-render-smoke.py
COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-render-healthcheck
USER coder
WORKDIR /workspace
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 CMD ["/usr/local/bin/gpubnb-render-healthcheck"]
ENTRYPOINT ["code-server"]
CMD ["--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace"]
