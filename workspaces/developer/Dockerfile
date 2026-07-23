FROM codercom/code-server@sha256:6edc8e2d2849749c1a1a5eff8e76563b96db407e68899c143473a6004d0a6b5a

USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates cargo curl default-jdk-headless g++ gcc git golang-go make \
    nodejs npm postgresql-client python3 python3-pip redis-tools rustc sqlite3 unzip \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.cache \
 && install -d -o coder -g coder -m 700 /workspace /workspace/imports /workspace/output

COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-developer-healthcheck
COPY --chown=coder:coder welcome.md /workspace/WELCOME.md

USER coder
WORKDIR /workspace
ENV HOME=/home/coder
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 CMD ["/usr/local/bin/gpubnb-developer-healthcheck"]
