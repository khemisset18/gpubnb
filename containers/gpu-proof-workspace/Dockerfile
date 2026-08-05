# syntax=docker/dockerfile:1.7
FROM nvidia/cuda:13.0.1-devel-ubuntu24.04@sha256:7d2f6a8c2071d911524f95061a0db363e24d27aa51ec831fcccf9e76eb72bc92 AS build
WORKDIR /src
COPY gpu_proof.cu .
RUN nvcc -O2 --use_fast_math -Xcompiler=-fPIE \
    -Xlinker=-z -Xlinker=relro -Xlinker=-z -Xlinker=now -Xlinker=-z -Xlinker=noexecstack \
    -o /gpu-proof gpu_proof.cu

FROM nvidia/cuda:13.0.1-runtime-ubuntu24.04@sha256:c3fde347d52d578c84fd644bc177bc7ec333feaf11550d990da4084d7612e4c7
COPY --from=build --chown=65532:65532 /gpu-proof /usr/local/bin/gpu-proof
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/gpu-proof"]
