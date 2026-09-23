#include "Media.h"

#include <Windows.h>
#include <SetupAPI.h>
#include <initguid.h>
#include <devpkey.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <nvEncodeAPI.h>
#include <roapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <cwchar>
#include <memory>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace
{
constexpr uint32_t kMinWidth = 640;
constexpr uint32_t kMaxWidth = 7680;
constexpr uint32_t kMinHeight = 480;
constexpr uint32_t kMaxHeight = 4320;
constexpr uint32_t kMinRefresh = 30;
constexpr uint32_t kMaxRefresh = 240;
constexpr uint32_t kMaxCaptureTimeoutMs = 30'000;
constexpr uint32_t kMaxCudaDevices = 256;
constexpr uint32_t kLoadLibrarySearchSystem32 = 0x00000800;
constexpr int kDisplayDiscoveryAttempts = 50;
constexpr DWORD kDisplayDiscoveryRetryDelayMs = 100;

thread_local GPUbnbMediaDiagnostic g_lastMediaDiagnostic = {};

void ResetMediaDiagnostic(const GPUbnbMediaProbeRequest& request)
{
    g_lastMediaDiagnostic = {};
    g_lastMediaDiagnostic.Size = sizeof(g_lastMediaDiagnostic);
    g_lastMediaDiagnostic.Version = GPUBNB_WINDOWS_MEDIA_DIAGNOSTIC_VERSION;
    g_lastMediaDiagnostic.Hresult = S_OK;
    g_lastMediaDiagnostic.NvencStatus = NV_ENC_SUCCESS;
    g_lastMediaDiagnostic.RenderAdapterLuid = request.RenderAdapterLuid;
    g_lastMediaDiagnostic.Width = request.Width;
    g_lastMediaDiagnostic.Height = request.Height;
    g_lastMediaDiagnostic.RefreshHz = request.RefreshHz;
}

void SetMediaProofFlags(uint32_t proofFlags)
{
    g_lastMediaDiagnostic.ProofFlags = proofFlags;
}

HRESULT RecordMediaFailure(
    uint32_t stage,
    HRESULT hr,
    NVENCSTATUS nvencStatus = NV_ENC_SUCCESS)
{
    g_lastMediaDiagnostic.FailedStage = stage;
    g_lastMediaDiagnostic.Hresult = static_cast<int32_t>(hr);
    g_lastMediaDiagnostic.NvencStatus = static_cast<int32_t>(nvencStatus);
    return hr;
}

void RecordMediaSuccess()
{
    g_lastMediaDiagnostic.FailedStage = GPUBNB_MEDIA_STAGE_NONE;
    g_lastMediaDiagnostic.Hresult = S_OK;
    g_lastMediaDiagnostic.NvencStatus = NV_ENC_SUCCESS;
}

bool IsZero(const uint8_t* bytes, size_t size)
{
    for (size_t index = 0; index < size; ++index)
    {
        if (bytes[index] != 0)
        {
            return false;
        }
    }
    return true;
}

bool LuidEqual(const LUID& left, const LUID& right)
{
    return left.LowPart == right.LowPart && left.HighPart == right.HighPart;
}

GUID ContainerIdFromNonce(const uint8_t nonce[16])
{
    GUID value = {};
    static_assert(sizeof(value) == 16);
    std::memcpy(&value, nonce, sizeof(value));
    value.Data3 = static_cast<USHORT>((value.Data3 & 0x0FFFu) | 0x4000u);
    value.Data4[0] = static_cast<uint8_t>((value.Data4[0] & 0x3Fu) | 0x80u);
    return value;
}

HRESULT ValidateRequest(const GPUbnbMediaProbeRequest& request)
{
    if (request.Size != sizeof(GPUbnbMediaProbeRequest) ||
        request.Version != GPUBNB_WINDOWS_MEDIA_ABI_VERSION ||
        (request.RenderAdapterLuid.LowPart == 0 && request.RenderAdapterLuid.HighPart == 0) ||
        IsZero(request.ExpectedGpuUuid, sizeof(request.ExpectedGpuUuid)) ||
        IsZero(request.DisplayNonce, sizeof(request.DisplayNonce)) ||
        request.Width < kMinWidth ||
        request.Width > kMaxWidth ||
        request.Height < kMinHeight ||
        request.Height > kMaxHeight ||
        request.RefreshHz < kMinRefresh ||
        request.RefreshHz > kMaxRefresh ||
        request.CaptureTimeoutMs == 0 ||
        request.CaptureTimeoutMs > kMaxCaptureTimeoutMs)
    {
        return E_INVALIDARG;
    }
    return S_OK;
}

class DeviceInfoSet
{
public:
    DeviceInfoSet() : value_(SetupDiCreateDeviceInfoList(nullptr, nullptr)) {}
    ~DeviceInfoSet()
    {
        if (value_ != INVALID_HANDLE_VALUE)
        {
            SetupDiDestroyDeviceInfoList(value_);
        }
    }
    DeviceInfoSet(const DeviceInfoSet&) = delete;
    DeviceInfoSet& operator=(const DeviceInfoSet&) = delete;
    HDEVINFO get() const { return value_; }

private:
    HDEVINFO value_;
};

HRESULT ContainerIdForMonitorPath(const wchar_t* path, GUID* containerId)
{
    if (path == nullptr || path[0] == L'\0' || containerId == nullptr)
    {
        return E_INVALIDARG;
    }

    DeviceInfoSet set;
    if (set.get() == INVALID_HANDLE_VALUE)
    {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    SP_DEVICE_INTERFACE_DATA interfaceData = {};
    interfaceData.cbSize = sizeof(interfaceData);
    if (!SetupDiOpenDeviceInterfaceW(set.get(), path, 0, &interfaceData))
    {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    DWORD required = 0;
    SetupDiGetDeviceInterfaceDetailW(
        set.get(),
        &interfaceData,
        nullptr,
        0,
        &required,
        nullptr);
    if (required < sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W))
    {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    std::vector<uint8_t> detailBytes(required);
    auto* detail =
        reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(detailBytes.data());
    detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);

    SP_DEVINFO_DATA deviceInfo = {};
    deviceInfo.cbSize = sizeof(deviceInfo);
    if (!SetupDiGetDeviceInterfaceDetailW(
            set.get(),
            &interfaceData,
            detail,
            required,
            nullptr,
            &deviceInfo))
    {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    DEVPROPTYPE propertyType = 0;
    DWORD propertySize = 0;
    GUID value = {};
    if (!SetupDiGetDevicePropertyW(
            set.get(),
            &deviceInfo,
            &DEVPKEY_Device_ContainerId,
            &propertyType,
            reinterpret_cast<PBYTE>(&value),
            sizeof(value),
            &propertySize,
            0))
    {
        return HRESULT_FROM_WIN32(GetLastError());
    }
    if (propertyType != DEVPROP_TYPE_GUID || propertySize != sizeof(value))
    {
        return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
    }

    *containerId = value;
    return S_OK;
}

struct DisplayTarget
{
    std::wstring gdiDeviceName;
    LUID adapterLuid = {};
    UINT32 refreshNumerator = 0;
    UINT32 refreshDenominator = 0;
};

bool RefreshMatches(const DisplayTarget& target, uint32_t expectedHz)
{
    if (target.refreshNumerator == 0 || target.refreshDenominator == 0)
    {
        return false;
    }
    const uint64_t left =
        static_cast<uint64_t>(target.refreshNumerator);
    const uint64_t right =
        static_cast<uint64_t>(expectedHz) *
        static_cast<uint64_t>(target.refreshDenominator);
    return left == right;
}

HRESULT FindDisplayTarget(
    const GUID& expectedContainerId,
    uint32_t expectedRefreshHz,
    DisplayTarget* target)
{
    if (target == nullptr)
    {
        return E_POINTER;
    }

    // IddCx monitor arrival and publication into the active Windows display
    // topology are not observed atomically by user mode. Poll for a bounded
    // five-second window instead of treating the first empty topology scan as
    // a permanent failure.
    for (int attempt = 0; attempt < kDisplayDiscoveryAttempts; ++attempt)
    {
        UINT32 pathCount = 0;
        UINT32 modeCount = 0;
        LONG status = GetDisplayConfigBufferSizes(
            QDC_ONLY_ACTIVE_PATHS,
            &pathCount,
            &modeCount);
        if (status != ERROR_SUCCESS)
        {
            return HRESULT_FROM_WIN32(status);
        }

        std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
        std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
        status = QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &pathCount,
            paths.data(),
            &modeCount,
            modes.data(),
            nullptr);
        if (status == ERROR_INSUFFICIENT_BUFFER)
        {
            if (attempt + 1 == kDisplayDiscoveryAttempts)
            {
                return HRESULT_FROM_WIN32(ERROR_RETRY);
            }
            continue;
        }
        if (status != ERROR_SUCCESS)
        {
            return HRESULT_FROM_WIN32(status);
        }
        paths.resize(pathCount);

        for (const auto& path : paths)
        {
            if ((path.flags & DISPLAYCONFIG_PATH_ACTIVE) == 0 ||
                path.targetInfo.rotation != DISPLAYCONFIG_ROTATION_IDENTITY)
            {
                continue;
            }

            DISPLAYCONFIG_TARGET_DEVICE_NAME targetName = {};
            targetName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            targetName.header.size = sizeof(targetName);
            targetName.header.adapterId = path.targetInfo.adapterId;
            targetName.header.id = path.targetInfo.id;
            status = DisplayConfigGetDeviceInfo(&targetName.header);
            if (status != ERROR_SUCCESS || targetName.monitorDevicePath[0] == L'\0')
            {
                continue;
            }

            GUID containerId = {};
            if (FAILED(ContainerIdForMonitorPath(
                    targetName.monitorDevicePath,
                    &containerId)) ||
                !IsEqualGUID(containerId, expectedContainerId))
            {
                continue;
            }

            DISPLAYCONFIG_SOURCE_DEVICE_NAME sourceName = {};
            sourceName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            sourceName.header.size = sizeof(sourceName);
            sourceName.header.adapterId = path.sourceInfo.adapterId;
            sourceName.header.id = path.sourceInfo.id;
            status = DisplayConfigGetDeviceInfo(&sourceName.header);
            if (status != ERROR_SUCCESS || sourceName.viewGdiDeviceName[0] == L'\0')
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
            }

            DisplayTarget candidate;
            candidate.gdiDeviceName = sourceName.viewGdiDeviceName;
            candidate.adapterLuid = path.targetInfo.adapterId;
            candidate.refreshNumerator = path.targetInfo.refreshRate.Numerator;
            candidate.refreshDenominator = path.targetInfo.refreshRate.Denominator;
            if (!RefreshMatches(candidate, expectedRefreshHz))
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
            }

            *target = std::move(candidate);
            return S_OK;
        }

        if (attempt + 1 < kDisplayDiscoveryAttempts)
        {
            Sleep(kDisplayDiscoveryRetryDelayMs);
        }
    }

    return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

class Module
{
public:
    explicit Module(const wchar_t* name)
        : value_(LoadLibraryExW(name, nullptr, kLoadLibrarySearchSystem32))
    {
    }
    ~Module()
    {
        if (value_ != nullptr)
        {
            FreeLibrary(value_);
        }
    }
    Module(const Module&) = delete;
    Module& operator=(const Module&) = delete;
    HMODULE get() const { return value_; }

private:
    HMODULE value_;
};

template <typename T>
T Proc(HMODULE module, const char* name)
{
    return reinterpret_cast<T>(GetProcAddress(module, name));
}

using CUresult = int;
using CUdevice = int;
struct CUuuid
{
    uint8_t bytes[16];
};
using CuInit = CUresult(WINAPI*)(unsigned int);
using CuDeviceGetCount = CUresult(WINAPI*)(int*);
using CuDeviceGet = CUresult(WINAPI*)(CUdevice*, int);
using CuDeviceGetUuid = CUresult(WINAPI*)(CUuuid*, CUdevice);
using CuDeviceGetLuid = CUresult(WINAPI*)(char*, unsigned int*, CUdevice);
constexpr CUresult CUDA_SUCCESS = 0;

HRESULT VerifyExactGpu(
    const uint8_t expectedUuid[16],
    const LUID& expectedLuid)
{
    Module cuda(L"nvcuda.dll");
    if (cuda.get() == nullptr)
    {
        return HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND);
    }

    const auto cuInit = Proc<CuInit>(cuda.get(), "cuInit");
    const auto cuDeviceGetCount =
        Proc<CuDeviceGetCount>(cuda.get(), "cuDeviceGetCount");
    const auto cuDeviceGet =
        Proc<CuDeviceGet>(cuda.get(), "cuDeviceGet");
    auto cuDeviceGetUuid =
        Proc<CuDeviceGetUuid>(cuda.get(), "cuDeviceGetUuid_v2");
    if (cuDeviceGetUuid == nullptr)
    {
        cuDeviceGetUuid =
            Proc<CuDeviceGetUuid>(cuda.get(), "cuDeviceGetUuid");
    }
    const auto cuDeviceGetLuid =
        Proc<CuDeviceGetLuid>(cuda.get(), "cuDeviceGetLuid");
    if (cuInit == nullptr ||
        cuDeviceGetCount == nullptr ||
        cuDeviceGet == nullptr ||
        cuDeviceGetUuid == nullptr ||
        cuDeviceGetLuid == nullptr)
    {
        return HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
    }

    if (cuInit(0) != CUDA_SUCCESS)
    {
        return E_FAIL;
    }

    int count = 0;
    if (cuDeviceGetCount(&count) != CUDA_SUCCESS ||
        count < 0 ||
        count > static_cast<int>(kMaxCudaDevices))
    {
        return E_FAIL;
    }

    for (int ordinal = 0; ordinal < count; ++ordinal)
    {
        CUdevice device = 0;
        CUuuid uuid = {};
        if (cuDeviceGet(&device, ordinal) != CUDA_SUCCESS ||
            cuDeviceGetUuid(&uuid, device) != CUDA_SUCCESS)
        {
            return E_FAIL;
        }
        if (std::memcmp(uuid.bytes, expectedUuid, sizeof(uuid.bytes)) != 0)
        {
            continue;
        }

        char luidBytes[8] = {};
        unsigned int nodeMask = 0;
        if (cuDeviceGetLuid(luidBytes, &nodeMask, device) != CUDA_SUCCESS)
        {
            return E_FAIL;
        }
        LUID luid = {};
        static_assert(sizeof(luid) == sizeof(luidBytes));
        std::memcpy(&luid, luidBytes, sizeof(luid));
        return LuidEqual(luid, expectedLuid)
            ? S_OK
            : HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED);
    }

    return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

