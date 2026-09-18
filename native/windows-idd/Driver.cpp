#include "Driver.h"

EXTERN_C const GUID GUID_DEVINTERFACE_GPUBNB_IDD_CONTROL =
{ 0x3f4c6f31, 0x4e7c, 0x4de7, { 0x9f, 0xd8, 0x72, 0x18, 0xb3, 0x88, 0x1a, 0x55 } };

// Physical qualification gate. Keep real monitor mutation compiled so WDK/ABI
// regressions are caught, but make it unreachable in production behavior until
// GPUbnb explicitly promotes a physically qualified build.
static constexpr bool GPUBNB_ENABLE_MONITOR_MUTATION = false;

static void GPUbnbFillSignalInfo(
    _Out_ DISPLAYCONFIG_VIDEO_SIGNAL_INFO* mode,
    _In_ UINT32 width,
    _In_ UINT32 height,
    _In_ UINT32 refreshHz,
    _In_ bool monitorMode)
{
    RtlZeroMemory(mode, sizeof(*mode));
    mode->totalSize.cx = mode->activeSize.cx = width;
    mode->totalSize.cy = mode->activeSize.cy = height;
    mode->AdditionalSignalInfo.vSyncFreqDivider = monitorMode ? 0 : 1;
    mode->AdditionalSignalInfo.videoStandard = 255;
    mode->vSyncFreq.Numerator = refreshHz;
    mode->vSyncFreq.Denominator = 1;
    mode->hSyncFreq.Numerator = refreshHz * height;
    mode->hSyncFreq.Denominator = 1;
    mode->scanLineOrdering = DISPLAYCONFIG_SCANLINE_ORDERING_PROGRESSIVE;
    mode->pixelRate =
        static_cast<UINT64>(refreshHz) *
        static_cast<UINT64>(width) *
        static_cast<UINT64>(height);
}

static IDDCX_MONITOR_MODE GPUbnbCreateMonitorMode(
    _In_ UINT32 width,
    _In_ UINT32 height,
    _In_ UINT32 refreshHz)
{
    IDDCX_MONITOR_MODE mode = {};
    mode.Size = sizeof(mode);
    mode.Origin = IDDCX_MONITOR_MODE_ORIGIN_DRIVER;
    GPUbnbFillSignalInfo(&mode.MonitorVideoSignalInfo, width, height, refreshHz, true);
    return mode;
}

static IDDCX_TARGET_MODE GPUbnbCreateTargetMode(
    _In_ UINT32 width,
    _In_ UINT32 height,
    _In_ UINT32 refreshHz)
{
    IDDCX_TARGET_MODE mode = {};
    mode.Size = sizeof(mode);
    GPUbnbFillSignalInfo(
        &mode.TargetVideoSignalInfo.targetVideoSignalInfo,
        width,
        height,
        refreshHz,
        false);
    return mode;
}

static bool GPUbnbLuidEqual(_In_ LUID left, _In_ LUID right)
{
    return left.LowPart == right.LowPart && left.HighPart == right.HighPart;
}

static GUID GPUbnbContainerIdFromNonce(_In_reads_(GPUBNB_IDD_DISPLAY_NONCE_SIZE) const UCHAR* nonce)
{
    GUID value = {};
    RtlCopyMemory(&value, nonce, sizeof(value));
    value.Data3 = static_cast<USHORT>((value.Data3 & 0x0FFFu) | 0x4000u);
    value.Data4[0] = static_cast<UCHAR>((value.Data4[0] & 0x3Fu) | 0x80u);
    return value;
}

