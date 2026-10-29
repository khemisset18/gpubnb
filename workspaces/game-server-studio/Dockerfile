# Minecraft Java server candidate. Game networking has NOT been designed for
# GPUbnb's isolated Gateway; never add this image to rentable slugs yet.
FROM ghcr.io/khemisset18/gpubnb-developer@sha256:bd99f5f169a83adc649e73c3b52d1685548b209eb071ad251baa2f87e1fa8bc4
USER root
# The official Mojang server URL and SHA256 are mandatory, never guessed.
ARG MOJANG_SERVER_URL
ARG MOJANG_SERVER_SHA256
RUN printf '%s' "$MOJANG_SERVER_URL" | grep -Eq '^https://piston-data.mojang.com/v1/objects/[0-9a-f]{40}/server.jar$' \
 && printf '%s' "$MOJANG_SERVER_SHA256" | grep -Eq '^[0-9a-f]{64}$' \
 && mkdir -p /opt/gpubnb-game \
 && curl --fail --show-error --location --proto '=https' --tlsv1.2 --output /opt/gpubnb-game/server.jar "$MOJANG_SERVER_URL" \
 && printf '%s  /opt/gpubnb-game/server.jar\n' "$MOJANG_SERVER_SHA256" | sha256sum -c - \
 && install -d -o coder -g coder -m 0750 /workspace
COPY --chmod=755 entrypoint.sh /usr/local/bin/gpubnb-game-entrypoint
COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-game-healthcheck
USER coder
WORKDIR /workspace
EXPOSE 25565/tcp
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 CMD ["/usr/local/bin/gpubnb-game-healthcheck"]
ENTRYPOINT ["/usr/local/bin/gpubnb-game-entrypoint"]
