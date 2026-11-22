# Windows game-audio capture ABI

`GPUbnbAudioOpenForRenterProcess` opens WASAPI process-loopback capture for the
exact Steam root process launched by the qualified worker. The request carries
its PID, Windows session ID and creation time. The media DLL checks the live
process handle, session and user SID; the privileged service independently
checks that identity and the signed Steam image before accepting its first
audio batch. Later batches must repeat the same PID and creation time. The
capture includes the target process and child-process audio streams; it does not
open the system render endpoint or the system-wide mix.

The API is available on Windows build 20348 and later. It returns timestamped,
raw PCM packets in the format selected by the process-loopback audio client.
Open, read and close must run on the same worker thread. A closed process,
unsupported mix format, Windows audio service failure or device error is a
capture failure and must stop/revoke the session rather than fall back to
system-wide loopback.

The request's `ReadTimeoutMs` supports the explicit value `0` for a
non-blocking poll, or 10–150 ms for bounded waits. Gaming uses non-blocking
polls so audio reads do not stall the video loop. Shared-mode event-driven
capture passes zero buffer and periodicity values to `IAudioClient::Initialize`,
as required by that buffering mode. WASAPI QPC timestamps and video QPC
timestamps share 100 ns units; uncertain audio timestamps are marked
discontinuous and mapped to the associated video time by the browser.

The current branch now binds bounded raw PCM packets to the NVENC frame proof,
relays them over the authenticated WebSocket, and plays them through browser
Web Audio with a shared QPC presentation clock, user-gesture activation, a
volume control and buffer cleanup on disconnect/STOP. PCM is uncompressed; no
Opus/other audio codec is present. This is an implemented software path, not
proof that game audio is isolated or usable on the GTX 1650 Host. Steam game
selection, hardware format/device-change behavior, audio/video latency,
five-minute continuity and immediate revocation still need Windows build/CI
and a controlled PC1-to-PC2 qualification. The browser suspends playback and
requires another user gesture after an AudioContext interruption or output
device change, discarding scheduled sources tied to the previous output clock.
The helper deliberately continues
to report `audioReady: false`, so Gaming rental eligibility remains closed.
