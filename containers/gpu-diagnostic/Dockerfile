# syntax=docker/dockerfile:1.7
FROM debian:trixie-slim AS build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY src/gpu_diagnostic.c .
RUN cc -std=c17 -O2 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 \
    -Wl,-z,relro,-z,now,-z,noexecstack -pie \
    -Wall -Wextra -Werror -o /gpu-diagnostic gpu_diagnostic.c -ldl \
    && strip /gpu-diagnostic \
    && ldd /gpu-diagnostic \
    && test -f /lib/x86_64-linux-gnu/libc.so.6 \
    && test -f /lib64/ld-linux-x86-64.so.2

# Final runtime contains no distribution, shell, package database, package manager,
# service manager, certificates or writable application files. NVIDIA Container
# Toolkit injects libnvidia-ml.so.1 at runtime when the utility capability is enabled.
FROM scratch
COPY --from=build /lib/x86_64-linux-gnu/libc.so.6 /lib/x86_64-linux-gnu/libc.so.6
COPY --from=build /lib64/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --from=build --chown=65532:65532 /gpu-diagnostic /usr/local/bin/gpu-diagnostic
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/gpu-diagnostic"]