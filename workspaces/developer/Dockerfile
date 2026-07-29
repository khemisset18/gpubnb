FROM codercom/code-server@sha256:49d5e176224523b0c924ee35b05c51e9a87f9c170f650ee0f7da05a4581a79ff

USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates cargo curl default-jdk-headless g++ gcc git golang-go make \
    nodejs npm postgresql-client python3 python3-pip redis-tools rustc sqlite3 unzip \
 && npm cache clean --force \
 && npm install --global npm@11.19.0 js-yaml@5.2.2 shell-quote@1.10.0 tar@7.5.22 \
 && npm install --prefix /usr/local/lib/node_modules/npm --omit=dev --no-save \
    brace-expansion@5.0.8 js-yaml@4.3.0 shell-quote@1.9.0 tar@7.5.22 \
 && rm -rf /var/lib/apt/lists/* /root/.cache /usr/local/bin/fixuid \
 && install -d -o coder -g coder -m 700 /workspace /workspace/imports /workspace/output

COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-developer-healthcheck
COPY --chown=coder:coder welcome.md /workspace/WELCOME.md

USER coder
WORKDIR /workspace
ENV HOME=/home/coder
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 CMD ["/usr/local/bin/gpubnb-developer-healthcheck"]
ENTRYPOINT ["code-server"]
CMD ["--bind-addr", "0.0.0.0:3000", "--auth", "password", "/workspace"]
