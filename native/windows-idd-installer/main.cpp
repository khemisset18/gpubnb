#define UNICODE
#define _UNICODE

#include <windows.h>
#include <newdev.h>
#include <setupapi.h>

#include <cwchar>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kHardwareId[] = L"Root\\GPUbnbVirtualDisplay";
constexpr wchar_t kCompatibleHardwareId[] = L"GPUbnbVirtualDisplay";
constexpr wchar_t kDeviceName[] = L"GPUbnbVirtualDisplay";
constexpr wchar_t kDeviceDescription[] = L"GPUbnb Isolated Virtual Display";
constexpr wchar_t kExpectedInfName[] = L"GPUbnbIdd.inf";

class DeviceInfoSet final {
 public:
  explicit DeviceInfoSet(HDEVINFO handle) noexcept : handle_(handle) {}
  ~DeviceInfoSet() {
    if (handle_ != INVALID_HANDLE_VALUE) {
      SetupDiDestroyDeviceInfoList(handle_);
    }
  }

  DeviceInfoSet(const DeviceInfoSet&) = delete;
  DeviceInfoSet& operator=(const DeviceInfoSet&) = delete;

  HDEVINFO get() const noexcept { return handle_; }

 private:
  HDEVINFO handle_;
};

class NonInteractiveSetup final {
 public:
  NonInteractiveSetup() noexcept : previous_(SetupSetNonInteractiveMode(TRUE)) {}
  ~NonInteractiveSetup() { SetupSetNonInteractiveMode(previous_); }

  NonInteractiveSetup(const NonInteractiveSetup&) = delete;
  NonInteractiveSetup& operator=(const NonInteractiveSetup&) = delete;

 private:
  BOOL previous_;
};

bool IsElevatedAdministrator() {
  SID_IDENTIFIER_AUTHORITY ntAuthority = SECURITY_NT_AUTHORITY;
  PSID administrators = nullptr;
  if (!AllocateAndInitializeSid(
          &ntAuthority,
          2,
          SECURITY_BUILTIN_DOMAIN_RID,
          DOMAIN_ALIAS_RID_ADMINS,
          0,
          0,
          0,
          0,
          0,
          0,
          &administrators)) {
    return false;
  }

  BOOL isMember = FALSE;
  const BOOL ok = CheckTokenMembership(nullptr, administrators, &isMember);
  FreeSid(administrators);
  return ok != FALSE && isMember != FALSE;
}

