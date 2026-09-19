#pragma once

#define NOMINMAX
#include <windows.h>
#include <wdf.h>
#include <iddcx.h>

struct GPUbnbSwapChainProcessor
{
    IDDCX_SWAPCHAIN SwapChain;
    HANDLE NewFrameEvent;
    HANDLE StopEvent;
    HANDLE Thread;
    LUID RenderAdapterLuid;
    UINT32 Width;
    UINT32 Height;
};

NTSTATUS GPUbnbStartSwapChainProcessor(
    _In_ IDDCX_SWAPCHAIN swapChain,
    _In_ HANDLE newFrameEvent,
    _In_ LUID renderAdapterLuid,
    _In_ UINT32 width,
    _In_ UINT32 height,
    _Outptr_ GPUbnbSwapChainProcessor** processor);

VOID GPUbnbStopSwapChainProcessor(
    _Inout_opt_ GPUbnbSwapChainProcessor** processor);