HRESULT FindDxgiMonitor(
    const DisplayTarget& target,
    HMONITOR* monitor)
{
    if (monitor == nullptr)
    {
        return E_POINTER;
    }
    *monitor = nullptr;

    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr))
    {
        return hr;
    }

    for (UINT adapterIndex = 0;; ++adapterIndex)
    {
        ComPtr<IDXGIAdapter1> candidateAdapter;
        hr = factory->EnumAdapters1(adapterIndex, &candidateAdapter);
        if (hr == DXGI_ERROR_NOT_FOUND)
        {
            break;
        }
        if (FAILED(hr))
        {
            return hr;
        }

        // DisplayConfig proves the exact nonce-bound GPUbnb monitor and gives
        // its session-local GDI source name. Do not pre-filter by DisplayConfig
        // adapter LUID: an indirect display's topology adapter and preferred
        // render adapter are distinct identities.
        for (UINT outputIndex = 0;; ++outputIndex)
        {
            ComPtr<IDXGIOutput> candidateOutput;
            hr = candidateAdapter->EnumOutputs(outputIndex, &candidateOutput);
            if (hr == DXGI_ERROR_NOT_FOUND)
            {
                break;
            }
            if (FAILED(hr))
            {
                return hr;
            }

            DXGI_OUTPUT_DESC outputDesc = {};
            hr = candidateOutput->GetDesc(&outputDesc);
            if (FAILED(hr))
            {
                return hr;
            }
            if (_wcsicmp(outputDesc.DeviceName, target.gdiDeviceName.c_str()) != 0)
            {
                continue;
            }
            if (outputDesc.Monitor == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
            }

            *monitor = outputDesc.Monitor;
            return S_OK;
        }
    }

    return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

