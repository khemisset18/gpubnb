#include "Media.h"

#include <Windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <propvarutil.h>
#include <wrl.h>
#include <wrl/implements.h>

#include <cstring>
#include <memory>
#include <mutex>
#include <new>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

namespace
{
constexpr uint32_t kMinAudioBufferMs = 10;
constexpr uint32_t kMaxAudioBufferMs = 100;
constexpr DWORD kAudioActivationTimeoutMs = 5000;
constexpr DWORD kAudioReadTimeoutMs = 150;
constexpr uint32_t kMinSampleRate = 8000;
constexpr uint32_t kMaxSampleRate = 192000;
constexpr uint16_t kMaxChannels = 8;

class AudioActivationHandler final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler>
{
public:
    HRESULT RuntimeClassInitialize(HANDLE completedEvent)
    {
        if (completedEvent == nullptr) return E_INVALIDARG;
        if (!DuplicateHandle(
                GetCurrentProcess(), completedEvent,
                GetCurrentProcess(), &completedEvent_,
                EVENT_MODIFY_STATE, FALSE, 0))
        {
            return HRESULT_FROM_WIN32(GetLastError());
        }
        return S_OK;
    }

    ~AudioActivationHandler()
    {
        if (completedEvent_ != nullptr) CloseHandle(completedEvent_);
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* operation) override
    {
        HRESULT activationResult = E_FAIL;
        ComPtr<IUnknown> activated;
        const HRESULT resultHr = operation == nullptr
            ? E_POINTER
            : operation->GetActivateResult(&activationResult, &activated);
        if (FAILED(resultHr)) activationResult = resultHr;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            activationResult_ = activationResult;
            activated_ = std::move(activated);
        }
        if (!SetEvent(completedEvent_)) return HRESULT_FROM_WIN32(GetLastError());
        return S_OK;
    }

    HRESULT GetResult(ComPtr<IUnknown>* activated)
    {
        if (activated == nullptr) return E_POINTER;
        std::lock_guard<std::mutex> lock(mutex_);
        *activated = activated_;
        return activationResult_;
    }

private:
    HANDLE completedEvent_ = nullptr;
    std::mutex mutex_;
    HRESULT activationResult_ = E_PENDING;
    ComPtr<IUnknown> activated_;
};

bool SameTokenUser(HANDLE left, HANDLE right)
{
    DWORD leftBytes = 0;
    DWORD rightBytes = 0;
    GetTokenInformation(left, TokenUser, nullptr, 0, &leftBytes);
    GetTokenInformation(right, TokenUser, nullptr, 0, &rightBytes);
    if (leftBytes < sizeof(TOKEN_USER) || rightBytes < sizeof(TOKEN_USER)) return false;

    std::unique_ptr<uint8_t[]> leftBuffer(new (std::nothrow) uint8_t[leftBytes]);
    std::unique_ptr<uint8_t[]> rightBuffer(new (std::nothrow) uint8_t[rightBytes]);
    if (!leftBuffer || !rightBuffer) return false;
    if (!GetTokenInformation(left, TokenUser, leftBuffer.get(), leftBytes, &leftBytes) ||
        !GetTokenInformation(right, TokenUser, rightBuffer.get(), rightBytes, &rightBytes))
    {
        return false;
    }
    const auto* leftUser = reinterpret_cast<const TOKEN_USER*>(leftBuffer.get());
    const auto* rightUser = reinterpret_cast<const TOKEN_USER*>(rightBuffer.get());
    return EqualSid(leftUser->User.Sid, rightUser->User.Sid) == TRUE;
}

HRESULT OpenAuthorizedRenterProcess(
    uint32_t expectedSessionId,
    DWORD expectedProcessId,
    DWORD* processId,
    HANDLE* processHandle)
{
    if (expectedSessionId == 0 || expectedProcessId == 0 ||
        processId == nullptr || processHandle == nullptr)
        return E_INVALIDARG;
    *processId = 0;
    *processHandle = nullptr;

    DWORD workerSessionId = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &workerSessionId))
        return HRESULT_FROM_WIN32(GetLastError());
    if (workerSessionId != expectedSessionId)
        return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);

    HANDLE workerToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &workerToken))
        return HRESULT_FROM_WIN32(GetLastError());
    const auto closeWorkerToken = std::unique_ptr<void, decltype(&CloseHandle)>(
        workerToken, &CloseHandle);

    HANDLE targetProcess = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
        FALSE,
        expectedProcessId);
    if (targetProcess == nullptr) return HRESULT_FROM_WIN32(GetLastError());

    DWORD actualSessionId = 0;
    if (!ProcessIdToSessionId(expectedProcessId, &actualSessionId))
    {
        const DWORD error = GetLastError();
        CloseHandle(targetProcess);
        return HRESULT_FROM_WIN32(error);
    }
    if (actualSessionId != expectedSessionId)
    {
        CloseHandle(targetProcess);
        return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
    }

    HANDLE targetToken = nullptr;
    const bool openedToken = OpenProcessToken(targetProcess, TOKEN_QUERY, &targetToken) != FALSE;
    const bool sameUser = openedToken && SameTokenUser(workerToken, targetToken);
    if (targetToken != nullptr) CloseHandle(targetToken);
    if (!sameUser)
    {
        const DWORD error = openedToken ? ERROR_ACCESS_DENIED : GetLastError();
        CloseHandle(targetProcess);
        return HRESULT_FROM_WIN32(error);
    }
    if (WaitForSingleObject(targetProcess, 0) != WAIT_TIMEOUT)
    {
        CloseHandle(targetProcess);
        return HRESULT_FROM_WIN32(ERROR_PROCESS_ABORTED);
    }
    *processId = expectedProcessId;
    *processHandle = targetProcess;
    return S_OK;
}

