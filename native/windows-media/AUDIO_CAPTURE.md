# Windows game-audio capture ABI

`GPUbnbAudioOpenForRenterProcess` is a low-level WASAPI process-loopback
capture primitive. The caller must pass the exact Windows session ID and PID
of the authorized game process, plus its creation timestamp from the process
handle returned by the authorized game launcher. The timestamp uses Windows
FILETIME units (100 ns since 1601-01-01 UTC), which rejects a stale/reused PID.
The DLL verifies that both it and the target process are alive in the same
Windows session and run under the same user SID.
It captures the target process and its child processes only; it does not open
the system render endpoint or capture the system-wide mix.

The API is available on Windows build 20348 and later. It returns timestamped,
raw PCM packets in the format selected by the process-loopback audio client.
Open, read and close must run on the same worker thread. A closed process,
unsupported mix format, Windows audio service failure or device error is a
capture failure and must stop/revoke the session rather than fall back to
system-wide loopback.

The request's `ReadTimeoutMs` (10–150 ms) bounds how long a packet read waits;
it does not change the WASAPI engine period. Shared-mode event-driven capture
passes zero buffer and periodicity values to `IAudioClient::Initialize`, as
required by that buffering mode. If WASAPI reports an uncertain timestamp, the
packet is marked discontinuous and its QPC timestamp is zeroed for downstream
synchronization.

This ABI is not yet connected to the Windows stream helper, the authenticated
gateway, an audio encoder, or browser playback. It provides no audio/video
clock synchronization, device-change recovery or end-to-end STOP test. The
helper continues to report `audioReady: false`, and Windows Gaming rental
eligibility remains closed until those pieces and the privacy-isolation test
are implemented and qualified.