HRESULT CreateRenderDeviceForLuid(
    const LUID& renderAdapterLuid,
    ID3D11Device** device,
    ID3D11DeviceContext** context)
{
    if (device == nullptr || context == nullptr)
    {
        return E_POINTER;
    }

    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr))
    {
        return hr;
    }

    for (UINT index = 0;; ++index)
    {
        ComPtr<IDXGIAdapter1> adapter;
        hr = factory->EnumAdapters1(index, &adapter);
        if (hr == DXGI_ERROR_NOT_FOUND)
        {
            break;
        }
        if (FAILED(hr))
        {
            return hr;
        }

        DXGI_ADAPTER_DESC1 desc = {};
        hr = adapter->GetDesc1(&desc);
        if (FAILED(hr))
        {
            return hr;
        }
        if (!LuidEqual(desc.AdapterLuid, renderAdapterLuid))
        {
            continue;
        }

        D3D_FEATURE_LEVEL featureLevel = {};
        return D3D11CreateDevice(
            adapter.Get(),
            D3D_DRIVER_TYPE_UNKNOWN,
            nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr,
            0,
            D3D11_SDK_VERSION,
            device,
            &featureLevel,
            context);
    }

    return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

HRESULT DeviceLuid(ID3D11Device* device, LUID* luid)
{
    if (device == nullptr || luid == nullptr)
    {
        return E_POINTER;
    }

    ComPtr<IDXGIDevice> dxgiDevice;
    HRESULT hr = device->QueryInterface(IID_PPV_ARGS(&dxgiDevice));
    if (FAILED(hr))
    {
        return hr;
    }

    ComPtr<IDXGIAdapter> adapter;
    hr = dxgiDevice->GetAdapter(&adapter);
    if (FAILED(hr))
    {
        return hr;
    }

    DXGI_ADAPTER_DESC desc = {};
    hr = adapter->GetDesc(&desc);
    if (FAILED(hr))
    {
        return hr;
    }

    *luid = desc.AdapterLuid;
    return S_OK;
}

