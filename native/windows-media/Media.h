#pragma once

#include <Windows.h>
#include <stdint.h>

#define GPUBNB_WINDOWS_MEDIA_ABI_VERSION 2u
#define GPUBNB_WINDOWS_MEDIA_DIAGNOSTIC_VERSION 1u
#define GPUBNB_WINDOWS_AUDIO_ABI_VERSION 1u
// Explicitly separate ABI; an IddCx/nonced request must never silently select
// an existing console monitor. This ABI is not wired to rental readiness.
#define GPUBNB_CONSOLE_MEDIA_ABI_VERSION 3u

enum GPUbnbMediaProofFlags : uint32_t
{
    GPUBNB_MEDIA_PROOF_EXACT_GPU = 1u << 0,
    GPUBNB_MEDIA_PROOF_DISPLAY_FOUND = 1u << 1,
    GPUBNB_MEDIA_PROOF_CAPTURED_FRAME = 1u << 2,
    GPUBNB_MEDIA_PROOF_NVENC_BITSTREAM = 1u << 3,
};

enum GPUbnbMediaFrameFlags : uint32_t
{
    GPUBNB_MEDIA_FRAME_KEYFRAME = 1u << 0,
};

enum GPUbnbMediaProbeStage : uint32_t
{
    GPUBNB_MEDIA_STAGE_NONE = 0,
    GPUBNB_MEDIA_STAGE_VALIDATE = 1,
    GPUBNB_MEDIA_STAGE_EXACT_GPU = 2,
    GPUBNB_MEDIA_STAGE_DISPLAY = 3,
    GPUBNB_MEDIA_STAGE_D3D11 = 4,
    GPUBNB_MEDIA_STAGE_CAPTURE_SESSION = 5,
    // Numeric ABI compatibility with existing diagnostics. Stage 5 is now the
    // supported monitor-capture session rather than DXGI Desktop Duplication.
    GPUBNB_MEDIA_STAGE_DUPLICATION = GPUBNB_MEDIA_STAGE_CAPTURE_SESSION,
    GPUBNB_MEDIA_STAGE_CAPTURE = 6,
    GPUBNB_MEDIA_STAGE_NVENC_LOAD = 7,
    GPUBNB_MEDIA_STAGE_NVENC_SESSION = 8,
    GPUBNB_MEDIA_STAGE_NVENC_ENCODE = 9,
};

#pragma pack(push, 1)
struct GPUbnbMediaProbeRequest
{
    uint32_t Size;
    uint32_t Version;
    LUID RenderAdapterLuid;
    uint8_t ExpectedGpuUuid[16];
    uint8_t DisplayNonce[16];
    uint32_t Width;
    uint32_t Height;
    uint32_t RefreshHz;
    uint32_t CaptureTimeoutMs;
};

struct GPUbnbMediaProbeResult
{
    uint32_t Size;
    uint32_t Version;
    uint32_t ProofFlags;
    uint32_t FailedStage;
    LUID RenderAdapterLuid;
    uint32_t Width;
    uint32_t Height;
    uint32_t RefreshHz;
    uint32_t EncodedBytes;
    uint64_t FrameSequence;
    uint32_t Reserved[4];
};

struct GPUbnbMediaFrameResult
{
    uint32_t Size;
    uint32_t Version;
    uint32_t ProofFlags;
    uint32_t FailedStage;
    LUID RenderAdapterLuid;
    uint32_t Width;
    uint32_t Height;
    uint32_t RefreshHz;
    uint32_t EncodedBytes;
    uint64_t FrameSequence;
    uint32_t RequiredCapacity;
    uint32_t FrameFlags;
    uint32_t Reserved[2];
};

// Distinct proof flags: CONSOLE_DISPLAY is NOT GPUbnb IddCx DISPLAY_FOUND.
// These flags must never be translated to the Stage 4 virtualDisplay proof.
enum GPUbnbConsoleProofFlags : uint32_t
{
    GPUBNB_CONSOLE_PROOF_EXACT_GPU = 1u << 0,
    GPUBNB_CONSOLE_PROOF_CONSOLE_DISPLAY = 1u << 1,
    GPUBNB_CONSOLE_PROOF_CAPTURED_FRAME = 1u << 2,
    GPUBNB_CONSOLE_PROOF_NVENC_BITSTREAM = 1u << 3,
};

struct GPUbnbConsoleProbeRequest
{
    uint32_t Size;
    uint32_t Version;
    LUID RenderAdapterLuid;
    uint8_t ExpectedGpuUuid[16];
    uint8_t SessionNonce[16];
    uint32_t WindowsSessionId;
    uint32_t Width;
    uint32_t Height;
    uint32_t RefreshHz;
    uint32_t CaptureTimeoutMs;
    uint32_t Reserved[3];
};

struct GPUbnbConsoleMediaFrameResult
{
    uint32_t Size;
    uint32_t Version;
    uint32_t ProofFlags;
    uint32_t FailedStage;
    LUID RenderAdapterLuid;
    uint32_t Width;
    uint32_t Height;
    uint32_t RefreshHz;
    uint32_t EncodedBytes;
    uint64_t FrameSequence;
    uint32_t RequiredCapacity;
    uint32_t FrameFlags;
    uint32_t Reserved[2];
};

