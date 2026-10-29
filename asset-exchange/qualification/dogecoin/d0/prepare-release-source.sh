#!/usr/bin/env bash
# Preserve release metadata while keeping the existing source commit authoritative.
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: prepare-release-source.sh <repository> <expected-commit> <new-input-dir>" >&2
  exit 2
fi

repository="$1"
expected_commit="$2"
input_dir="$3"
release_tag="v1.14.9"
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]]
test ! -e "$input_dir"

# gbuild's SHA-only fetch uses --no-tags. genbuild.sh consequently embeds a
# commit suffix instead of the official release version. Fetch just this tag,
# never all upstream tags, and reject it unless it peels to the existing pin.
git init -q "$input_dir"
git -C "$input_dir" fetch --no-tags "$repository" \
  "refs/tags/$release_tag:refs/tags/$release_tag"
test "$(git -C "$input_dir" cat-file -t "refs/tags/$release_tag")" = tag
test "$(git -C "$input_dir" rev-parse "refs/tags/$release_tag^{commit}")" = "$expected_commit"
git -C "$input_dir" checkout -q --detach "$expected_commit"
test "$(git -C "$input_dir" rev-parse HEAD)" = "$expected_commit"
test "$(git -C "$input_dir" describe --exact-match --abbrev=0)" = "$release_tag"

printf 'source_commit=%s\nrelease_tag=%s\ntag_object=%s\n' \
  "$expected_commit" "$release_tag" \
  "$(git -C "$input_dir" rev-parse "refs/tags/$release_tag")"