class RoApartment
{
public:
    HRESULT Initialize()
    {
        if (attempted_)
        {
            return S_OK;
        }
        attempted_ = true;

        const HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
        if (SUCCEEDED(hr))
        {
            initialized_ = true;
            return S_OK;
        }
        // A caller may already have initialized this thread as STA. Keep that
        // valid apartment instead of changing it; CreateFreeThreaded removes the
        // capture frame pool's DispatcherQueue dependency.
        return hr == RPC_E_CHANGED_MODE ? S_OK : hr;
    }

    ~RoApartment()
    {
        if (initialized_)
        {
            RoUninitialize();
        }
    }

    RoApartment(const RoApartment&) = delete;
    RoApartment& operator=(const RoApartment&) = delete;

private:
    bool attempted_ = false;
    bool initialized_ = false;
};

class MonitorCapture
{
public:
    ~MonitorCapture()
    {
        Reset();
    }

    HRESULT Initialize(
        HMONITOR monitor,
        ID3D11Device* device,
        uint32_t width,
        uint32_t height)
    {
        if (monitor == nullptr || device == nullptr || width == 0 || height == 0)
        {
            return E_INVALIDARG;
        }

        HRESULT hr = apartment_.Initialize();
        if (FAILED(hr))
        {
            return hr;
        }

        try
        {
            using namespace winrt::Windows::Graphics;
            using namespace winrt::Windows::Graphics::Capture;
            using namespace winrt::Windows::Graphics::DirectX;
            using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

            if (!GraphicsCaptureSession::IsSupported())
            {
                return DXGI_ERROR_UNSUPPORTED;
            }

            auto activation =
                winrt::get_activation_factory<GraphicsCaptureItem>();
            auto interop = activation.as<IGraphicsCaptureItemInterop>();

            GraphicsCaptureItem item{ nullptr };
            hr = interop->CreateForMonitor(
                monitor,
                winrt::guid_of<GraphicsCaptureItem>(),
                reinterpret_cast<void**>(winrt::put_abi(item)));
            if (FAILED(hr))
            {
                return hr;
            }

            const SizeInt32 size = item.Size();
            if (size.Width != static_cast<int32_t>(width) ||
                size.Height != static_cast<int32_t>(height))
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
            }

            ComPtr<IDXGIDevice> dxgiDevice;
            hr = device->QueryInterface(IID_PPV_ARGS(&dxgiDevice));
            if (FAILED(hr))
            {
                return hr;
            }

            winrt::com_ptr<::IInspectable> inspectable;
            hr = CreateDirect3D11DeviceFromDXGIDevice(
                dxgiDevice.Get(),
                inspectable.put());
            if (FAILED(hr))
            {
                return hr;
            }

            const IDirect3DDevice winrtDevice =
                inspectable.as<IDirect3DDevice>();
            framePool_ = Direct3D11CaptureFramePool::CreateFreeThreaded(
                winrtDevice,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                size);
            session_ = framePool_.CreateCaptureSession(item);
            item_ = item;
            width_ = width;
            height_ = height;
            session_.StartCapture();
            return S_OK;
        }
        catch (const winrt::hresult_error& error)
        {
            Reset();
            return error.code().value;
        }
        catch (...)
        {
            Reset();
            return E_FAIL;
        }
    }

    HRESULT AcquireNextFrame(
        uint32_t timeoutMs,
        ComPtr<ID3D11Texture2D>* texture)
    {
        if (texture == nullptr)
        {
            return E_POINTER;
        }
        texture->Reset();
        if (!framePool_)
        {
            return E_UNEXPECTED;
        }

        const ULONGLONG started = GetTickCount64();
        for (;;)
        {
            try
            {
                auto frame = framePool_.TryGetNextFrame();
                if (frame)
                {
                    const auto size = frame.ContentSize();
                    if (size.Width != static_cast<int32_t>(width_) ||
                        size.Height != static_cast<int32_t>(height_))
                    {
                        frame.Close();
                        return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                    }

                    auto surface = frame.Surface();
                    auto access =
                        surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
                    HRESULT hr = access->GetInterface(
                        __uuidof(ID3D11Texture2D),
                        reinterpret_cast<void**>(texture->GetAddressOf()));
                    frame.Close();
                    if (FAILED(hr))
                    {
                        return hr;
                    }
                    if (!*texture)
                    {
                        return E_FAIL;
                    }
                    return S_OK;
                }
            }
            catch (const winrt::hresult_error& error)
            {
                return error.code().value;
            }
            catch (...)
            {
                return E_FAIL;
            }

            if (GetTickCount64() - started >= timeoutMs)
            {
                return DXGI_ERROR_WAIT_TIMEOUT;
            }
            Sleep(5);
        }
    }

