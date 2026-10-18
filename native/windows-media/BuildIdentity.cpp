// Read-only provenance query. No GPU, display or session initialization.
#ifndef GPUBNB_SOURCE_COMMIT
#define GPUBNB_SOURCE_COMMIT "unconfigured"
#endif
extern "C" __declspec(dllexport) const char* __cdecl GPUbnbMediaBuildIdentity()
{
    return "{\"sourceCommit\":\"" GPUBNB_SOURCE_COMMIT "\",\"mediaAbi\":2,\"nvencApi\":\"13.0\"}";
}
