#pragma once

#include <windows.h>

#define GPUBNB_IDD_CONTROL_VERSION 1u
#define GPUBNB_IDD_DISPLAY_NONCE_SIZE 16u
#define GPUBNB_IDD_CONTROL_REQUEST_SIZE 64u

enum class GPUbnbIddControlOperation : UINT32
{
    PlugMonitor = 1u,
    UnplugMonitor = 2u,
};

struct GPUbnbIddControlRequest
{
    UINT32 Size;
    UINT32 Version;
    UINT32 Operation;
    UINT32 WindowsSessionId;
    UINT64 Generation;
    LUID RenderAdapterLuid;
    UCHAR DisplayNonce[GPUBNB_IDD_DISPLAY_NONCE_SIZE];
    UINT32 Width;
    UINT32 Height;
    UINT32 RefreshHz;
    UINT32 Reserved;
};

static_assert(sizeof(GPUbnbIddControlRequest) == GPUBNB_IDD_CONTROL_REQUEST_SIZE,
    "GPUbnb IddCx control ABI must remain stable");