struct GPUbnbMediaDiagnostic
{
    uint32_t Size;
    uint32_t Version;
    uint32_t FailedStage;
    int32_t Hresult;
    int32_t NvencStatus;
    uint32_t ProofFlags;
    LUID RenderAdapterLuid;
    uint32_t Width;
    uint32_t Height;
    uint32_t RefreshHz;
    uint32_t Reserved[5];
};
#pragma pack(pop)

static_assert(sizeof(GPUbnbMediaProbeRequest) == 64, "GPUbnb media request ABI drift");
static_assert(sizeof(GPUbnbMediaProbeResult) == 64, "GPUbnb media result ABI drift");
static_assert(sizeof(GPUbnbMediaFrameResult) == 64, "GPUbnb media frame ABI drift");
static_assert(sizeof(GPUbnbMediaDiagnostic) == 64, "GPUbnb media diagnostic ABI drift");
static_assert(sizeof(GPUbnbConsoleProbeRequest) == 80, "GPUbnb console request ABI drift");
static_assert(sizeof(GPUbnbConsoleMediaFrameResult) == 64, "GPUbnb console frame ABI drift");

enum GPUbnbAudioSampleFormat : uint16_t
{
    GPUBNB_AUDIO_SAMPLE_IEEE_FLOAT32 = 1,
    GPUBNB_AUDIO_SAMPLE_PCM_UINT8 = 2,
    GPUBNB_AUDIO_SAMPLE_PCM_INT16 = 3,
    GPUBNB_AUDIO_SAMPLE_PCM_INT24 = 4,
    GPUBNB_AUDIO_SAMPLE_PCM_INT32 = 5,
};

enum GPUbnbAudioPacketFlags : uint32_t
{
    GPUBNB_AUDIO_PACKET_SILENT = 1u << 0,
    GPUBNB_AUDIO_PACKET_DISCONTINUITY = 1u << 1,
};

constexpr uint32_t GPUBNB_AUDIO_PACKET_MAX_BYTES = 512u * 1024u;

#pragma pack(push, 1)
struct GPUbnbAudioCaptureRequest
{
    uint32_t Size;
    uint32_t Version;
    uint32_t WindowsSessionId;
    uint32_t TargetProcessId;
    uint32_t ReadTimeoutMs;
    uint32_t Reserved;
};

// Payload is the selected renter game process tree's WASAPI mix format. It does
// not capture the whole Windows session or any unrelated process audio. This
// API returns raw PCM; it does not claim compressed transport readiness.
struct GPUbnbAudioPacketResult
{
    uint32_t Size;
    uint32_t Version;
    uint32_t WindowsSessionId;
    uint32_t TargetProcessId;
    uint32_t SampleRate;
    uint16_t Channels;
    uint16_t SampleFormat;
    uint32_t Frames;
    uint32_t PayloadBytes;
    uint64_t DevicePositionFrames;
    uint64_t QpcPosition100ns;
    uint32_t Flags;
    uint32_t Reserved[3];
};
#pragma pack(pop)

static_assert(sizeof(GPUbnbAudioCaptureRequest) == 24, "GPUbnb audio request ABI drift");
static_assert(sizeof(GPUbnbAudioPacketResult) == 64, "GPUbnb audio packet ABI drift");

struct GPUbnbAudioCapture;

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbAudioOpenForRenterProcess(
    const GPUbnbAudioCaptureRequest* request,
    GPUbnbAudioCapture** capture);

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbAudioRead(
    GPUbnbAudioCapture* capture,
    uint8_t* payload,
    uint32_t payloadCapacity,
    GPUbnbAudioPacketResult* result);

extern "C" __declspec(dllexport)
// Open, read, and close must run on the same worker thread. Process loopback
// is intentionally scoped to one game process tree, never the owner's mix.
HRESULT __stdcall GPUbnbAudioClose(GPUbnbAudioCapture* capture);

struct GPUbnbMediaSession;

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbProbeMediaFrame(
    const GPUbnbMediaProbeRequest* request,
    GPUbnbMediaProbeResult* result);


extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbMediaOpen(
    const GPUbnbMediaProbeRequest* request,
    GPUbnbMediaSession** session);

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbMediaReadFrame(
    GPUbnbMediaSession* session,
    uint8_t* bitstream,
    uint32_t bitstreamCapacity,
    GPUbnbMediaFrameResult* result);

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbMediaGetLastDiagnostic(GPUbnbMediaDiagnostic* diagnostic);

// Console APIs are intentionally independent of the legacy IddCx media ABI.
// The returned opaque session is closed by GPUbnbMediaClose. GPUbnbMediaReadFrame
// will reject it, and GPUbnbConsoleMediaReadFrame will reject IddCx sessions.
extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbConsoleMediaOpen(
    const GPUbnbConsoleProbeRequest* request,
    GPUbnbMediaSession** session);

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbConsoleMediaReadFrame(
    GPUbnbMediaSession* session,
    uint8_t* bitstream,
    uint32_t bitstreamCapacity,
    GPUbnbConsoleMediaFrameResult* result);

extern "C" __declspec(dllexport)
void __stdcall GPUbnbMediaClose(GPUbnbMediaSession* session);
