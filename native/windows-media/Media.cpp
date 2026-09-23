#include "Media.h"

#include <Windows.h>
#include <SetupAPI.h>
#include <initguid.h>
#include <devpkey.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <nvEncodeAPI.h>
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
    const LUID& expectedAdapterLuid,
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
                !LuidEqual(path.targetInfo.adapterId, expectedAdapterLuid) ||
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

HRESULT FindDxgiOutput(
    const DisplayTarget& target,
    ComPtr<IDXGIAdapter1>* adapter,
    ComPtr<IDXGIOutput1>* output)
{
    if (adapter == nullptr || output == nullptr)
    {
        return E_POINTER;
    }

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

        DXGI_ADAPTER_DESC1 adapterDesc = {};
        hr = candidateAdapter->GetDesc1(&adapterDesc);
        if (FAILED(hr) || !LuidEqual(adapterDesc.AdapterLuid, target.adapterLuid))
        {
            continue;
        }

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

            ComPtr<IDXGIOutput1> output1;
            hr = candidateOutput.As(&output1);
            if (FAILED(hr))
            {
                return hr;
            }
            *adapter = candidateAdapter;
            *output = output1;
            return S_OK;
        }

        return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    }

    return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

class DuplicationFrame
{
public:
    explicit DuplicationFrame(IDXGIOutputDuplication* duplication)
        : duplication_(duplication)
    {
    }
    ~DuplicationFrame()
    {
        if (acquired_ && duplication_ != nullptr)
        {
            duplication_->ReleaseFrame();
        }
    }
    void MarkAcquired() { acquired_ = true; }

private:
    IDXGIOutputDuplication* duplication_ = nullptr;
    bool acquired_ = false;
};

