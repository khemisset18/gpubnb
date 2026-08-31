# Built and used LOCALLY on this dev/test host only - NOT published to any
# registry (no credentials, not requested) - same status as Mobile
# Workspace's image. See docs/SESSION_RESUME.md.
#
# Product scope decided explicitly with the user before this was written
# (AskUserQuestion): a real DEFENSIVE analysis/reverse-engineering lab, not
# an offensive pentesting toolkit. Every session's real container sits on a
# per-session Docker "internal" network whose only other member is the
# relay proxy - there is no route to the public internet or to any other
# machine (same guarantee every other workspace here already has), so
# nmap/sqlmap/hydra/msfconsole would have zero reachable target and were
# deliberately left out - they'd add "pentesting toolkit" labeling risk
# with no real added capability. Burp Suite was also excluded: its
# Community Edition EULA requires a per-user download/acceptance from
# PortSwigger's own site and prohibits bundling into a redistributable
# image without their permission - not legally shippable this way,
# regardless of which tool-set direction was chosen.
#
# Reuses the already-proven Developer Workspace image as its base, exactly
# like Mobile Workspace: same code-server terminal/editor, same coder
# (uid/gid 1000) user, same HTTP/WS-on-port-3000 surface.
FROM ghcr.io/khemisset18/gpubnb-developer@sha256:bd99f5f169a83adc649e73c3b52d1685548b209eb071ad251baa2f87e1fa8bc4

USER root

# All three real, official Ubuntu 24.04 (noble) packages, GPL/BSD licensed,
# freely redistributable - no manual download/checksum dance needed, unlike
# Mobile's Android SDK (apt already verifies package signatures).
#
# tshark's install asks (via debconf) whether non-superusers should be able
# to capture packets, which needs a setuid/capability grant on dumpcap.
# Explicitly declined: this container runs --cap-drop=ALL like every other
# workspace here, and there is no live network to capture from anyway
# (--network is the same internet-isolated internal network every workspace
# uses) - the real, intended workflow is analyzing a renter's own uploaded
# .pcap file with `tshark -r`, which needs no special capability at all.
RUN echo "wireshark-common wireshark-common/install-setuid boolean false" | debconf-set-selections \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tshark yara radare2 \
 && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-security-lab-healthcheck
COPY --chown=coder:coder welcome.md /workspace/WELCOME.md

USER coder
WORKDIR /workspace
ENV HOME=/home/coder
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 CMD ["/usr/local/bin/gpubnb-security-lab-healthcheck"]
ENTRYPOINT ["code-server"]
CMD ["--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace"]
