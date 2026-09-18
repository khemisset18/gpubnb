#pragma once

#include <windows.h>

#define GPUBNB_IDD_CONTROL_VERSION 1u
#define GPUBNB_IDD_DISPLAY_NONCE_SIZE 16u
#define GPUBNB_IDD_CONTROL_REQUEST_SIZE 64u
#define IOCTL_GPUBNB_IDD_CONTROL CTL_CODE(FILE_DEVICE_UNKNOWN, 0x800, METHOD_BUFFERED, FILE_WRITE_DATA)

EXTERN_C const GUID GUID_DEVINTERFACE_GPUBNB_IDD_CONTROL;

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