static NTSTATUS GPUbnbPlugMonitor(
    _In_ WDFDEVICE device,
    _In_ const GPUbnbIddControlRequest* request)
{
    auto* deviceContext = WdfObjectGet_GPUbnbDeviceContext(device);
    if (deviceContext->Adapter == nullptr)
    {
        return STATUS_DEVICE_NOT_READY;
    }
    if (deviceContext->Monitor != nullptr)
    {
        return STATUS_DEVICE_BUSY;
    }

    WDF_OBJECT_ATTRIBUTES monitorAttributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&monitorAttributes, GPUbnbMonitorContext);

    IDDCX_MONITOR_INFO monitorInfo = {};
    monitorInfo.Size = sizeof(monitorInfo);
    monitorInfo.MonitorType = DISPLAYCONFIG_OUTPUT_TECHNOLOGY_OTHER;
    monitorInfo.ConnectorIndex = 0;
    monitorInfo.MonitorDescription.Size = sizeof(monitorInfo.MonitorDescription);
    monitorInfo.MonitorDescription.Type = IDDCX_MONITOR_DESCRIPTION_TYPE_EDID;
    monitorInfo.MonitorDescription.DataSize = 0;
    monitorInfo.MonitorDescription.pData = nullptr;
    monitorInfo.MonitorContainerId = GPUbnbContainerIdFromNonce(request->DisplayNonce);

    IDARG_IN_MONITORCREATE input = {};
    input.ObjectAttributes = &monitorAttributes;
    input.pMonitorInfo = &monitorInfo;

    IDARG_OUT_MONITORCREATE output = {};
    NTSTATUS status = IddCxMonitorCreate(deviceContext->Adapter, &input, &output);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    auto* monitorContext = WdfObjectGet_GPUbnbMonitorContext(output.MonitorObject);
    monitorContext->Device = device;
    monitorContext->Width = request->Width;
    monitorContext->Height = request->Height;
    monitorContext->RefreshHz = request->RefreshHz;
    monitorContext->RenderAdapterLuid = request->RenderAdapterLuid;
    monitorContext->WindowsSessionId = request->WindowsSessionId;
    monitorContext->Generation = request->Generation;
    RtlCopyMemory(
        monitorContext->DisplayNonce,
        request->DisplayNonce,
        GPUBNB_IDD_DISPLAY_NONCE_SIZE);

    IDARG_OUT_MONITORARRIVAL arrival = {};
    status = IddCxMonitorArrival(output.MonitorObject, &arrival);
    if (!NT_SUCCESS(status))
    {
        WdfObjectDelete(output.MonitorObject);
        return status;
    }

    deviceContext->Monitor = output.MonitorObject;
    return STATUS_SUCCESS;
}

static NTSTATUS GPUbnbUnplugMonitor(
    _In_ WDFDEVICE device,
    _In_ const GPUbnbIddControlRequest* request)
{
    auto* deviceContext = WdfObjectGet_GPUbnbDeviceContext(device);
    if (deviceContext->Monitor == nullptr)
    {
        return STATUS_NOT_FOUND;
    }

    auto* monitorContext = WdfObjectGet_GPUbnbMonitorContext(deviceContext->Monitor);
    if (monitorContext->Generation != request->Generation ||
        monitorContext->WindowsSessionId != request->WindowsSessionId ||
        !GPUbnbLuidEqual(monitorContext->RenderAdapterLuid, request->RenderAdapterLuid) ||
        RtlCompareMemory(
            monitorContext->DisplayNonce,
            request->DisplayNonce,
            GPUBNB_IDD_DISPLAY_NONCE_SIZE) != GPUBNB_IDD_DISPLAY_NONCE_SIZE)
    {
        return STATUS_ACCESS_DENIED;
    }

    const IDDCX_MONITOR monitor = deviceContext->Monitor;
    const NTSTATUS status = IddCxMonitorDeparture(monitor);
    if (NT_SUCCESS(status))
    {
        deviceContext->Monitor = nullptr;
    }
    return status;
}

static NTSTATUS GPUbnbValidateControlRequest(
    _In_ const GPUbnbIddControlRequest* request)
{
    if (request == nullptr ||
        request->Size != sizeof(GPUbnbIddControlRequest) ||
        request->Version != GPUBNB_IDD_CONTROL_VERSION ||
        request->Reserved != 0 ||
        request->WindowsSessionId == 0 ||
        request->Generation == 0 ||
        (request->RenderAdapterLuid.LowPart == 0 && request->RenderAdapterLuid.HighPart == 0))
    {
        return STATUS_INVALID_PARAMETER;
    }

    if (request->Operation != static_cast<UINT32>(GPUbnbIddControlOperation::PlugMonitor) &&
        request->Operation != static_cast<UINT32>(GPUbnbIddControlOperation::UnplugMonitor) &&
        request->Operation != static_cast<UINT32>(GPUbnbIddControlOperation::ValidateOnly))
    {
        return STATUS_INVALID_PARAMETER;
    }

    bool noncePresent = false;
    for (UINT32 index = 0; index < GPUBNB_IDD_DISPLAY_NONCE_SIZE; ++index)
    {
        noncePresent = noncePresent || request->DisplayNonce[index] != 0;
    }
    if (!noncePresent)
    {
        return STATUS_INVALID_PARAMETER;
    }

    if (request->Width < 640 || request->Width > 7680 ||
        request->Height < 480 || request->Height > 4320 ||
        request->RefreshHz < 30 || request->RefreshHz > 240)
    {
        return STATUS_INVALID_PARAMETER;
    }

    return STATUS_SUCCESS;
}