bool CanonicalInfPath(const wchar_t* input, std::wstring& output) {
  if (input == nullptr || *input == L'\0') {
    return false;
  }

  const DWORD needed = GetFullPathNameW(input, 0, nullptr, nullptr);
  if (needed == 0 || needed > 32768) {
    return false;
  }

  std::vector<wchar_t> buffer(static_cast<size_t>(needed) + 1, L'\0');
  const DWORD written =
      GetFullPathNameW(input, static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (written == 0 || written >= buffer.size()) {
    return false;
  }

  output.assign(buffer.data(), written);

  // Production installation accepts only a drive-qualified local path. Reject
  // UNC/device namespaces and relative spellings before SetupAPI sees them.
  if (output.size() < 4 || output[1] != L':' ||
      (output[2] != L'\\' && output[2] != L'/')) {
    return false;
  }

  const size_t slash = output.find_last_of(L"\\/");
  const std::wstring fileName =
      slash == std::wstring::npos ? output : output.substr(slash + 1);
  if (_wcsicmp(fileName.c_str(), kExpectedInfName) != 0) {
    return false;
  }

  const DWORD attributes = GetFileAttributesW(output.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool MultiSzContains(const BYTE* raw, DWORD byteCount, const wchar_t* expected) {
  if (raw == nullptr || expected == nullptr || byteCount < sizeof(wchar_t) * 2 ||
      (byteCount % sizeof(wchar_t)) != 0) {
    return false;
  }

  const auto* cursor = reinterpret_cast<const wchar_t*>(raw);
  const auto* end = cursor + (byteCount / sizeof(wchar_t));
  while (cursor < end && *cursor != L'\0') {
    const size_t remaining = static_cast<size_t>(end - cursor);
    const size_t length = wcsnlen_s(cursor, remaining);
    if (length == 0 || length >= remaining) {
      return false;
    }
    if (_wcsicmp(cursor, expected) == 0) {
      return true;
    }
    cursor += length + 1;
  }
  return false;
}

enum class ExistingDeviceResult {
  Found,
  NotFound,
  Error,
};

ExistingDeviceResult FindExistingDevice(const GUID& classGuid) {
  DeviceInfoSet devices(
      SetupDiGetClassDevsW(&classGuid, nullptr, nullptr, DIGCF_PRESENT));
  if (devices.get() == INVALID_HANDLE_VALUE) {
    return ExistingDeviceResult::Error;
  }

  for (DWORD index = 0;; ++index) {
    SP_DEVINFO_DATA device{};
    device.cbSize = sizeof(device);
    if (!SetupDiEnumDeviceInfo(devices.get(), index, &device)) {
      const DWORD error = GetLastError();
      return error == ERROR_NO_MORE_ITEMS ? ExistingDeviceResult::NotFound
                                          : ExistingDeviceResult::Error;
    }

    DWORD propertyType = 0;
    DWORD required = 0;
    if (!SetupDiGetDeviceRegistryPropertyW(
            devices.get(),
            &device,
            SPDRP_HARDWAREID,
            &propertyType,
            nullptr,
            0,
            &required)) {
      const DWORD error = GetLastError();
      if (error == ERROR_INVALID_DATA) {
        continue;
      }
      if (error != ERROR_INSUFFICIENT_BUFFER || required == 0 ||
          required > 64 * 1024) {
        return ExistingDeviceResult::Error;
      }
    }

    std::vector<BYTE> buffer(static_cast<size_t>(required) + sizeof(wchar_t) * 2, 0);
    if (!SetupDiGetDeviceRegistryPropertyW(
            devices.get(),
            &device,
            SPDRP_HARDWAREID,
            &propertyType,
            buffer.data(),
            required,
            &required)) {
      return ExistingDeviceResult::Error;
    }

    if (propertyType != REG_MULTI_SZ && propertyType != REG_SZ) {
      continue;
    }

    if (MultiSzContains(buffer.data(), required, kHardwareId) ||
        MultiSzContains(buffer.data(), required, kCompatibleHardwareId)) {
      return ExistingDeviceResult::Found;
    }
  }
}

bool RemoveCreatedDevice(HDEVINFO devices, SP_DEVINFO_DATA& device) {
  SP_REMOVEDEVICE_PARAMS remove{};
  remove.ClassInstallHeader.cbSize = sizeof(SP_CLASSINSTALL_HEADER);
  remove.ClassInstallHeader.InstallFunction = DIF_REMOVE;
  remove.Scope = DI_REMOVEDEVICE_GLOBAL;
  remove.HwProfile = 0;

  if (!SetupDiSetClassInstallParamsW(
          devices,
          &device,
          &remove.ClassInstallHeader,
          sizeof(remove))) {
    return false;
  }
  return SetupDiCallClassInstaller(DIF_REMOVE, devices, &device) != FALSE;
}

bool CreateRootDevice(
    const GUID& classGuid,
    DeviceInfoSet& devices,
    SP_DEVINFO_DATA& device) {
  device = {};
  device.cbSize = sizeof(device);

  if (!SetupDiCreateDeviceInfoW(
          devices.get(),
          kDeviceName,
          &classGuid,
          kDeviceDescription,
          nullptr,
          DICD_GENERATE_ID,
          &device)) {
    return false;
  }

  // Explicit + implicit terminator => valid REG_MULTI_SZ with two trailing NULs.
  static constexpr wchar_t hardwareIds[] = L"Root\\GPUbnbVirtualDisplay\0";
  if (!SetupDiSetDeviceRegistryPropertyW(
          devices.get(),
          &device,
          SPDRP_HARDWAREID,
          reinterpret_cast<const BYTE*>(hardwareIds),
          sizeof(hardwareIds))) {
    return false;
  }

  return SetupDiCallClassInstaller(DIF_REGISTERDEVICE, devices.get(), &device) != FALSE;
}

bool InstallOrUpdateDriver(
    const std::wstring& infPath,
    bool& rebootRequired) {
  BOOL reboot = FALSE;
  // Keep Windows driver ranking authoritative so this installer cannot
  // downgrade a newer or better matching package.
  if (!UpdateDriverForPlugAndPlayDevicesW(
          nullptr,
          kHardwareId,
          infPath.c_str(),
          INSTALLFLAG_NONINTERACTIVE,
          &reboot)) {
    return false;
  }
  rebootRequired = reboot != FALSE;
  return true;
}

void PrintFailure(const char* stage, DWORD error) {
  std::cerr << "{\"ok\":false,\"stage\":\"" << stage
            << "\",\"win32Error\":" << error << "}\n";
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc != 3 || _wcsicmp(argv[1], L"install") != 0) {
    std::cerr << "usage: gpubnb-idd-installer install <absolute-GPUbnbIdd.inf>\n";
    return 64;
  }
  if (!IsElevatedAdministrator()) {
    PrintFailure("admin_required", ERROR_ACCESS_DENIED);
    return 5;
  }

  std::wstring infPath;
  if (!CanonicalInfPath(argv[2], infPath)) {
    PrintFailure("invalid_inf_path", ERROR_INVALID_PARAMETER);
    return 87;
  }

  GUID classGuid{};
  wchar_t className[256]{};
  DWORD required = 0;
  if (!SetupDiGetINFClassW(
          infPath.c_str(),
          &classGuid,
          className,
          static_cast<DWORD>(std::size(className)),
          &required)) {
    const DWORD error = GetLastError();
    PrintFailure("inf_class", error);
    return static_cast<int>(error == 0 ? ERROR_INVALID_DATA : error);
  }

  NonInteractiveSetup nonInteractive;

  const ExistingDeviceResult existing = FindExistingDevice(classGuid);
  if (existing == ExistingDeviceResult::Error) {
    const DWORD error = GetLastError();
    PrintFailure("enumerate_existing", error);
    return static_cast<int>(error == 0 ? ERROR_GEN_FAILURE : error);
  }

  bool created = false;
  DeviceInfoSet createdSet(SetupDiCreateDeviceInfoList(&classGuid, nullptr));
  SP_DEVINFO_DATA createdDevice{};

  if (existing == ExistingDeviceResult::NotFound) {
    if (createdSet.get() == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError();
      PrintFailure("create_device_set", error);
      return static_cast<int>(error == 0 ? ERROR_GEN_FAILURE : error);
    }

    if (!CreateRootDevice(classGuid, createdSet, createdDevice)) {
      const DWORD error = GetLastError();
      PrintFailure("register_root_device", error);
      return static_cast<int>(error == 0 ? ERROR_GEN_FAILURE : error);
    }
    created = true;
  }

  bool rebootRequired = false;
  if (!InstallOrUpdateDriver(infPath, rebootRequired)) {
    const DWORD error = GetLastError();
    if (created) {
      (void)RemoveCreatedDevice(createdSet.get(), createdDevice);
    }
    PrintFailure("install_driver", error);
    return static_cast<int>(error == 0 ? ERROR_GEN_FAILURE : error);
  }

  std::cout << "{\"ok\":true,\"deviceCreated\":"
            << (created ? "true" : "false")
            << ",\"rebootRequired\":"
            << (rebootRequired ? "true" : "false")
            << "}\n";
  return 0;
}
