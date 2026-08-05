name: gpu-proof-workspace-image

on:
  pull_request:
    paths:
      - containers/gpu-proof-workspace/**
      - .github/workflows/gpu-proof-workspace-image.yml
      - agent/gpubnb_agent/runner.py
  push:
    branches: [main]
    paths:
      - containers/gpu-proof-workspace/**
      - .github/workflows/gpu-proof-workspace-image.yml
  workflow_dispatch:

permissions:
  contents: read
  packages: write
  id-token: write

env:
  IMAGE: ghcr.io/${{ github.repository_owner }}/gpu-proof-workspace

jobs:
  build-publish-sign:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE }}
          tags: type=sha,prefix=sha-
      - name: Build immutable workspace
        id: build
        uses: docker/build-push-action@v6
        with:
          context: containers/gpu-proof-workspace
          platforms: linux/amd64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          provenance: mode=max
          sbom: true
      - name: Verify fixed non-root entrypoint
        if: github.event_name == 'pull_request'
        run: |
          grep -Fq 'USER 65532:65532' containers/gpu-proof-workspace/Dockerfile
          grep -Fq 'ENTRYPOINT ["/usr/local/bin/gpu-proof"]' containers/gpu-proof-workspace/Dockerfile
          grep -Fq '@sha256:' containers/gpu-proof-workspace/Dockerfile
      - uses: sigstore/cosign-installer@v3
        if: github.event_name != 'pull_request'
      - name: Sign published digest
        if: github.event_name != 'pull_request'
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          test -n "$DIGEST"
          cosign sign --yes "${IMAGE}@${DIGEST}"
          printf '%s@%s\n' "$IMAGE" "$DIGEST" | tee gpu-proof-workspace-image.txt
      - uses: actions/upload-artifact@v6
        if: github.event_name != 'pull_request'
        with:
          name: gpu-proof-workspace-image
          path: gpu-proof-workspace-image.txt
          if-no-files-found: error
          retention-days: 30