HRESULT ResolveSupportedFormat(const WAVEFORMATEX* format, uint16_t* sampleFormat)
{
    if (format == nullptr || sampleFormat == nullptr) return E_POINTER;
    *sampleFormat = 0;
    if (format->nSamplesPerSec < kMinSampleRate || format->nSamplesPerSec > kMaxSampleRate ||
        format->nChannels == 0 || format->nChannels > kMaxChannels ||
        format->nBlockAlign == 0 || format->wBitsPerSample == 0)
    {
        return AUDCLNT_E_UNSUPPORTED_FORMAT;
    }

    GUID subFormat = GUID_NULL;
    WORD validBits = format->wBitsPerSample;
    if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
    {
        if (format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX))
            return AUDCLNT_E_UNSUPPORTED_FORMAT;
        const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
        subFormat = extensible->SubFormat;
        validBits = extensible->Samples.wValidBitsPerSample;
    }

    const bool isFloat = format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
        IsEqualGUID(subFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    const bool isPcm = format->wFormatTag == WAVE_FORMAT_PCM ||
        IsEqualGUID(subFormat, KSDATAFORMAT_SUBTYPE_PCM);
    if (isFloat && format->wBitsPerSample == 32 && validBits == 32)
        *sampleFormat = GPUBNB_AUDIO_SAMPLE_IEEE_FLOAT32;
    else if (isPcm && validBits == format->wBitsPerSample)
    {
        switch (format->wBitsPerSample)
        {
        case 8: *sampleFormat = GPUBNB_AUDIO_SAMPLE_PCM_UINT8; break;
        case 16: *sampleFormat = GPUBNB_AUDIO_SAMPLE_PCM_INT16; break;
        case 24: *sampleFormat = GPUBNB_AUDIO_SAMPLE_PCM_INT24; break;
        case 32: *sampleFormat = GPUBNB_AUDIO_SAMPLE_PCM_INT32; break;
        default: return AUDCLNT_E_UNSUPPORTED_FORMAT;
        }
    }
    else return AUDCLNT_E_UNSUPPORTED_FORMAT;

    const uint32_t expectedBlockAlign =
        static_cast<uint32_t>(format->nChannels) * format->wBitsPerSample / 8;
    if (expectedBlockAlign != format->nBlockAlign)
        return AUDCLNT_E_UNSUPPORTED_FORMAT;
    return S_OK;
}

HRESULT GetWindowsBuildNumber(DWORD* buildNumber)
{
    if (buildNumber == nullptr) return E_POINTER;
    using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) return HRESULT_FROM_WIN32(GetLastError());
    const auto function = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
    if (function == nullptr) return HRESULT_FROM_WIN32(GetLastError());
    OSVERSIONINFOW version = {};
    version.dwOSVersionInfoSize = sizeof(version);
    const LONG status = function(&version);
    if (status < 0) return static_cast<HRESULT>(status);
    *buildNumber = version.dwBuildNumber;
    return S_OK;
}
} // namespace

struct GPUbnbAudioCapture
{
    ~GPUbnbAudioCapture()
    {
        if (started && audioClient) audioClient->Stop();
        audioCapture.Reset();
        audioClient.Reset();
        if (mixFormat != nullptr) CoTaskMemFree(mixFormat);
        if (audioEvent != nullptr) CloseHandle(audioEvent);
        if (targetProcess != nullptr) CloseHandle(targetProcess);
        if (comInitialized) CoUninitialize();
    }