extern "C" BOOL WINAPI DllMain(
    _In_ HINSTANCE instance,
    _In_ UINT reason,
    _In_opt_ LPVOID reserved)
{
    UNREFERENCED_PARAMETER(instance);
    UNREFERENCED_PARAMETER(reason);
    UNREFERENCED_PARAMETER(reserved);
    return TRUE;
}

_Use_decl_annotations_
extern "C" NTSTATUS DriverEntry(
    PDRIVER_OBJECT driverObject,
    PUNICODE_STRING registryPath)
{
    WDF_DRIVER_CONFIG config;
    WDF_DRIVER_CONFIG_INIT(&config, GPUbnbDeviceAdd);

    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES_INIT(&attributes);

    return WdfDriverCreate(
        driverObject,
        registryPath,
        &attributes,
        &config,
        WDF_NO_HANDLE);
}

_Use_decl_annotations_
NTSTATUS GPUbnbDeviceAdd(
    WDFDRIVER driver,
    PWDFDEVICE_INIT deviceInit)
{
    UNREFERENCED_PARAMETER(driver);

    WDF_PNPPOWER_EVENT_CALLBACKS powerCallbacks;
    WDF_PNPPOWER_EVENT_CALLBACKS_INIT(&powerCallbacks);
    powerCallbacks.EvtDeviceD0Entry = GPUbnbDeviceD0Entry;
    WdfDeviceInitSetPnpPowerEventCallbacks(deviceInit, &powerCallbacks);

    IDD_CX_CLIENT_CONFIG iddConfig;
    IDD_CX_CLIENT_CONFIG_INIT(&iddConfig);
    iddConfig.EvtIddCxAdapterInitFinished = GPUbnbAdapterInitFinished;
    iddConfig.EvtIddCxAdapterCommitModes = GPUbnbAdapterCommitModes;
    iddConfig.EvtIddCxParseMonitorDescription = GPUbnbParseMonitorDescription;
    iddConfig.EvtIddCxMonitorGetDefaultDescriptionModes = GPUbnbMonitorGetDefaultModes;
    iddConfig.EvtIddCxMonitorQueryTargetModes = GPUbnbMonitorQueryTargetModes;
    iddConfig.EvtIddCxMonitorAssignSwapChain = GPUbnbMonitorAssignSwapChain;
    iddConfig.EvtIddCxMonitorUnassignSwapChain = GPUbnbMonitorUnassignSwapChain;

    NTSTATUS status = IddCxDeviceInitConfig(deviceInit, &iddConfig);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    WDF_OBJECT_ATTRIBUTES deviceAttributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&deviceAttributes, GPUbnbDeviceContext);

    WDFDEVICE device = nullptr;
    status = WdfDeviceCreate(&deviceInit, &deviceAttributes, &device);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    status = IddCxDeviceInitialize(device);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    status = WdfDeviceCreateDeviceInterface(
        device,
        &GUID_DEVINTERFACE_GPUBNB_IDD_CONTROL,
        nullptr);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    WDF_IO_QUEUE_CONFIG queueConfig;
    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig, WdfIoQueueDispatchSequential);
    queueConfig.EvtIoDeviceControl = GPUbnbEvtIoDeviceControl;

    status = WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES, WDF_NO_HANDLE);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    auto* context = WdfObjectGet_GPUbnbDeviceContext(device);
    context->Adapter = nullptr;
    context->Monitor = nullptr;
    return STATUS_SUCCESS;
}