HRESULT CreateCaptureDevice(
    IDXGIAdapter1* adapter,
    ID3D11Device** device,
    ID3D11DeviceContext** context)
{
    if (adapter == nullptr || device == nullptr || context == nullptr)
    {
        return E_POINTER;
    }

    D3D_FEATURE_LEVEL featureLevel = {};
    return D3D11CreateDevice(
        adapter,
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
    ComPtr<IDXGIOutputDuplication> duplication;
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
        request.RenderAdapterLuid,
        request.RefreshHz,
        &display);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DISPLAY, hr);
    }

    ComPtr<IDXGIAdapter1> adapter;
    ComPtr<IDXGIOutput1> output;
    hr = FindDxgiOutput(display, &adapter, &output);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DISPLAY, hr);
    }
    SetMediaProofFlags(
        GPUBNB_MEDIA_PROOF_EXACT_GPU |
        GPUBNB_MEDIA_PROOF_DISPLAY_FOUND);

    hr = CreateCaptureDevice(
        adapter.Get(),
        &session->device,
        &session->context);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_D3D11, hr);
    }

    hr = output->DuplicateOutput(
        session->device.Get(),
        &session->duplication);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DUPLICATION, hr);
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

    result->FailedStage = GPUBNB_MEDIA_STAGE_EXACT_GPU;
    hr = VerifyExactGpu(
        request->ExpectedGpuUuid,
        request->RenderAdapterLuid);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_EXACT_GPU, hr);
    }
    result->ProofFlags |= GPUBNB_MEDIA_PROOF_EXACT_GPU;
    SetMediaProofFlags(result->ProofFlags);

    result->FailedStage = GPUBNB_MEDIA_STAGE_DISPLAY;
    DisplayTarget display;
    hr = FindDisplayTarget(
        ContainerIdFromNonce(request->DisplayNonce),
        request->RenderAdapterLuid,
        request->RefreshHz,
        &display);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DISPLAY, hr);
    }
    result->ProofFlags |= GPUBNB_MEDIA_PROOF_DISPLAY_FOUND;
    SetMediaProofFlags(result->ProofFlags);

    ComPtr<IDXGIAdapter1> adapter;
    ComPtr<IDXGIOutput1> output;
    hr = FindDxgiOutput(display, &adapter, &output);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DISPLAY, hr);
    }

    result->FailedStage = GPUBNB_MEDIA_STAGE_D3D11;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    hr = CreateCaptureDevice(adapter.Get(), &device, &context);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_D3D11, hr);
    }

    result->FailedStage = GPUBNB_MEDIA_STAGE_DUPLICATION;
    ComPtr<IDXGIOutputDuplication> duplication;
    hr = output->DuplicateOutput(device.Get(), &duplication);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_DUPLICATION, hr);
    }

    result->FailedStage = GPUBNB_MEDIA_STAGE_CAPTURE;
    DXGI_OUTDUPL_FRAME_INFO frameInfo = {};
    ComPtr<IDXGIResource> frameResource;
    hr = duplication->AcquireNextFrame(
        request->CaptureTimeoutMs,
        &frameInfo,
        &frameResource);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_CAPTURE, hr);
    }
    DuplicationFrame frameGuard(duplication.Get());
    frameGuard.MarkAcquired();

    ComPtr<ID3D11Texture2D> texture;
    hr = frameResource.As(&texture);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_CAPTURE, hr);
    }

    D3D11_TEXTURE2D_DESC textureDesc = {};
    texture->GetDesc(&textureDesc);
    if (textureDesc.Width != request->Width ||
        textureDesc.Height != request->Height ||
        textureDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM)
    {
        return RecordMediaFailure(
            GPUBNB_MEDIA_STAGE_CAPTURE,
            HRESULT_FROM_WIN32(ERROR_INVALID_DATA));
    }

    result->ProofFlags |= GPUBNB_MEDIA_PROOF_CAPTURED_FRAME;
    result->FrameSequence = 1;
    SetMediaProofFlags(result->ProofFlags);

    result->FailedStage = GPUBNB_MEDIA_STAGE_NVENC_LOAD;
    NvencEncoder encoder;
    hr = encoder.Initialize(
        device.Get(),
        request->Width,
        request->Height,
        request->RefreshHz);
    if (FAILED(hr))
    {
        return hr;
    }

    result->FailedStage = GPUBNB_MEDIA_STAGE_NVENC_ENCODE;
    uint32_t encodedBytes = 0;
    hr = encoder.Encode(
        texture.Get(),
        request->Width,
        request->Height,
        &encodedBytes);
    if (FAILED(hr) || encodedBytes == 0)
    {
        return FAILED(hr)
            ? hr
            : RecordMediaFailure(GPUBNB_MEDIA_STAGE_NVENC_ENCODE, E_FAIL);
    }

    result->EncodedBytes = encodedBytes;
    result->ProofFlags |= GPUBNB_MEDIA_PROOF_NVENC_BITSTREAM;
    result->FailedStage = GPUBNB_MEDIA_STAGE_NONE;
    SetMediaProofFlags(result->ProofFlags);
    RecordMediaSuccess();
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
    result->ProofFlags =
        GPUBNB_MEDIA_PROOF_EXACT_GPU |
        GPUBNB_MEDIA_PROOF_DISPLAY_FOUND;
    SetMediaProofFlags(result->ProofFlags);
    result->FailedStage = GPUBNB_MEDIA_STAGE_CAPTURE;

    DXGI_OUTDUPL_FRAME_INFO frameInfo = {};
    ComPtr<IDXGIResource> frameResource;
    HRESULT hr = session->duplication->AcquireNextFrame(
        session->request.CaptureTimeoutMs,
        &frameInfo,
        &frameResource);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_CAPTURE, hr);
    }
    DuplicationFrame frameGuard(session->duplication.Get());
    frameGuard.MarkAcquired();

    ComPtr<ID3D11Texture2D> texture;
    hr = frameResource.As(&texture);
    if (FAILED(hr))
    {
        return RecordMediaFailure(GPUBNB_MEDIA_STAGE_CAPTURE, hr);
    }

    D3D11_TEXTURE2D_DESC desc = {};
    texture->GetDesc(&desc);
    if (desc.Width != session->request.Width ||
        desc.Height != session->request.Height ||
        desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM)
    {
        return RecordMediaFailure(
            GPUBNB_MEDIA_STAGE_CAPTURE,
            HRESULT_FROM_WIN32(ERROR_INVALID_DATA));
    }
    result->ProofFlags |= GPUBNB_MEDIA_PROOF_CAPTURED_FRAME;
    SetMediaProofFlags(result->ProofFlags);

    result->FailedStage = GPUBNB_MEDIA_STAGE_EXACT_GPU;
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

    result->FailedStage = GPUBNB_MEDIA_STAGE_NVENC_ENCODE;
    uint32_t encodedBytes = 0;
    uint32_t frameFlags = 0;
    std::vector<uint8_t> encoded;
    hr = session->encoder.Encode(
        texture.Get(),
        session->request.Width,
        session->request.Height,
        &encodedBytes,
        &encoded,
        &frameFlags);
    if (FAILED(hr) || encodedBytes == 0 || encoded.size() != encodedBytes)
    {
        return FAILED(hr)
            ? hr
            : RecordMediaFailure(GPUBNB_MEDIA_STAGE_NVENC_ENCODE, E_FAIL);
    }

    result->EncodedBytes = encodedBytes;
    result->RequiredCapacity = encodedBytes;
    result->FrameFlags = frameFlags;
    result->FrameSequence = ++session->frameSequence;
    result->ProofFlags |= GPUBNB_MEDIA_PROOF_NVENC_BITSTREAM;
    result->FailedStage = GPUBNB_MEDIA_STAGE_NONE;
    SetMediaProofFlags(result->ProofFlags);

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