    uint32_t windowsSessionId = 0;
    DWORD targetProcessId = 0;
    DWORD ownerThreadId = 0;
    HANDLE targetProcess = nullptr;
    HANDLE audioEvent = nullptr;
    WAVEFORMATEX* mixFormat = nullptr;
    uint16_t sampleFormat = 0;
    ComPtr<IAudioClient> audioClient;
    ComPtr<IAudioCaptureClient> audioCapture;
    bool comInitialized = false;
    bool started = false;
};

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbAudioOpenForRenterProcess(
    const GPUbnbAudioCaptureRequest* request,
    GPUbnbAudioCapture** capture)
{
    if (request == nullptr || capture == nullptr) return E_POINTER;
    *capture = nullptr;
    if (request->Size != sizeof(GPUbnbAudioCaptureRequest) ||
        request->Version != GPUBNB_WINDOWS_AUDIO_ABI_VERSION ||
        request->WindowsSessionId == 0 ||
        request->TargetProcessId == 0 ||
        request->Reserved != 0 ||
        request->BufferDurationMs < kMinAudioBufferMs ||
        request->BufferDurationMs > kMaxAudioBufferMs)
    {
        return E_INVALIDARG;
    }

    DWORD build = 0;
    HRESULT hr = GetWindowsBuildNumber(&build);
    if (FAILED(hr)) return hr;
    if (build < 20348) return HRESULT_FROM_WIN32(ERROR_OLD_WIN_VERSION);

    hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return hr;
    std::unique_ptr<GPUbnbAudioCapture> value;
    try
    {
        value = std::make_unique<GPUbnbAudioCapture>();
    }
    catch (const std::bad_alloc&)
    {
        CoUninitialize();
        return E_OUTOFMEMORY;
    }
    value->comInitialized = true;
    value->ownerThreadId = GetCurrentThreadId();
    value->windowsSessionId = request->WindowsSessionId;

    hr = OpenAuthorizedRenterProcess(
        request->WindowsSessionId,
        request->TargetProcessId,
        &value->targetProcessId,
        &value->targetProcess);
    if (FAILED(hr)) return hr;

    value->audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (value->audioEvent == nullptr) return HRESULT_FROM_WIN32(GetLastError());
    ComPtr<AudioActivationHandler> handler = Make<AudioActivationHandler>();
    if (!handler) return E_OUTOFMEMORY;
    hr = handler->RuntimeClassInitialize(value->audioEvent);
    if (FAILED(hr)) return hr;

    AUDIOCLIENT_ACTIVATION_PARAMS activation = {};
    activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation.ProcessLoopbackParams.TargetProcessId = value->targetProcessId;
    activation.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activationParameters;
    PropVariantInit(&activationParameters);
    activationParameters.vt = VT_BLOB;
    activationParameters.blob.cbSize = sizeof(activation);
    activationParameters.blob.pBlobData = static_cast<BYTE*>(CoTaskMemAlloc(sizeof(activation)));
    if (activationParameters.blob.pBlobData == nullptr) return E_OUTOFMEMORY;
    std::memcpy(activationParameters.blob.pBlobData, &activation, sizeof(activation));

    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activationParameters,
        handler.Get(),
        &operation);
    PropVariantClear(&activationParameters);
    if (FAILED(hr)) return hr;

    const DWORD wait = WaitForSingleObject(value->audioEvent, kAudioActivationTimeoutMs);
    if (wait != WAIT_OBJECT_0)
        return wait == WAIT_FAILED
            ? HRESULT_FROM_WIN32(GetLastError())
            : HRESULT_FROM_WIN32(WAIT_TIMEOUT);

    ComPtr<IUnknown> activated;
    hr = handler->GetResult(&activated);
    if (FAILED(hr) || !activated) return FAILED(hr) ? hr : E_NOINTERFACE;
    hr = activated.As(&value->audioClient);
    if (FAILED(hr)) return hr;

    hr = value->audioClient->GetMixFormat(&value->mixFormat);
    if (FAILED(hr)) return hr;
    hr = ResolveSupportedFormat(value->mixFormat, &value->sampleFormat);
    if (FAILED(hr)) return hr;

    const REFERENCE_TIME duration =
        static_cast<REFERENCE_TIME>(request->BufferDurationMs) * 10000;
    hr = value->audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK |
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_NOPERSIST,
        duration,
        0,
        value->mixFormat,
        nullptr);
    if (FAILED(hr)) return hr;
    hr = value->audioClient->SetEventHandle(value->audioEvent);
    if (FAILED(hr)) return hr;
    hr = value->audioClient->GetService(IID_PPV_ARGS(&value->audioCapture));
    if (FAILED(hr)) return hr;
    hr = value->audioClient->Start();
    if (FAILED(hr)) return hr;
    value->started = true;
    *capture = value.release();
    return S_OK;
}

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbAudioRead(
    GPUbnbAudioCapture* capture,
    uint8_t* payload,
    uint32_t payloadCapacity,
    GPUbnbAudioPacketResult* result)
{
    if (capture == nullptr || result == nullptr) return E_POINTER;
    *result = {};
    result->Size = static_cast<uint32_t>(sizeof(*result));
    result->Version = GPUBNB_WINDOWS_AUDIO_ABI_VERSION;
    result->WindowsSessionId = capture->windowsSessionId;
    result->TargetProcessId = capture->targetProcessId;
    result->SampleRate = capture->mixFormat->nSamplesPerSec;
    result->Channels = capture->mixFormat->nChannels;
    result->SampleFormat = capture->sampleFormat;
    if (GetCurrentThreadId() != capture->ownerThreadId)
        return RPC_E_WRONG_THREAD;
    if (!capture->started || capture->audioCapture == nullptr || payload == nullptr)
        return E_INVALIDARG;
    if (WaitForSingleObject(capture->targetProcess, 0) != WAIT_TIMEOUT)
        return HRESULT_FROM_WIN32(ERROR_PROCESS_ABORTED);

    const DWORD wait = WaitForSingleObject(capture->audioEvent, kAudioReadTimeoutMs);
    if (wait == WAIT_TIMEOUT) return S_FALSE;
    if (wait != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(GetLastError());

    uint64_t framesCopied = 0;
    uint32_t payloadBytes = 0;
    UINT64 firstDevicePosition = 0;
    UINT64 firstQpcPosition = 0;
    bool haveFirstPosition = false;
    bool allSilent = true;
    for (;;)
    {
        UINT32 packetFrames = 0;
        HRESULT hr = capture->audioCapture->GetNextPacketSize(&packetFrames);
        if (FAILED(hr)) return hr;
        if (packetFrames == 0) break;

        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD bufferFlags = 0;
        UINT64 devicePosition = 0;
        UINT64 qpcPosition = 0;
        hr = capture->audioCapture->GetBuffer(
            &data, &frames, &bufferFlags, &devicePosition, &qpcPosition);
        if (FAILED(hr)) return hr;

        const uint64_t packetBytes64 =
            static_cast<uint64_t>(frames) * capture->mixFormat->nBlockAlign;
        const uint64_t nextPayloadBytes = static_cast<uint64_t>(payloadBytes) + packetBytes64;
        if (frames == 0 || packetBytes64 == 0 ||
            nextPayloadBytes > GPUBNB_AUDIO_PACKET_MAX_BYTES ||
            nextPayloadBytes > payloadCapacity)
        {
            capture->audioCapture->ReleaseBuffer(frames);
            return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
        }
        if (!haveFirstPosition)
        {
            firstDevicePosition = devicePosition;
            firstQpcPosition = qpcPosition;
            haveFirstPosition = true;
        }

        const uint32_t packetBytes = static_cast<uint32_t>(packetBytes64);
        if ((bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
        {
            // 8-bit PCM is unsigned and uses 0x80 as its zero-amplitude value.
            std::memset(
                payload + payloadBytes,
                capture->sampleFormat == GPUBNB_AUDIO_SAMPLE_PCM_UINT8 ? 0x80 : 0,
                packetBytes);
            result->Flags |= GPUBNB_AUDIO_PACKET_SILENT;
        }
        else if (data != nullptr)
        {
            std::memcpy(payload + payloadBytes, data, packetBytes);
            allSilent = false;
        }
        else
        {
            capture->audioCapture->ReleaseBuffer(frames);
            return E_POINTER;
        }
        if ((bufferFlags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0)
            result->Flags |= GPUBNB_AUDIO_PACKET_DISCONTINUITY;

        hr = capture->audioCapture->ReleaseBuffer(frames);
        if (FAILED(hr)) return hr;
        payloadBytes += packetBytes;
        framesCopied += frames;
    }

    if (!haveFirstPosition) return S_FALSE;
    if (allSilent) result->Flags |= GPUBNB_AUDIO_PACKET_SILENT;
    else result->Flags &= ~GPUBNB_AUDIO_PACKET_SILENT;
    result->Frames = static_cast<uint32_t>(framesCopied);
    result->PayloadBytes = payloadBytes;
    result->DevicePositionFrames = firstDevicePosition;
    result->QpcPosition100ns = firstQpcPosition;
    return S_OK;
}

extern "C" __declspec(dllexport)
HRESULT __stdcall GPUbnbAudioClose(GPUbnbAudioCapture* capture)
{
    if (capture == nullptr) return E_INVALIDARG;
    if (GetCurrentThreadId() != capture->ownerThreadId) return RPC_E_WRONG_THREAD;
    delete capture;
    return S_OK;
}