_Use_decl_annotations_
VOID GPUbnbEvtIoDeviceControl(
    WDFQUEUE queue,
    WDFREQUEST request,
    size_t outputBufferLength,
    size_t inputBufferLength,
    ULONG ioControlCode)
{
    UNREFERENCED_PARAMETER(queue);
    UNREFERENCED_PARAMETER(outputBufferLength);

    NTSTATUS status = STATUS_INVALID_DEVICE_REQUEST;
    if (ioControlCode == IOCTL_GPUBNB_IDD_CONTROL &&
        inputBufferLength == sizeof(GPUbnbIddControlRequest))
    {
        GPUbnbIddControlRequest* control = nullptr;
        size_t controlLength = 0;
        status = WdfRequestRetrieveInputBuffer(
            request,
            sizeof(GPUbnbIddControlRequest),
            reinterpret_cast<PVOID*>(&control),
            &controlLength);

        if (NT_SUCCESS(status))
        {
            if (controlLength != sizeof(GPUbnbIddControlRequest))
            {
                status = STATUS_INFO_LENGTH_MISMATCH;
            }
            else
            {
                status = GPUbnbValidateControlRequest(control);
                if (NT_SUCCESS(status))
                {
                    if (control->Operation == static_cast<UINT32>(
                            GPUbnbIddControlOperation::ValidateOnly))
                    {
                        status = STATUS_SUCCESS;
                    }
                    else if (!GPUBNB_ENABLE_MONITOR_MUTATION)
                    {
                        // Fail closed before physical qualification. This gate is
                        // compile-time false and cannot be toggled by a renter,
                        // environment variable, registry value or API request.
                        status = STATUS_NOT_SUPPORTED;
                    }
                    else
                    {
                        WDFDEVICE device = WdfIoQueueGetDevice(queue);
                        status = control->Operation == static_cast<UINT32>(
                                     GPUbnbIddControlOperation::PlugMonitor)
                            ? GPUbnbPlugMonitor(device, control)
                            : GPUbnbUnplugMonitor(device, control);
                    }
                }
            }
        }
    }

    WdfRequestComplete(request, status);
}

_Use_decl_annotations_
NTSTATUS GPUbnbDeviceD0Entry(
    WDFDEVICE device,
    WDF_POWER_DEVICE_STATE previousState)
{
    UNREFERENCED_PARAMETER(previousState);

    auto* context = WdfObjectGet_GPUbnbDeviceContext(device);
    if (context->Adapter != nullptr)
    {
        return STATUS_SUCCESS;
    }

    IDDCX_ADAPTER_CAPS caps = {};
    caps.Size = sizeof(caps);
    caps.MaxMonitorsSupported = 1;
    caps.EndPointDiagnostics.Size = sizeof(caps.EndPointDiagnostics);
    caps.EndPointDiagnostics.GammaSupport = IDDCX_FEATURE_IMPLEMENTATION_NONE;
    caps.EndPointDiagnostics.TransmissionType = IDDCX_TRANSMISSION_TYPE_WIRED_OTHER;
    caps.EndPointDiagnostics.pEndPointFriendlyName = L"GPUbnb Virtual Display Adapter";
    caps.EndPointDiagnostics.pEndPointManufacturerName = L"GPUbnb";
    caps.EndPointDiagnostics.pEndPointModelName = L"GPUbnb Isolated Renter Display";

    IDDCX_ENDPOINT_VERSION version = {};
    version.Size = sizeof(version);
    version.MajorVer = 1;
    version.MinorVer = 0;
    caps.EndPointDiagnostics.pFirmwareVersion = &version;
    caps.EndPointDiagnostics.pHardwareVersion = &version;

    WDF_OBJECT_ATTRIBUTES adapterAttributes;
    WDF_OBJECT_ATTRIBUTES_INIT(&adapterAttributes);

    IDARG_IN_ADAPTER_INIT input = {};
    input.WdfDevice = device;
    input.pCaps = &caps;
    input.ObjectAttributes = &adapterAttributes;

    IDARG_OUT_ADAPTER_INIT output = {};
    const NTSTATUS status = IddCxAdapterInitAsync(&input, &output);
    if (NT_SUCCESS(status))
    {
        context->Adapter = output.AdapterObject;
    }
    return status;
}

_Use_decl_annotations_
NTSTATUS GPUbnbAdapterInitFinished(
    IDDCX_ADAPTER adapter,
    const IDARG_IN_ADAPTER_INIT_FINISHED* input)
{
    UNREFERENCED_PARAMETER(adapter);
    if (!NT_SUCCESS(input->AdapterInitStatus))
    {
        return input->AdapterInitStatus;
    }
    // Fail-closed bootstrap: intentionally report no monitor yet.
    return STATUS_SUCCESS;
}

