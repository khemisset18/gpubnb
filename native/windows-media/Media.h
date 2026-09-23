#pragma once

#include <Windows.h>
#include <stdint.h>

#define GPUBNB_WINDOWS_MEDIA_ABI_VERSION 2u
#define GPUBNB_WINDOWS_MEDIA_DIAGNOSTIC_VERSION 1u

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

extern "C" __declspec(dllexport)
void __stdcall GPUbnbMediaClose(GPUbnbMediaSession* session);