private:
    void Reset() noexcept
    {
        try
        {
            if (session_)
            {
                session_.Close();
            }
        }
        catch (...)
        {
        }
        session_ = nullptr;

        try
        {
            if (framePool_)
            {
                framePool_.Close();
            }
        }
        catch (...)
        {
        }
        framePool_ = nullptr;
        item_ = nullptr;
        width_ = 0;
        height_ = 0;
    }

    RoApartment apartment_;
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{ nullptr };
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool_{ nullptr };
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{ nullptr };
    uint32_t width_ = 0;
    uint32_t height_ = 0;
};

HRESULT CopyCaptureTexture(
    ID3D11Device* device,
    ID3D11DeviceContext* context,
    ID3D11Texture2D* source,
    const LUID& expectedRenderLuid,
    uint32_t width,
    uint32_t height,
    ComPtr<ID3D11Texture2D>* owned)
{
    if (device == nullptr ||
        context == nullptr ||
        source == nullptr ||
        owned == nullptr)
    {
        return E_POINTER;
    }

    D3D11_TEXTURE2D_DESC sourceDesc = {};
    source->GetDesc(&sourceDesc);
    if (sourceDesc.Width != width ||
        sourceDesc.Height != height ||
        sourceDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
        sourceDesc.SampleDesc.Count != 1)
    {
        return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
    }

    ComPtr<ID3D11Device> sourceDevice;
    source->GetDevice(&sourceDevice);
    LUID sourceLuid = {};
    HRESULT hr = DeviceLuid(sourceDevice.Get(), &sourceLuid);
    if (FAILED(hr))
    {
        return hr;
    }
    if (!LuidEqual(sourceLuid, expectedRenderLuid))
    {
        return HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED);
    }

    LUID destinationLuid = {};
    hr = DeviceLuid(device, &destinationLuid);
    if (FAILED(hr))
    {
        return hr;
    }
    if (!LuidEqual(destinationLuid, expectedRenderLuid))
    {
        return HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED);
    }

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;

    owned->Reset();
    hr = device->CreateTexture2D(&desc, nullptr, owned->GetAddressOf());
    if (FAILED(hr))
    {
        return hr;
    }

    context->CopyResource(owned->Get(), source);
    context->Flush();
    return S_OK;
}

class NvencEncoder
{
public:
    ~NvencEncoder()
    {
        Reset();
    }

    HRESULT Initialize(
        ID3D11Device* device,
        uint32_t width,
        uint32_t height,
        uint32_t refreshHz)
    {
        if (device == nullptr)
        {
            return RecordMediaFailure(GPUBNB_MEDIA_STAGE_NVENC_SESSION, E_POINTER);
        }

        module_ = LoadLibraryExW(
            L"nvEncodeAPI64.dll",
            nullptr,
            kLoadLibrarySearchSystem32);
        if (module_ == nullptr)
        {
            const DWORD error = GetLastError();
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_LOAD,
                HRESULT_FROM_WIN32(error == ERROR_SUCCESS ? ERROR_MOD_NOT_FOUND : error));
        }

