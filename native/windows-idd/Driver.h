#pragma once

#define NOMINMAX
#include <windows.h>
#include <wudfwdm.h>
#include <wdf.h>
#include <iddcx.h>
#include "ControlProtocol.h"

struct GPUbnbDeviceContext
{
    IDDCX_ADAPTER Adapter;
};

WDF_DECLARE_CONTEXT_TYPE(GPUbnbDeviceContext);

extern "C" DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD GPUbnbDeviceAdd;
EVT_WDF_DEVICE_D0_ENTRY GPUbnbDeviceD0Entry;

EVT_IDD_CX_ADAPTER_INIT_FINISHED GPUbnbAdapterInitFinished;
EVT_IDD_CX_ADAPTER_COMMIT_MODES GPUbnbAdapterCommitModes;
EVT_IDD_CX_PARSE_MONITOR_DESCRIPTION GPUbnbParseMonitorDescription;
EVT_IDD_CX_MONITOR_GET_DEFAULT_DESCRIPTION_MODES GPUbnbMonitorGetDefaultModes;
EVT_IDD_CX_MONITOR_QUERY_TARGET_MODES GPUbnbMonitorQueryTargetModes;
EVT_IDD_CX_MONITOR_ASSIGN_SWAPCHAIN GPUbnbMonitorAssignSwapChain;
EVT_IDD_CX_MONITOR_UNASSIGN_SWAPCHAIN GPUbnbMonitorUnassignSwapChain;

EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL GPUbnbEvtIoDeviceControl;
