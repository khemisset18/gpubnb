FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS node-runtime

FROM codercom/code-server:4.130.0-ubuntu@sha256:d39c88f837f78465b4cf99f54b76eadf52440dc9ffb589e2ddc5d2fd9d0592d2

USER root
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates cargo curl default-jdk-headless g++ gcc git golang-go make \
    postgresql-client python3 python3-pip redis-tools rustc sqlite3 unzip \
 && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm cache clean --force \
 && npm install --global js-yaml@5.2.2 shell-quote@1.10.0 tar@7.5.22 \
 && npm install --prefix /tmp/code-server-fixes --omit=dev --no-save \
    brace-expansion@5.0.9 ip-address@10.3.1 js-yaml@4.3.1 picomatch@4.0.4 \
    shell-quote@1.9.0 sigstore@4.1.1 tar@7.5.22 undici@7.29.0 \
 && rm -rf /usr/lib/code-server/node_modules/ip-address \
    /usr/lib/code-server/node_modules/js-yaml \
    /usr/lib/code-server/lib/vscode/node_modules/ip-address \
    /usr/lib/code-server/lib/vscode/node_modules/shell-quote \
    /usr/lib/code-server/lib/vscode/node_modules/tar \
    /usr/lib/code-server/lib/vscode/node_modules/undici \
    /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    /usr/local/lib/node_modules/npm/node_modules/ip-address \
    /usr/local/lib/node_modules/npm/node_modules/sigstore \
    /usr/local/lib/node_modules/npm/node_modules/tar \
    /usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch \
 && cp -a /tmp/code-server-fixes/node_modules/ip-address /usr/lib/code-server/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/js-yaml /usr/lib/code-server/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/ip-address \
    /usr/lib/code-server/lib/vscode/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/shell-quote \
    /usr/lib/code-server/lib/vscode/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/tar \
    /usr/lib/code-server/lib/vscode/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/undici \
    /usr/lib/code-server/lib/vscode/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/brace-expansion \
    /usr/local/lib/node_modules/npm/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/ip-address \
    /usr/local/lib/node_modules/npm/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/sigstore \
    /usr/local/lib/node_modules/npm/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/tar \
    /usr/local/lib/node_modules/npm/node_modules/ \
 && cp -a /tmp/code-server-fixes/node_modules/picomatch \
    /usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/ \
 && rm -rf /tmp/code-server-fixes \
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
