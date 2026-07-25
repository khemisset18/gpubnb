#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int nvmlReturn_t;
typedef void *nvmlDevice_t;
typedef nvmlReturn_t (*nvmlInit_v2_fn)(void);
typedef nvmlReturn_t (*nvmlShutdown_fn)(void);
typedef nvmlReturn_t (*nvmlDeviceGetCount_v2_fn)(unsigned int *);
typedef nvmlReturn_t (*nvmlDeviceGetHandleByIndex_v2_fn)(unsigned int, nvmlDevice_t *);
typedef nvmlReturn_t (*nvmlDeviceGetName_fn)(nvmlDevice_t, char *, unsigned int);
typedef nvmlReturn_t (*nvmlDeviceGetUUID_fn)(nvmlDevice_t, char *, unsigned int);
typedef nvmlReturn_t (*nvmlDeviceGetMemoryInfo_fn)(nvmlDevice_t, void *);
typedef nvmlReturn_t (*nvmlDeviceGetTemperature_fn)(nvmlDevice_t, unsigned int, unsigned int *);

typedef struct {
    unsigned long long total;
    unsigned long long free;
    unsigned long long used;
} nvmlMemory_t;

static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p >= 0x20) putchar(*p);
    }
    putchar('"');
}

static void *required_symbol(void *library, const char *name) {
    void *symbol = dlsym(library, name);
    if (!symbol) {
        fprintf(stderr, "missing_nvml_symbol:%s\n", name);
        exit(4);
    }
    return symbol;
}

int main(void) {
    void *library = dlopen("libnvidia-ml.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!library) {
        fprintf(stderr, "nvml_library_unavailable\n");
        return 2;
    }

    nvmlInit_v2_fn init = (nvmlInit_v2_fn)required_symbol(library, "nvmlInit_v2");
    nvmlShutdown_fn shutdown = (nvmlShutdown_fn)required_symbol(library, "nvmlShutdown");
    nvmlDeviceGetCount_v2_fn get_count = (nvmlDeviceGetCount_v2_fn)required_symbol(library, "nvmlDeviceGetCount_v2");
    nvmlDeviceGetHandleByIndex_v2_fn get_handle = (nvmlDeviceGetHandleByIndex_v2_fn)required_symbol(library, "nvmlDeviceGetHandleByIndex_v2");
    nvmlDeviceGetName_fn get_name = (nvmlDeviceGetName_fn)required_symbol(library, "nvmlDeviceGetName");
    nvmlDeviceGetUUID_fn get_uuid = (nvmlDeviceGetUUID_fn)required_symbol(library, "nvmlDeviceGetUUID");
    nvmlDeviceGetMemoryInfo_fn get_memory = (nvmlDeviceGetMemoryInfo_fn)required_symbol(library, "nvmlDeviceGetMemoryInfo");
    nvmlDeviceGetTemperature_fn get_temperature = (nvmlDeviceGetTemperature_fn)required_symbol(library, "nvmlDeviceGetTemperature");

    if (init() != 0) {
        fprintf(stderr, "nvml_initialization_failed\n");
        dlclose(library);
        return 3;
    }

    unsigned int count = 0;
    if (get_count(&count) != 0) {
        fprintf(stderr, "nvml_device_count_failed\n");
        shutdown();
        dlclose(library);
        return 5;
    }

    printf("{\"schemaVersion\":1,\"vendor\":\"NVIDIA\",\"gpuCount\":%u,\"gpus\":[", count);
    for (unsigned int index = 0; index < count; ++index) {
        nvmlDevice_t device = NULL;
        char name[96] = {0};
        char uuid[96] = {0};
        nvmlMemory_t memory = {0};
        unsigned int temperature = 0;
        if (get_handle(index, &device) != 0 || get_name(device, name, sizeof(name)) != 0 ||
            get_uuid(device, uuid, sizeof(uuid)) != 0 || get_memory(device, &memory) != 0 ||
            get_temperature(device, 0, &temperature) != 0) {
            fprintf(stderr, "nvml_device_query_failed:%u\n", index);
            shutdown();
            dlclose(library);
            return 6;
        }
        if (index) putchar(',');
        printf("{\"index\":%u,\"name\":", index); json_string(name);
        printf(",\"uuid\":"); json_string(uuid);
        printf(",\"memoryTotalMiB\":%llu,\"memoryUsedMiB\":%llu,\"temperatureC\":%u}",
               memory.total / 1048576ULL, memory.used / 1048576ULL, temperature);
    }
    puts("]}");

    shutdown();
    dlclose(library);
    return count > 0 ? 0 : 7;
}
