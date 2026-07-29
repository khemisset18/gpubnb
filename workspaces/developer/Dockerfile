FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS node-runtime

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
 && npm install --global npm@11.19.0 js-yaml@5.2.2 shell-quote@1.10.0 tar@7.5.22 \
 && npm install --prefix /tmp/npm-fixes --omit=dev --no-save \
    brace-expansion@5.0.8 js-yaml@4.3.0 shell-quote@1.9.0 tar@7.5.22 \
 && for package in brace-expansion js-yaml shell-quote tar; do \
      rm -rf "/usr/local/lib/node_modules/npm/node_modules/$package"; \
      cp -a "/tmp/npm-fixes/node_modules/$package" /usr/local/lib/node_modules/npm/node_modules/; \
    done \
 && rm -rf /tmp/npm-fixes \
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