        using GetMaxVersion =
            NVENCSTATUS(NVENCAPI*)(uint32_t*);
        using CreateInstance =
            NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);

        const auto getMaxVersion =
            Proc<GetMaxVersion>(module_, "NvEncodeAPIGetMaxSupportedVersion");
        const auto createInstance =
            Proc<CreateInstance>(module_, "NvEncodeAPICreateInstance");
        if (getMaxVersion == nullptr || createInstance == nullptr)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_LOAD,
                HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND));
        }

        uint32_t maxVersion = 0;
        const NVENCSTATUS maxVersionStatus = getMaxVersion(&maxVersion);
        if (maxVersionStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_LOAD,
                E_FAIL,
                maxVersionStatus);
        }
        if (NVENCAPI_VERSION > maxVersion)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_LOAD,
                HRESULT_FROM_WIN32(ERROR_REVISION_MISMATCH));
        }

        functions_ = {};
        functions_.version = NV_ENCODE_API_FUNCTION_LIST_VER;
        const NVENCSTATUS createStatus = createInstance(&functions_);
        if (createStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_LOAD,
                E_FAIL,
                createStatus);
        }

        NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {
            NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER
        };
        open.device = device;
        open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
        open.apiVersion = NVENCAPI_VERSION;
        const NVENCSTATUS openStatus =
            functions_.nvEncOpenEncodeSessionEx(&open, &encoder_);
        if (openStatus != NV_ENC_SUCCESS || encoder_ == nullptr)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_SESSION,
                E_FAIL,
                openStatus);
        }

        NV_ENC_PRESET_CONFIG preset = { NV_ENC_PRESET_CONFIG_VER };
        preset.presetCfg.version = NV_ENC_CONFIG_VER;
        const NVENCSTATUS presetStatus =
            functions_.nvEncGetEncodePresetConfigEx(
                encoder_,
                NV_ENC_CODEC_H264_GUID,
                NV_ENC_PRESET_P1_GUID,
                NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
                &preset);
        if (presetStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_SESSION,
                E_FAIL,
                presetStatus);
        }

        config_ = preset.presetCfg;
        config_.version = NV_ENC_CONFIG_VER;
        config_.gopLength = NVENC_INFINITE_GOPLENGTH;
        config_.frameIntervalP = 1;

        NV_ENC_INITIALIZE_PARAMS initialize = {
            NV_ENC_INITIALIZE_PARAMS_VER
        };
        initialize.encodeGUID = NV_ENC_CODEC_H264_GUID;
        initialize.presetGUID = NV_ENC_PRESET_P1_GUID;
        initialize.encodeWidth = width;
        initialize.encodeHeight = height;
        initialize.darWidth = width;
        initialize.darHeight = height;
        initialize.frameRateNum = refreshHz;
        initialize.frameRateDen = 1;
        initialize.enablePTD = 1;
        initialize.enableEncodeAsync = 0;
        initialize.enableOutputInVidmem = 0;
        initialize.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
        initialize.encodeConfig = &config_;
        const NVENCSTATUS initializeStatus =
            functions_.nvEncInitializeEncoder(encoder_, &initialize);
        if (initializeStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_SESSION,
                E_FAIL,
                initializeStatus);
        }

        NV_ENC_CREATE_BITSTREAM_BUFFER bitstream = {
            NV_ENC_CREATE_BITSTREAM_BUFFER_VER
        };
        const NVENCSTATUS bitstreamStatus =
            functions_.nvEncCreateBitstreamBuffer(encoder_, &bitstream);
        if (bitstreamStatus != NV_ENC_SUCCESS ||
            bitstream.bitstreamBuffer == nullptr)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_SESSION,
                E_FAIL,
                bitstreamStatus);
        }
        bitstream_ = bitstream.bitstreamBuffer;
        return S_OK;
    }

    HRESULT Encode(
        ID3D11Texture2D* texture,
        uint32_t width,
        uint32_t height,
        uint32_t* encodedBytes,
        std::vector<uint8_t>* output = nullptr,
        uint32_t* frameFlags = nullptr)
    {
        if (texture == nullptr || encodedBytes == nullptr || encoder_ == nullptr)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_INVALIDARG);
        }
        *encodedBytes = 0;
        if (frameFlags != nullptr)
        {
            *frameFlags = 0;
        }

        NV_ENC_REGISTER_RESOURCE registration = {
            NV_ENC_REGISTER_RESOURCE_VER
        };
        registration.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
        registration.width = width;
        registration.height = height;
        registration.resourceToRegister = texture;
        registration.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB;
        registration.bufferUsage = NV_ENC_INPUT_IMAGE;
        const NVENCSTATUS registerStatus =
            functions_.nvEncRegisterResource(encoder_, &registration);
        if (registerStatus != NV_ENC_SUCCESS ||
            registration.registeredResource == nullptr)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL,
                registerStatus);
        }
        registered_ = registration.registeredResource;

        NV_ENC_MAP_INPUT_RESOURCE mapping = {
            NV_ENC_MAP_INPUT_RESOURCE_VER
        };
        mapping.registeredResource = registered_;
        const NVENCSTATUS mapStatus =
            functions_.nvEncMapInputResource(encoder_, &mapping);
        if (mapStatus != NV_ENC_SUCCESS ||
            mapping.mappedResource == nullptr)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL,
                mapStatus);
        }
        mapped_ = mapping.mappedResource;

        NV_ENC_PIC_PARAMS picture = { NV_ENC_PIC_PARAMS_VER };
        picture.inputBuffer = mapped_;
        picture.bufferFmt = mapping.mappedBufferFmt;
        picture.inputWidth = width;
        picture.inputHeight = height;
        picture.outputBitstream = bitstream_;
        picture.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        picture.encodePicFlags = forceIdrNext_
            ? (NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS)
            : 0;

        const NVENCSTATUS encodeStatus =
            functions_.nvEncEncodePicture(encoder_, &picture);
        if (encodeStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL,
                encodeStatus);
        }

        NV_ENC_LOCK_BITSTREAM lock = { NV_ENC_LOCK_BITSTREAM_VER };
        lock.outputBitstream = bitstream_;
        lock.doNotWait = 0;
        const NVENCSTATUS lockStatus =
            functions_.nvEncLockBitstream(encoder_, &lock);
        if (lockStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL,
                lockStatus);
        }
        locked_ = true;

        if (lock.bitstreamBufferPtr == nullptr ||
            lock.bitstreamSizeInBytes == 0)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL);
        }
        *encodedBytes = lock.bitstreamSizeInBytes;
        const bool keyframe = lock.pictureType == NV_ENC_PIC_TYPE_IDR;
        if (output != nullptr)
        {
            const auto* begin =
                static_cast<const uint8_t*>(lock.bitstreamBufferPtr);
            output->assign(begin, begin + lock.bitstreamSizeInBytes);
        }

        const NVENCSTATUS unlockStatus =
            functions_.nvEncUnlockBitstream(encoder_, bitstream_);
        if (unlockStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL,
                unlockStatus);
        }
        locked_ = false;

        const NVENCSTATUS unmapStatus =
            functions_.nvEncUnmapInputResource(encoder_, mapped_);
        if (unmapStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL,
                unmapStatus);
        }
        mapped_ = nullptr;

        const NVENCSTATUS unregisterStatus =
            functions_.nvEncUnregisterResource(encoder_, registered_);
        if (unregisterStatus != NV_ENC_SUCCESS)
        {
            return RecordMediaFailure(
                GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
                E_FAIL,
                unregisterStatus);
        }
        registered_ = nullptr;

        if (frameFlags != nullptr)
        {
            *frameFlags = keyframe ? GPUBNB_MEDIA_FRAME_KEYFRAME : 0;
        }
        forceIdrNext_ = false;
        return S_OK;
    }

