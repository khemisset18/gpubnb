#!/usr/bin/env bash
# Build the two offline lab programs against unmodified, pinned upstream objects.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'usage: build_helpers.sh PEARL_GIT_CHECKOUT OUTPUT_DIRECTORY' >&2
  exit 2
fi
upstream=$(realpath "$1")
out=$(realpath -m "$2")
src=$(cd "$(dirname "$0")" && pwd)
pin=3db05e0de0ca90c3a043abd927b968cf53bcd4c8
[[ "$(git -C "$upstream" rev-parse 'refs/tags/v1.5.8^{commit}')" == "$pin" ]]
export GOTOOLCHAIN=local CGO_ENABLED=0
[[ "$(go env GOVERSION)" == go1.26.10 ]]
build=$(mktemp -d)
trap 'rm -rf -- "$build"' EXIT
git -C "$upstream" archive "$pin" go.mod go.sum node/btcec node/btcutil node/chaincfg node/wire node/txscript xmss | tar -x -C "$build"
mkdir -p "$out"
cd "$build"
for tool in fixture verifyrefund; do
  go build -mod=readonly -trimpath -buildvcs=false -o "$out/$tool" "$src/cmd/$tool/main.go"
done
sha256sum "$out/fixture" "$out/verifyrefund"
