#include <cuda_runtime.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

__global__ void vector_fma(float *values, int count) {
  int index = blockIdx.x * blockDim.x + threadIdx.x;
  if (index < count) values[index] = values[index] * 1.000001f + 0.000001f;
}

static void fail(const char *code) {
  std::fprintf(stderr, "%s\n", code);
  std::exit(2);
}

int main(int argc, char **argv) {
  int duration = 60;
  if (argc == 3 && std::strcmp(argv[1], "--duration-seconds") == 0) duration = std::atoi(argv[2]);
  if (duration < 30 || duration > 600) fail("invalid_duration");

  int device_count = 0;
  if (cudaGetDeviceCount(&device_count) != cudaSuccess || device_count < 1) fail("gpu_unavailable");
  cudaDeviceProp properties{};
  if (cudaGetDeviceProperties(&properties, 0) != cudaSuccess) fail("gpu_properties_unavailable");

  constexpr int count = 1 << 22;
  float *values = nullptr;
  if (cudaMalloc(&values, count * sizeof(float)) != cudaSuccess) fail("gpu_allocation_failed");
  if (cudaMemset(values, 0, count * sizeof(float)) != cudaSuccess) fail("gpu_initialization_failed");

  const auto started = std::chrono::steady_clock::now();
  long long iterations = 0;
  int last_report = 0;
  while (true) {
    vector_fma<<<(count + 255) / 256, 256>>>(values, count);
    if (cudaGetLastError() != cudaSuccess) fail("gpu_kernel_failed");
    if (cudaDeviceSynchronize() != cudaSuccess) fail("gpu_sync_failed");
    ++iterations;
    const int elapsed = static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(
      std::chrono::steady_clock::now() - started).count());
    if (elapsed >= last_report + 5) {
      last_report = elapsed;
      std::printf("{\"schemaVersion\":1,\"type\":\"sample\",\"elapsedSeconds\":%d,\"iterations\":%lld}\n", elapsed, iterations);
      std::fflush(stdout);
    }
    if (elapsed >= duration) break;
  }
  if (cudaDeviceSynchronize() != cudaSuccess) fail("gpu_final_sync_failed");
  cudaFree(values);
  std::printf("{\"schemaVersion\":1,\"type\":\"result\",\"gpuDetected\":true,\"durationSeconds\":%d,\"iterations\":%lld,\"device\":\"%.120s\"}\n", duration, iterations, properties.name);
  return 0;
}
