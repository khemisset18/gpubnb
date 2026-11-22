// Read-only provenance query. No GPU, display or session initialization.
#include "Media.h"

#include <string>

#ifndef GPUBNB_SOURCE_COMMIT
#define GPUBNB_SOURCE_COMMIT "unconfigured"
#endif

extern "C" __declspec(dllexport) const char* __cdecl GPUbnbMediaBuildIdentity()
{
    static const std::string identity =
        std::string("{\"sourceCommit\":\"") + GPUBNB_SOURCE_COMMIT +
        "\",\"mediaAbi\":" + std::to_string(GPUBNB_WINDOWS_MEDIA_ABI_VERSION) +
        ",\"consoleMediaAbi\":" + std::to_string(GPUBNB_CONSOLE_MEDIA_ABI_VERSION) +
        ",\"audioCaptureAbi\":" + std::to_string(GPUBNB_WINDOWS_AUDIO_ABI_VERSION) +
        ",\"nvencApi\":\"13.0\"}";
    return identity.c_str();
}
