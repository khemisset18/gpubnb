# Mobile Workspace

A real, headless Android build and development environment: Android SDK
(platform-tools, build-tools, a current platform), a real Gradle install,
and this same code-server terminal/editor as Developer Workspace.

## What this is

- `adb`, `sdkmanager`, `gradle` and the Android build-tools are real,
  installed from Google's/Gradle's own official distributions.
- A real Gradle build works fully offline in this session (the dependency
  cache was pre-warmed when this image was built).
- A full VS Code editor and terminal, exactly like Developer Workspace.

## What this is not

- **No graphical Android emulator.** Running one needs hardware
  virtualization (`/dev/kvm` on Linux); this host does not expose it to
  containers, and there is no usable software fallback. Test on your own
  device over `adb`, or build and inspect the APK/AAR output directly.
- **No live network access** inside this session (same isolation as every
  GPUbnb workspace). You cannot `sdkmanager --install` a new SDK
  package or add a new Gradle dependency version that was not already
  resolved when this image was built - do that from your own machine and
  bring the artifact in, or say so if you need a different toolchain
  pre-installed.