private:
    void Reset()
    {
        if (encoder_ != nullptr)
        {
            if (locked_ && bitstream_ != nullptr)
            {
                functions_.nvEncUnlockBitstream(encoder_, bitstream_);
            }
            locked_ = false;
            if (mapped_ != nullptr)
            {
                functions_.nvEncUnmapInputResource(encoder_, mapped_);
                mapped_ = nullptr;
            }
            if (registered_ != nullptr)
            {
                functions_.nvEncUnregisterResource(encoder_, registered_);
                registered_ = nullptr;
            }
            if (bitstream_ != nullptr)
            {
                functions_.nvEncDestroyBitstreamBuffer(encoder_, bitstream_);
                bitstream_ = nullptr;
            }
            functions_.nvEncDestroyEncoder(encoder_);
            encoder_ = nullptr;
        }
        if (module_ != nullptr)
        {
            FreeLibrary(module_);
            module_ = nullptr;
        }
        forceIdrNext_ = true;
    }

    HMODULE module_ = nullptr;
    NV_ENCODE_API_FUNCTION_LIST functions_ = {};
    NV_ENC_CONFIG config_ = {};
    void* encoder_ = nullptr;
    NV_ENC_OUTPUT_PTR bitstream_ = nullptr;
    NV_ENC_REGISTERED_PTR registered_ = nullptr;
    NV_ENC_INPUT_PTR mapped_ = nullptr;
    bool locked_ = false;
    bool forceIdrNext_ = true;
};

void InitializeResult(
    const GPUbnbMediaProbeRequest& request,
    GPUbnbMediaProbeResult* result)
{
    *result = {};
    result->Size = sizeof(*result);
    result->Version = GPUBNB_WINDOWS_MEDIA_ABI_VERSION;
    result->RenderAdapterLuid = request.RenderAdapterLuid;
    result->Width = request.Width;
    result->Height = request.Height;
    result->RefreshHz = request.RefreshHz;
}
} // namespace

struct GPUbnbMediaSession
{
    GPUbnbMediaProbeRequest request = {};
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    HMONITOR monitor = nullptr;
    MonitorCapture capture;
    NvencEncoder encoder;
    uint64_t frameSequence = 0;
};

namespace
{
void InitializeFrameResult(
    const GPUbnbMediaProbeRequest& request,
    GPUbnbMediaFrameResult* result)
{
    *result = {};
    result->Size = sizeof(*result);
    result->Version = GPUBNB_WINDOWS_MEDIA_ABI_VERSION;
    result->RenderAdapterLuid = request.RenderAdapterLuid;
    result->Width = request.Width;
    result->Height = request.Height;
    result->RefreshHz = request.RefreshHz;
}

HRESULT BuildPersistentSession(
    const GPUbnbMediaProbeRequest& request,
    GPUbnbMediaSession* session)
{
    HRESULT hr = VerifyExactGpu(
        request.ExpectedGpuUuid,
        request.RenderAdapterLuid);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_EXACT_GPU, hr);
    }
    SetMediaProofFlags(GPUBNB_MEDIA_PROOF_EXACT_GPU);

    DisplayTarget display;
    hr = FindDisplayTarget(
        ContainerIdFromNonce(request.DisplayNonce),
        request.RefreshHz,
        &display);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DISPLAY, hr);
    }
    SetMediaProofFlags(
        GPUBNB_MEDIA_PROOF_EXACT_GPU |
        GPUBNB_MEDIA_PROOF_DISPLAY_FOUND);

    hr = FindDxgiMonitor(display, &session->monitor);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DISPLAY, hr);
    }

    hr = CreateRenderDeviceForLuid(
        request.RenderAdapterLuid,
        &session->device,
        &session->context);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_D3D11, hr);
    }

    LUID deviceLuid = {};
    hr = DeviceLuid(session->device.Get(), &deviceLuid);
    if (FAILED(hr) || !LuidEqual(deviceLuid, request.RenderAdapterLuid))
    {
        return RecordMediaFailure(
            GPUBNB_MEDIA_STAGE_D3D11,
            FAILED(hr) ? hr : HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED));
    }

    hr = session->capture.Initialize(
        session->monitor,
        session->device.Get(),
        request.Width,
        request.Height);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_CAPTURE_SESSION, hr);
    }

    hr = session->encoder.Initialize(
        session->device.Get(),
        request.Width,
        request.Height,
        request.RefreshHz);
    if (FAILED(hr))
    {
        return hr;
    }

    session->request = request;
    RecordMediaSuccess();
    return S_OK;
}

