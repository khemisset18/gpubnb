# Gaming Workspace - architecture prepared, NOT working, NOT bookable

**Not REAL_WORKING.** Not in `executableWorkspaceSlugs`, not bookable.
Shares the exact same base image, GPU-rendering gap, and container-
hardening open questions as `workspaces/cloud-desktop/` - see
`workspaces/cloud-desktop/NOT_YET_WORKING.md` for the full detail, not
repeated here.

## What's specific to Gaming

- Sunshine/Moonlight investigated and ruled out: Sunshine has no TCP-only
  fallback at all (confirmed via web search - UDP-blocked means a real
  black screen, by Sunshine's own community's documented troubleshooting),
  and Moonlight is normally a native client, not a browser client.
- Real, official Ubuntu multiverse `steam-installer` package (not
  third-party/pirated) - confirmed live to install cleanly with its i386
  Mesa/GL dependencies.
- The real Steam launcher (`/usr/games/steam`) was run inside a live,
  fully-running instance of this exact base image's real Xvfb display and
  genuinely bootstrapped: created its real `~/.steam` install directory
  and symlinks, exactly like a first real run does.
- Real gamepad support confirmed live (Selkies auto-initializes 4
  persistent "Xbox 360 pad" instances at startup) and real audio support
  confirmed live (`audio_enabled`/`microphone_enabled` in Selkies' own
  config, `pulseaudio` present).
- `healthcheck.sh` additionally checks the real Steam binary is present
  and executable (cheap, real, proves nothing about GPU rendering, live
  game streaming, or actual input/audio round-trips through a real
  browser session).

## Content and licensing (per explicit product requirement)

GPUbnb redistributes no game and no Steam content. The renter brings their
own Steam account and their own already-owned games. Storage persistence
(so a renter's Steam library survives across a session) reuses the same
real per-session Docker volume every other workspace already has - no new
mechanism needed. Which games/content are acceptable to install in a
rented session is a real policy question, not decided here - needs an
explicit decision before this goes live, not an unstated default.

## Real validation still required (see docs/SESSION_RESUME.md section 8/9)

Same Linux-GPU-host validation plan as Cloud Desktop, plus: confirm actual
hardware-accelerated game rendering (not just the desktop compositor)
works, confirm real gamepad input round-trips correctly through a real
browser session, confirm real audio streams correctly, and only then
consider whether the WebSocket-mode latency is acceptable for the games
being targeted (a documented, honest tradeoff vs. native
Sunshine/Moonlight - not free lunch).
