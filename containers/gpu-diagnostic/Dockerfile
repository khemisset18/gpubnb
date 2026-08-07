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
    && test -f /lib/x86_64-linux-gnu/libpthread.so.0 \
    && test -f /lib/x86_64-linux-gnu/libdl.so.2 \
    && test -f /lib/x86_64-linux-gnu/librt.so.1 \
    && test -f /lib/x86_64-linux-gnu/libm.so.6 \
    && test -f /lib/x86_64-linux-gnu/libresolv.so.2 \
    && test -f /lib64/ld-linux-x86-64.so.2 \
    && mkdir -p /gpu-lib-mount-point/usr/lib/x86_64-linux-gnu /gpu-lib-mount-point/usr/lib64 /gpu-lib-mount-point/usr/lib /gpu-lib-mount-point/lib/x86_64-linux-gnu

# Final runtime contains no distribution, shell, package database, package manager,
# service manager, certificates or writable application files. NVIDIA Container
# Toolkit injects libnvidia-ml.so.1 at runtime when the utility capability is enabled.
#
# Two things are required for that injection to actually work in this minimal image,
# confirmed by reproducing the failure directly against a real GPU:
#  1. A mount TARGET directory has to already exist for the backend to bind onto — it
#     will not create one. Which directory it picks is backend-specific (the standard
#     NVIDIA Container Toolkit uses /usr/lib/x86_64-linux-gnu; Docker Desktop's WSL2
#     integration was observed using /usr/lib64 instead), so every candidate is
#     pre-created as an empty directory (never a placeholder FILE — glibc's loader
#     aborts the whole search on the first path that exists but isn't valid ELF,
#     instead of falling through to the next LD_LIBRARY_PATH candidate).
#  2. libnvidia-ml.so.1 itself is dynamically linked against a handful of standard
#     glibc component libraries (libpthread/libdl/librt/libm/libresolv). A scratch
#     image with only libc.so.6 fails to load it for that reason alone even once the
#     library itself is found.
FROM scratch
COPY --from=build /lib/x86_64-linux-gnu/libc.so.6 /lib/x86_64-linux-gnu/libc.so.6
COPY --from=build /lib/x86_64-linux-gnu/libpthread.so.0 /lib/x86_64-linux-gnu/libpthread.so.0
COPY --from=build /lib/x86_64-linux-gnu/libdl.so.2 /lib/x86_64-linux-gnu/libdl.so.2
COPY --from=build /lib/x86_64-linux-gnu/librt.so.1 /lib/x86_64-linux-gnu/librt.so.1
COPY --from=build /lib/x86_64-linux-gnu/libm.so.6 /lib/x86_64-linux-gnu/libm.so.6
COPY --from=build /lib/x86_64-linux-gnu/libresolv.so.2 /lib/x86_64-linux-gnu/libresolv.so.2
COPY --from=build /lib64/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --from=build /gpu-lib-mount-point/usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu
COPY --from=build /gpu-lib-mount-point/usr/lib64 /usr/lib64
COPY --from=build /gpu-lib-mount-point/usr/lib /usr/lib
COPY --from=build /gpu-lib-mount-point/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu
COPY --from=build --chown=65532:65532 /gpu-diagnostic /usr/local/bin/gpu-diagnostic
ENV LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/usr/lib64:/usr/lib:/lib/x86_64-linux-gnu
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/gpu-diagnostic"]
