FROM rust:1.97-bookworm AS builder
WORKDIR /build
COPY services/control-gateway/Cargo.toml ./Cargo.toml
COPY services/control-gateway/Cargo.lock ./Cargo.lock
COPY services/control-gateway/src ./src
COPY services/control-gateway/tests ./tests
RUN cargo build --locked --release --bin gpubnb-control-gateway

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /var/lib/gpubnb gpubnb
COPY --from=builder /build/target/release/gpubnb-control-gateway /usr/local/bin/gpubnb-control-gateway
USER 10001:10001
EXPOSE 4443/udp 9090/tcp
ENTRYPOINT ["/usr/local/bin/gpubnb-control-gateway"]
