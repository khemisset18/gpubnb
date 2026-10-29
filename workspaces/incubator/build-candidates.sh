#!/bin/sh
set -eu
# Builds local *candidate* images only. Never installs them on an owner PC,
# changes marketplace availability, or publishes images to a registry.
# Run ONLY on a disposable build environment with permission to fetch models.
if [ "$#" -ne 1 ]; then
  echo "usage: $0 <ai-image-studio|llm-studio|voice-ai-studio|ai-training-studio|render-3d-studio|game-server-studio>" >&2
  exit 2
fi
slug="$1"
case "$slug" in
  ai-image-studio|voice-ai-studio|ai-training-studio|render-3d-studio)
    set --
    ;;
  llm-studio)
    : "${MODEL_COMMIT:?Set a reviewed 40-hex Hugging Face model commit}"
    : "${MODEL_REPO:?Set a reviewed license-compatible model repo}"
    set -- --build-arg "MODEL_COMMIT=$MODEL_COMMIT" --build-arg "MODEL_REPO=$MODEL_REPO"
    ;;
  game-server-studio)
    : "${MOJANG_SERVER_URL:?Set the official licensed Mojang server download URL}"
    : "${MOJANG_SERVER_SHA256:?Set the exact verified SHA256}"
    set -- --build-arg "MOJANG_SERVER_URL=$MOJANG_SERVER_URL" --build-arg "MOJANG_SERVER_SHA256=$MOJANG_SERVER_SHA256"
    ;;
  *)
    echo "unknown studio: $slug" >&2
    exit 2
    ;;
esac
project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
exec docker build --pull=false --progress=plain "$@" \
  --file "$project_dir/workspaces/$slug/Dockerfile" \
  --tag "gpubnb/$slug:unqualified-local" \
  "$project_dir/workspaces/$slug"
