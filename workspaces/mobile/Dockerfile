# Built and used LOCALLY on this dev/test host only - NOT published to any
# registry (no credentials, not requested). A production rollout to other
# host machines would need this image actually published somewhere they can
# pull it from; that is a separate, explicit decision, not made here. See
# docs/SESSION_RESUME.md.
#
# Reuses the already-proven Developer Workspace image as its base: same
# code-server terminal/editor, same coder (uid/gid 1000) user, same
# HTTP/WS-on-port-3000 surface this gateway already knows how to relay -
# only the Android SDK/Gradle toolchain is new. No graphical emulator is
# installed: /dev/kvm is confirmed absent on this host and there is no
# software fallback worth offering (would be misleadingly slow/broken) -
# this is a real headless Android build & dev environment, not a device
# emulator.
FROM ghcr.io/khemisset18/gpubnb-developer@sha256:bd99f5f169a83adc649e73c3b52d1685548b209eb071ad251baa2f87e1fa8bc4

USER root

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GPUBNB_MOBILE_GRADLE_SEED=/opt/gpubnb-mobile/gradle-seed-cache \
    GPUBNB_MOBILE_SAMPLE=/opt/gpubnb-mobile/sample-project

# Official Google-published Android SDK command-line tools, integrity
# verified against the real sha1 published in Google's own repository
# manifest (https://dl.google.com/android/repository/repository2-3.xml,
# resolved 2026-08-31). No emulator/system-images packages are installed -
# see the Dockerfile header.
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && curl -fsSL -o /tmp/cmdline-tools.zip \
    "https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip" \
 && echo "e025545c62a8e64c7559119566a569fb1dec5f60  /tmp/cmdline-tools.zip" | sha1sum -c - \
 && unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools" \
 && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
 && rm /tmp/cmdline-tools.zip

ENV PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# platform-tools (adb), build-tools and one recent stable platform - real
# Google-signed packages via sdkmanager's own official repository, licenses
# accepted non-interactively (the same license text sdkmanager would show
# and require accepting interactively otherwise).
RUN yes | sdkmanager --licenses >/dev/null \
 && sdkmanager --install "platform-tools" "build-tools;36.1.0" "platforms;android-36"

# Real Gradle, official distribution, integrity verified against the real
# checksum published at https://services.gradle.org/versions/current
# (resolved 2026-08-31).
RUN curl -fsSL -o /tmp/gradle.zip \
    "https://services.gradle.org/distributions/gradle-9.7.1-bin.zip" \
 && echo "acd53f1edaf02f1a8ff99879f8a34b302661a057d9b063ae9e35b552f804d20a  /tmp/gradle.zip" | sha256sum -c - \
 && unzip -q /tmp/gradle.zip -d /opt \
 && ln -s /opt/gradle-9.7.1/bin/gradle /usr/local/bin/gradle \
 && rm /tmp/gradle.zip

COPY --chown=coder:coder sample-project "$GPUBNB_MOBILE_SAMPLE"

# Prove the whole toolchain actually works, and pre-warm Gradle's dependency
# cache (AGP, Kotlin/Java toolchain, the wrapper distribution itself) while
# this build step still has real internet access - the real runtime later
# has none (--network=none, same as every other workspace here). Building as
# "coder" (not root) matches who actually runs it at runtime.
RUN chown -R coder:coder "$ANDROID_HOME" /opt/gradle-9.7.1 && \
    su coder -c "cd '$GPUBNB_MOBILE_SAMPLE' && \
      gradle wrapper --gradle-version 9.7.1 --no-daemon && \
      ./gradlew assembleDebug --no-daemon --console=plain && \
      ./gradlew --stop" \
 && mkdir -p /opt/gpubnb-mobile \
 && cp -a /home/coder/.gradle "$GPUBNB_MOBILE_GRADLE_SEED" \
 && rm -rf "$GPUBNB_MOBILE_SAMPLE/lib/build" "$GPUBNB_MOBILE_SAMPLE/.gradle" \
 && chown -R coder:coder /opt/gpubnb-mobile

COPY --chmod=755 entrypoint.sh /usr/local/bin/gpubnb-mobile-entrypoint
COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-mobile-healthcheck
COPY --chown=coder:coder welcome.md /workspace/WELCOME.md

USER coder
WORKDIR /workspace
ENV HOME=/home/coder
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 CMD ["/usr/local/bin/gpubnb-mobile-healthcheck"]
ENTRYPOINT ["/usr/local/bin/gpubnb-mobile-entrypoint"]
CMD ["--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace"]