HRESULT CaptureAndEncode(
    GPUbnbMediaSession* session,
    std::vector<uint8_t>* output,
    uint32_t* encodedBytes,
    uint32_t* frameFlags,
    uint32_t* proofFlags,
    uint64_t* frameSequence)
{
    if (session == nullptr ||
        encodedBytes == nullptr ||
        frameFlags == nullptr ||
        proofFlags == nullptr ||
        frameSequence == nullptr)
    {
        return E_POINTER;
    }

    *encodedBytes = 0;
    *frameFlags = 0;
    *proofFlags =
        GPUBNB_MEDIA_PROOF_EXACT_GPU |
        GPUBNB_MEDIA_PROOF_DISPLAY_FOUND;
    *frameSequence = 0;
    SetMediaProofFlags(*proofFlags);

    ComPtr<ID3D11Texture2D> captured;
    HRESULT hr = session->capture.AcquireNextFrame(
        session->request.CaptureTimeoutMs,
        &captured);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_CAPTURE, hr);
    }

    ComPtr<ID3D11Texture2D> owned;
    hr = CopyCaptureTexture(
        session->device.Get(),
        session->context.Get(),
        captured.Get(),
        session->request.RenderAdapterLuid,
        session->request.Width,
        session->request.Height,
        &owned);
    captured.Reset();
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_CAPTURE, hr);
    }

    *proofFlags |= GPUBNB_MEDIA_PROOF_CAPTURED_FRAME;
    SetMediaProofFlags(*proofFlags);

    hr = VerifyExactGpu(
        session->request.ExpectedGpuUuid,
        session->request.RenderAdapterLuid);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_EXACT_GPU, hr);
    }

    const HRESULT deviceReason = session->device->GetDeviceRemovedReason();
    if (FAILED(deviceReason))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_D3D11, deviceReason);
    }

    hr = session->encoder.Encode(
        owned.Get(),
        session->request.Width,
        session->request.Height,
        encodedBytes,
        output,
        frameFlags);
    if (FAILED(hr) || *encodedBytes == 0)
    {
        return FAILED(hr)
            ? hr
            : RecordMediaFailure(GPUBNB_MEDIA_STAGE_NVENC_ENCODE, E_FAIL);
    }

    *proofFlags |= GPUBNB_MEDIA_PROOF_NVENC_BITSTREAM;
    SetMediaProofFlags(*proofFlags);
    *frameSequence = ++session->frameSequence;
    RecordMediaSuccess();
    return S_OK;
}
} // namespace

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbProbeMediaFrame(
    const GPUbnbMediaProbeRequest* request,
    GPUbnbMediaProbeResult* result)
{
    if (request == nullptr || result == nullptr)
    {
        return E_POINTER;
    }

    ResetMediaDiagnostic(*request);
    InitializeResult(*request, result);
    result->FailedStage = GPUBNB_MEDIA_STAGE_VALIDATE;
    HRESULT hr = ValidateRequest(*request);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_VALIDATE, hr);
    }

    GPUbnbMediaSession session;
    hr = BuildPersistentSession(*request, &session);
    if (FAILED(hr))
    {
        result->FailedStage = g_lastMediaDiagnostic.FailedStage;
        result->ProofFlags = g_lastMediaDiagnostic.ProofFlags;
        return hr;
    }

    uint32_t encodedBytes = 0;
    uint32_t frameFlags = 0;
    uint32_t proofFlags = 0;
    uint64_t frameSequence = 0;
    hr = CaptureAndEncode(
        &session,
        nullptr,
        &encodedBytes,
        &frameFlags,
        &proofFlags,
        &frameSequence);
    if (FAILED(hr))
    {
        result->FailedStage = g_lastMediaDiagnostic.FailedStage;
        result->ProofFlags = g_lastMediaDiagnostic.ProofFlags;
        return hr;
    }

    result->ProofFlags = proofFlags;
    result->FailedStage = GPUBNB_MEDIA_STAGE_NONE;
    result->EncodedBytes = encodedBytes;
    result->FrameSequence = frameSequence;
    return S_OK;
}


extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbMediaOpen(
    const GPUbnbMediaProbeRequest* request,
    GPUbnbMediaSession** session)
{
    if (request == nullptr || session == nullptr)
    {
        return E_POINTER;
    }
    *session = nullptr;

    ResetMediaDiagnostic(*request);
    HRESULT hr = ValidateRequest(*request);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_VALIDATE, hr);
    }

    auto value = std::make_unique<GPUbnbMediaSession>();
    hr = BuildPersistentSession(*request, value.get());
    if (FAILED(hr))
    {
        return hr;
    }

    *session = value.release();
    RecordMediaSuccess();
    return S_OK;
}

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbMediaReadFrame(
    GPUbnbMediaSession* session,
    uint8_t* bitstream,
    uint32_t bitstreamCapacity,
    GPUbnbMediaFrameResult* result)
{
    if (session == nullptr || result == nullptr)
    {
        return E_POINTER;
    }

    ResetMediaDiagnostic(session->request);
    InitializeFrameResult(session->request, result);

    uint32_t encodedBytes = 0;
    uint32_t frameFlags = 0;
    uint32_t proofFlags = 0;
    uint64_t frameSequence = 0;
    std::vector<uint8_t> encoded;
    HRESULT hr = CaptureAndEncode(
        session,
        &encoded,
        &encodedBytes,
        &frameFlags,
        &proofFlags,
        &frameSequence);
    if (FAILED(hr))
    {
        result->FailedStage = g_lastMediaDiagnostic.FailedStage;
        result->ProofFlags = g_lastMediaDiagnostic.ProofFlags;
        return hr;
    }

    result->EncodedBytes = encodedBytes;
    result->RequiredCapacity = encodedBytes;
    result->FrameFlags = frameFlags;
    result->FrameSequence = frameSequence;
    result->ProofFlags = proofFlags;
    result->FailedStage = GPUBNB_MEDIA_STAGE_NONE;

    if (encoded.size() != encodedBytes)
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_NVENC_ENCODE, E_FAIL);
    }
    if (bitstream == nullptr || bitstreamCapacity < encodedBytes)
    {
        return RecordMediaFailure(
            GPUBNB_MEDIA_STAGE_NVENC_ENCODE,
            HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    }

    std::memcpy(bitstream, encoded.data(), encodedBytes);
    RecordMediaSuccess();
    return S_OK;
}


extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbMediaGetLastDiagnostic(GPUbnbMediaDiagnostic* diagnostic)
{
    if (diagnostic == nullptr)
    {
        return E_POINTER;
    }
    if (g_lastMediaDiagnostic.Size != sizeof(g_lastMediaDiagnostic) ||
        g_lastMediaDiagnostic.Version != GPUBNB_WINDOWS_MEDIA_DIAGNOSTIC_VERSION)
    {
        return HRESULT_FROM_WIN32(ERROR_NOT_READY);
    }
    *diagnostic = g_lastMediaDiagnostic;
    return S_OK;
}

extern "C" __declspec(dllexport)
void __stdcall GPUbnbMediaClose(GPUbnbMediaSession* session)
{
    delete session;
}
