# syntax=docker/dockerfile:1.7
FROM debian:trixie-slim AS build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY src/gpu_diagnostic.c .
RUN cc -std=c17 -O2 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 \
    -Wl,-z,relro,-z,now,-z,noexecstack -pie \
    -Wall -Wextra -Werror -o /gpu-diagnostic gpu_diagnostic.c -ldl \
    && strip /gpu-diagnostic

# Distroless contains no shell, package manager or service manager.
FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=build --chown=65532:65532 /gpu-diagnostic /usr/local/bin/gpu-diagnostic
USER 65532:65532
WORKDIR /home/nonroot
ENTRYPOINT ["/usr/local/bin/gpu-diagnostic"]
