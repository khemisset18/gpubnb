#include "SwapChainProcessor.h"

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

static bool GPUbnbLuidEqual(_In_ LUID left, _In_ LUID right)
{
    return left.LowPart == right.LowPart && left.HighPart == right.HighPart;
}

static HRESULT GPUbnbCreateDeviceForAdapter(
    _In_ LUID targetLuid,
    _Out_ ComPtr<ID3D11Device>& device,
    _Out_ ComPtr<IDXGIDevice>& dxgiDevice)
{
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr))
    {
        return hr;
    }

    ComPtr<IDXGIAdapter1> selected;
    for (UINT index = 0;; ++index)
    {
        ComPtr<IDXGIAdapter1> candidate;
        hr = factory->EnumAdapters1(index, &candidate);
        if (hr == DXGI_ERROR_NOT_FOUND)
        {
            break;
        }
        if (FAILED(hr))
        {
            return hr;
        }

        DXGI_ADAPTER_DESC1 desc = {};
        hr = candidate->GetDesc1(&desc);
        if (FAILED(hr))
        {
            return hr;
        }
        if (GPUbnbLuidEqual(desc.AdapterLuid, targetLuid))
        {
            selected = candidate;
            break;
        }
    }

    if (!selected)
    {
        return DXGI_ERROR_NOT_FOUND;
    }

    D3D_FEATURE_LEVEL featureLevel = D3D_FEATURE_LEVEL_11_0;
    ComPtr<ID3D11DeviceContext> context;
    hr = D3D11CreateDevice(
        selected.Get(),
        D3D_DRIVER_TYPE_UNKNOWN,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        &device,
        &featureLevel,
        &context);
    if (FAILED(hr))
    {
        return hr;
    }

    return device.As(&dxgiDevice);
}

static DWORD WINAPI GPUbnbSwapChainThread(_In_ LPVOID parameter)
{
    auto* processor = reinterpret_cast<GPUbnbSwapChainProcessor*>(parameter);
    if (processor == nullptr)
    {
        return ERROR_INVALID_PARAMETER;
    }

    ComPtr<ID3D11Device> device;
    ComPtr<IDXGIDevice> dxgiDevice;
    HRESULT hr = GPUbnbCreateDeviceForAdapter(
        processor->RenderAdapterLuid,
        device,
        dxgiDevice);
    if (FAILED(hr))
    {
        WdfObjectDelete(reinterpret_cast<WDFOBJECT>(processor->SwapChain));
        processor->SwapChain = nullptr;
        return static_cast<DWORD>(hr);
    }

    IDARG_IN_SWAPCHAINSETDEVICE setDevice = {};
    setDevice.pDevice = dxgiDevice.Get();
    hr = IddCxSwapChainSetDevice(processor->SwapChain, &setDevice);
    if (FAILED(hr))
    {
        WdfObjectDelete(reinterpret_cast<WDFOBJECT>(processor->SwapChain));
        processor->SwapChain = nullptr;
        return static_cast<DWORD>(hr);
    }

    const HANDLE waits[] = {
        processor->NewFrameEvent,
        processor->StopEvent,
    };

    for (;;)
    {
        IDARG_OUT_RELEASEANDACQUIREBUFFER buffer = {};
        hr = IddCxSwapChainReleaseAndAcquireBuffer(processor->SwapChain, &buffer);
        if (hr == E_PENDING)
        {
            const DWORD wait = WaitForMultipleObjects(
                ARRAYSIZE(waits),
                waits,
                FALSE,
                16);
            if (wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT)
            {
                continue;
            }
            if (wait == WAIT_OBJECT_0 + 1)
            {
                break;
            }
            break;
        }

        if (FAILED(hr))
        {
            break;
        }

        ComPtr<IDXGIResource> acquired;
        acquired.Attach(buffer.MetaData.pSurface);
        if (!acquired)
        {
            break;
        }

        ComPtr<ID3D11Texture2D> texture;
        hr = acquired.As(&texture);
        if (FAILED(hr))
        {
            break;
        }

        D3D11_TEXTURE2D_DESC desc = {};
        texture->GetDesc(&desc);
        if (desc.Width != processor->Width || desc.Height != processor->Height)
        {
            break;
        }

        // No READY proof is emitted here. This stage only proves that the OS
        // delivered a real frame on the exact render adapter and expected mode.
        // NVENC must consume this surface before graphics readiness can succeed.
        texture.Reset();
        acquired.Reset();

        hr = IddCxSwapChainFinishedProcessingFrame(processor->SwapChain);
        if (FAILED(hr))
        {
            break;
        }
    }

    WdfObjectDelete(reinterpret_cast<WDFOBJECT>(processor->SwapChain));
    processor->SwapChain = nullptr;
    return 0;
}

NTSTATUS GPUbnbStartSwapChainProcessor(
    _In_ IDDCX_SWAPCHAIN swapChain,
    _In_ HANDLE newFrameEvent,
    _In_ LUID renderAdapterLuid,
    _In_ UINT32 width,
    _In_ UINT32 height,
    _Outptr_ GPUbnbSwapChainProcessor** processor)
{
    if (swapChain == nullptr ||
        newFrameEvent == nullptr ||
        processor == nullptr ||
        width == 0 ||
        height == 0 ||
        (renderAdapterLuid.LowPart == 0 && renderAdapterLuid.HighPart == 0))
    {
        return STATUS_INVALID_PARAMETER;
    }

    *processor = nullptr;
    auto* value = static_cast<GPUbnbSwapChainProcessor*>(
        HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(GPUbnbSwapChainProcessor)));
    if (value == nullptr)
    {
        return STATUS_NO_MEMORY;
    }

    value->SwapChain = swapChain;
    value->NewFrameEvent = newFrameEvent;
    value->RenderAdapterLuid = renderAdapterLuid;
    value->Width = width;
    value->Height = height;
    value->StopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (value->StopEvent == nullptr)
    {
        HeapFree(GetProcessHeap(), 0, value);
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    value->Thread = CreateThread(
        nullptr,
        0,
        GPUbnbSwapChainThread,
        value,
        0,
        nullptr);
    if (value->Thread == nullptr)
    {
        CloseHandle(value->StopEvent);
        value->StopEvent = nullptr;
        HeapFree(GetProcessHeap(), 0, value);
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    *processor = value;
    return STATUS_SUCCESS;
}

VOID GPUbnbStopSwapChainProcessor(
    _Inout_opt_ GPUbnbSwapChainProcessor** processor)
{
    if (processor == nullptr || *processor == nullptr)
    {
        return;
    }

    auto* value = *processor;
    if (value->StopEvent != nullptr)
    {
        SetEvent(value->StopEvent);
    }
    if (value->Thread != nullptr)
    {
        WaitForSingleObject(value->Thread, INFINITE);
        CloseHandle(value->Thread);
        value->Thread = nullptr;
    }
    if (value->StopEvent != nullptr)
    {
        CloseHandle(value->StopEvent);
        value->StopEvent = nullptr;
    }
    HeapFree(GetProcessHeap(), 0, value);
    *processor = nullptr;
}
