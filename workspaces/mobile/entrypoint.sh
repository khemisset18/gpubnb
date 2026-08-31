#!/usr/bin/env sh
set -eu
# $HOME is a fresh, empty tmpfs at every real container start (see
# runner.py's DEVELOPER_HOME_TMPFS) - the Gradle cache warmed at image-build
# time (with real internet access) lives outside it, under
# /opt/gpubnb-mobile/gradle-seed-cache, precisely so it survives that. Seed
# it back into $HOME/.gradle once per session so the first real build a
# renter runs is offline-capable immediately, not just the healthcheck's own
# throwaway container.
if [ ! -d "$HOME/.gradle" ]; then
  cp -a "$GPUBNB_MOBILE_GRADLE_SEED" "$HOME/.gradle"
fi
# /workspace is the renter's real persistent volume (unlike $HOME, wiped
# every session) - seed the sample project into it once, on first use only,
# so a renter's own edits across restarts within the same booking are never
# overwritten. /opt/gpubnb-mobile/sample-project itself stays read-only
# (part of the image layer) and is never built in place.
if [ ! -e /workspace/sample-project ]; then
  cp -a "$GPUBNB_MOBILE_SAMPLE" /workspace/sample-project
fi
exec code-server "$@"
