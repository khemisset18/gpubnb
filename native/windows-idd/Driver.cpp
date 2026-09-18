#include "Driver.h"

EXTERN_C const GUID GUID_DEVINTERFACE_GPUBNB_IDD_CONTROL =
{ 0x3f4c6f31, 0x4e7c, 0x4de7, { 0x9f, 0xd8, 0x72, 0x18, 0xb3, 0x88, 0x1a, 0x55 } };

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
        request->Operation != static_cast<UINT32>(GPUbnbIddControlOperation::UnplugMonitor))
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
                    // Validation-only milestone. A valid request must not create,
                    // remove or mutate a monitor until service authentication,
                    // monitor ownership and physical qualification are complete.
                    status = STATUS_NOT_SUPPORTED;
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
    UNREFERENCED_PARAMETER(monitor);
    UNREFERENCED_PARAMETER(input);
    output->DefaultMonitorModeBufferOutputCount = 0;
    output->PreferredMonitorModeIdx = 0;
    return STATUS_NOT_SUPPORTED;
}

_Use_decl_annotations_
NTSTATUS GPUbnbMonitorQueryTargetModes(
    IDDCX_MONITOR monitor,
    const IDARG_IN_QUERYTARGETMODES* input,
    IDARG_OUT_QUERYTARGETMODES* output)
{
    UNREFERENCED_PARAMETER(monitor);
    UNREFERENCED_PARAMETER(input);
    output->TargetModeBufferOutputCount = 0;
    return STATUS_NOT_SUPPORTED;
}

_Use_decl_annotations_
NTSTATUS GPUbnbMonitorAssignSwapChain(
    IDDCX_MONITOR monitor,
    const IDARG_IN_SETSWAPCHAIN* input)
{
    UNREFERENCED_PARAMETER(monitor);
    if (input != nullptr && input->hSwapChain != nullptr)
    {
        WdfObjectDelete(reinterpret_cast<WDFOBJECT>(input->hSwapChain));
    }
    return STATUS_NOT_SUPPORTED;
}

_Use_decl_annotations_
NTSTATUS GPUbnbMonitorUnassignSwapChain(IDDCX_MONITOR monitor)
{
    UNREFERENCED_PARAMETER(monitor);
    return STATUS_SUCCESS;
}