_Use_decl_annotations_
NTSTATUS GPUbnbAdapterCommitModes(
    IDDCX_ADAPTER adapter,
    const IDARG_IN_COMMITMODES* input)
{
    UNREFERENCED_PARAMETER(adapter);
    UNREFERENCED_PARAMETER(input);
    return STATUS_SUCCESS;
}

_Use_decl_annotations_
NTSTATUS GPUbnbParseMonitorDescription(
    const IDARG_IN_PARSEMONITORDESCRIPTION* input,
    IDARG_OUT_PARSEMONITORDESCRIPTION* output)
{
    UNREFERENCED_PARAMETER(input);
    output->MonitorModeBufferOutputCount = 0;
    return STATUS_NOT_SUPPORTED;
}

_Use_decl_annotations_
NTSTATUS GPUbnbMonitorGetDefaultModes(
    IDDCX_MONITOR monitor,
    const IDARG_IN_GETDEFAULTDESCRIPTIONMODES* input,
    IDARG_OUT_GETDEFAULTDESCRIPTIONMODES* output)
{
    auto* context = WdfObjectGet_GPUbnbMonitorContext(monitor);
    if (input->DefaultMonitorModeBufferInputCount == 0)
    {
        output->DefaultMonitorModeBufferOutputCount = 1;
        output->PreferredMonitorModeIdx = 0;
        return STATUS_SUCCESS;
    }
    if (input->DefaultMonitorModeBufferInputCount < 1 ||
        input->pDefaultMonitorModes == nullptr)
    {
        return STATUS_BUFFER_TOO_SMALL;
    }

    input->pDefaultMonitorModes[0] =
        GPUbnbCreateMonitorMode(context->Width, context->Height, context->RefreshHz);
    output->DefaultMonitorModeBufferOutputCount = 1;
    output->PreferredMonitorModeIdx = 0;
    return STATUS_SUCCESS;
}

_Use_decl_annotations_
NTSTATUS GPUbnbMonitorQueryTargetModes(
    IDDCX_MONITOR monitor,
    const IDARG_IN_QUERYTARGETMODES* input,
    IDARG_OUT_QUERYTARGETMODES* output)
{
    auto* context = WdfObjectGet_GPUbnbMonitorContext(monitor);
    output->TargetModeBufferOutputCount = 1;
    if (input->TargetModeBufferInputCount == 0)
    {
        return STATUS_SUCCESS;
    }
    if (input->TargetModeBufferInputCount < 1 || input->pTargetModes == nullptr)
    {
        return STATUS_BUFFER_TOO_SMALL;
    }

    input->pTargetModes[0] =
        GPUbnbCreateTargetMode(context->Width, context->Height, context->RefreshHz);
    return STATUS_SUCCESS;
}

_Use_decl_annotations_
NTSTATUS GPUbnbMonitorAssignSwapChain(
    IDDCX_MONITOR monitor,
    const IDARG_IN_SETSWAPCHAIN* input)
{
    if (input == nullptr || input->hSwapChain == nullptr)
    {
        return STATUS_INVALID_PARAMETER;
    }

    auto* context = WdfObjectGet_GPUbnbMonitorContext(monitor);
    if (!GPUbnbLuidEqual(input->RenderAdapterLuid, context->RenderAdapterLuid))
    {
        WdfObjectDelete(reinterpret_cast<WDFOBJECT>(input->hSwapChain));
        return STATUS_GRAPHICS_INDIRECT_DISPLAY_ABANDON_SWAPCHAIN;
    }

    // The virtual monitor and exact render-adapter fence are now real. Frame
    // consumption remains fail-closed until the D3D/NVENC processor is attached.
    WdfObjectDelete(reinterpret_cast<WDFOBJECT>(input->hSwapChain));
    return STATUS_GRAPHICS_INDIRECT_DISPLAY_ABANDON_SWAPCHAIN;
}

_Use_decl_annotations_
NTSTATUS GPUbnbMonitorUnassignSwapChain(IDDCX_MONITOR monitor)
{
    UNREFERENCED_PARAMETER(monitor);
    return STATUS_SUCCESS;
}
