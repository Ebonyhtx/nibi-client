#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

// Installer and updater process pre-clean helper.
//
// A process is a match only when QueryFullProcessImageNameW reports an executable
// path equal to one of the --target paths after long-name normalization. Command
// lines, window titles and path substrings are never inspected. Every candidate
// identity is read twice (image path and creation time); both readings must agree
// before the process is accepted, so a recycled PID cannot turn an unrelated
// process into an install target.
//
// CLI:
//   nibi-installer-process-helper --check --target <path> [--target <path>...]
//   nibi-installer-process-helper --terminate [--wait-ms <ms>] --target <path>...
//   Add --json for one JSON object; the default is a line protocol.
//
// Exit codes: 0 success, 1 helper failure, 2 check found live targets,
// 3 terminate left live targets after the bounded wait.

namespace {
constexpr ULONGLONG kDefaultWaitMs = 5000;
constexpr ULONGLONG kMaxWaitMs = 120000;
constexpr size_t kMaxTargets = 64;
constexpr DWORD kQueryAccess = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;
constexpr DWORD kTerminateAccess = kQueryAccess | PROCESS_TERMINATE;

class Handle {
 public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() {
    if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept {
    reset(other.release());
    return *this;
  }
  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) {
    if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

struct Options {
  bool check = false;
  bool terminate = false;
  bool json = false;
  bool forceRecheckMismatch = false;
  ULONGLONG waitMs = kDefaultWaitMs;
  std::vector<std::wstring> targets;
};

struct Target {
  std::wstring path;
};

struct Identity {
  std::wstring path;
  ULONGLONG created = 0;
};

struct Match {
  DWORD pid = 0;
  ULONGLONG created = 0;
  std::wstring path;
  Handle process;
  bool canTerminate = false;
};

struct MatchInfo {
  DWORD pid = 0;
  ULONGLONG created = 0;
  std::wstring path;
  bool canTerminate = false;
};

struct Denied {
  DWORD pid = 0;
  DWORD error = 0;
};

std::wstring NormalizeSeparators(std::wstring value) {
  for (auto& character : value) {
    if (character == L'/') character = L'\\';
  }
  // QueryFullProcessImageNameW can return a Win32 path, but callers and tests
  // may also pass extended-length spellings. Normalize them before comparison.
  if (value.rfind(L"\\\\?\\UNC\\", 0) == 0) {
    value = L"\\\\" + value.substr(8);
  } else if (value.rfind(L"\\??\\UNC\\", 0) == 0) {
    value = L"\\\\" + value.substr(8);
  } else if (value.rfind(L"\\\\?\\", 0) == 0) {
    value.erase(0, 4);
  } else if (value.rfind(L"\\??\\", 0) == 0) {
    value.erase(0, 4);
  }
  while (value.size() > 3 && value.back() == L'\\' && value[value.size() - 2] != L':') {
    value.pop_back();
  }
  return value;
}

std::wstring NormalizePath(const std::wstring& value, bool resolveLongName) {
  if (value.empty()) return {};
  std::wstring normalized = NormalizeSeparators(value);
  wchar_t buffer[32768];
  const DWORD fullLength =
      GetFullPathNameW(normalized.c_str(), static_cast<DWORD>(std::size(buffer)), buffer, nullptr);
  if (fullLength > 0 && fullLength < std::size(buffer)) {
    normalized.assign(buffer, fullLength);
  }
  if (resolveLongName) {
    const DWORD longLength = GetLongPathNameW(normalized.c_str(), buffer,
                                              static_cast<DWORD>(std::size(buffer)));
    if (longLength > 0 && longLength < std::size(buffer)) {
      normalized.assign(buffer, longLength);
    }
  }
  return NormalizeSeparators(std::move(normalized));
}

bool SamePath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}

bool ReadIdentity(HANDLE process, Identity* identity) {
  FILETIME creation{}, exitTime{}, kernel{}, user{};
  if (!GetProcessTimes(process, &creation, &exitTime, &kernel, &user)) return false;

  std::wstring imagePath;
  DWORD size = 512;
  for (;;) {
    imagePath.resize(size);
    DWORD written = size;
    if (QueryFullProcessImageNameW(process, 0, imagePath.data(), &written)) {
      imagePath.resize(written);
      break;
    }
    const DWORD error = GetLastError();
    if (error != ERROR_INSUFFICIENT_BUFFER || size >= 32768) return false;
    size *= 2;
  }
  if (imagePath.empty()) return false;

  ULARGE_INTEGER ticks{};
  ticks.LowPart = creation.dwLowDateTime;
  ticks.HighPart = creation.dwHighDateTime;
  identity->path = NormalizePath(imagePath, true);
  identity->created = ticks.QuadPart;
  return !identity->path.empty() && identity->created != 0;
}

bool ReadStableIdentity(HANDLE process, bool forceRecheckMismatch, Identity* identity) {
  Identity first;
  Identity second;
  if (!ReadIdentity(process, &first) || !ReadIdentity(process, &second)) return false;
  // Deterministic regression hook: tests deliberately perturb the second
  // creation-time reading to prove that a mismatched identity is rejected.
  if (forceRecheckMismatch) second.created += 1;
  if (first.created != second.created) return false;
  if (!SamePath(first.path, second.path)) return false;
  *identity = std::move(first);
  return true;
}

bool IsLive(HANDLE process) {
  return WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
}

bool MatchesTarget(const std::wstring& path, const std::vector<Target>& targets) {
  for (const auto& target : targets) {
    if (SamePath(path, target.path)) return true;
  }
  return false;
}

void RecordDenied(std::vector<Denied>* denied, DWORD pid, DWORD error) {
  for (const auto& entry : *denied) {
    if (entry.pid == pid && entry.error == error) return;
  }
  denied->push_back({pid, error});
}

bool ScanTargets(const std::vector<Target>& targets, bool needTerminate,
                 bool forceRecheckMismatch, std::vector<Match>* matches,
                 std::vector<Denied>* denied, DWORD* error) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) {
    *error = GetLastError();
    return false;
  }

  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.get(), &entry)) {
    const DWORD firstError = GetLastError();
    if (firstError == ERROR_NO_MORE_FILES) return true;
    *error = firstError;
    return false;
  }

  const DWORD ownPid = GetCurrentProcessId();
  do {
    const DWORD pid = entry.th32ProcessID;
    if (pid == 0 || pid == ownPid) continue;

    // Query-only first: unrelated system processes must never be opened with
    // termination rights just to discover that they are not install targets.
    Handle query(OpenProcess(kQueryAccess, FALSE, pid));
    if (!query) continue;

    Identity identity;
    if (!ReadStableIdentity(query.get(), forceRecheckMismatch, &identity)) continue;
    if (!IsLive(query.get())) continue;
    if (!MatchesTarget(identity.path, targets)) continue;

    if (!needTerminate) {
      matches->push_back({pid, identity.created, std::move(identity.path), std::move(query), false});
      continue;
    }

    Handle terminateHandle(OpenProcess(kTerminateAccess, FALSE, pid));
    if (!terminateHandle) {
      const DWORD openError = GetLastError();
      if (openError == ERROR_ACCESS_DENIED) RecordDenied(denied, pid, openError);
      matches->push_back({pid, identity.created, std::move(identity.path), std::move(query), false});
      continue;
    }

    // Re-open by PID can race with exit and reuse. The second handle must show
    // the same image path and creation time as the query handle.
    Identity rechecked;
    if (!ReadStableIdentity(terminateHandle.get(), forceRecheckMismatch, &rechecked) ||
        rechecked.created != identity.created ||
        !SamePath(rechecked.path, identity.path)) {
      continue;
    }
    if (!IsLive(terminateHandle.get())) continue;
    matches->push_back({pid, identity.created, std::move(identity.path), std::move(terminateHandle),
                        true});
  } while (Process32NextW(snapshot.get(), &entry));

  const DWORD nextError = GetLastError();
  if (nextError != ERROR_NO_MORE_FILES) {
    *error = nextError;
    return false;
  }
  return true;
}

std::vector<MatchInfo> Describe(const std::vector<Match>& matches) {
  std::vector<MatchInfo> result;
  result.reserve(matches.size());
  for (const auto& match : matches) {
    result.push_back({match.pid, match.created, match.path, match.canTerminate});
  }
  return result;
}

void TerminateMatches(std::vector<Match>* matches) {
  for (auto& match : *matches) {
    if (!match.canTerminate || !match.process) continue;
    TerminateProcess(match.process.get(), 1);
  }
}

std::string ToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                       nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size,
                      nullptr, nullptr);
  return result;
}

std::string JsonString(const std::wstring& value) {
  const std::string utf8 = ToUtf8(value);
  std::string result = "\"";
  for (const unsigned char character : utf8) {
    switch (character) {
      case '"':
        result += "\\\"";
        break;
      case '\\':
        result += "\\\\";
        break;
      case '\b':
        result += "\\b";
        break;
      case '\f':
        result += "\\f";
        break;
      case '\n':
        result += "\\n";
        break;
      case '\r':
        result += "\\r";
        break;
      case '\t':
        result += "\\t";
        break;
      default:
        if (character < 0x20) {
          char escaped[7];
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned int>(character));
          result += escaped;
        } else {
          result += static_cast<char>(character);
        }
        break;
    }
  }
  result += '"';
  return result;
}

std::string LineString(const std::wstring& value) {
  std::string result = ToUtf8(value);
  for (auto& character : result) {
    if (character == '\r' || character == '\n') character = ' ';
  }
  return result;
}

void Emit(const std::string& text) {
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!output || output == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(output, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
}

void EmitLine(const Options& options, const std::vector<Target>& targets,
              const std::vector<MatchInfo>& matches, const std::vector<MatchInfo>& remaining,
              const std::vector<Denied>& denied, const char* status, int exitCode) {
  const char* mode = options.check ? "check" : "terminate";
  std::string output = "nibi-installer-process-helper 1\n";
  output += std::string("mode=") + mode + "\n";
  for (const auto& target : targets) output += "target=" + LineString(target.path) + "\n";
  for (const auto& match : matches) {
    output += "match pid=" + std::to_string(match.pid) +
              " created=" + std::to_string(match.created) + " can-terminate=" +
              (match.canTerminate ? "1" : "0") + " path=" + LineString(match.path) + "\n";
  }
  for (const auto& match : remaining) {
    output += "remaining pid=" + std::to_string(match.pid) +
              " created=" + std::to_string(match.created) + " can-terminate=" +
              (match.canTerminate ? "1" : "0") + " path=" + LineString(match.path) + "\n";
  }
  for (const auto& entry : denied) {
    output += "denied pid=" + std::to_string(entry.pid) +
              " win32=" + std::to_string(entry.error) + "\n";
  }
  output += "result status=" + std::string(status) + " matches=" +
            std::to_string(matches.size()) + " remaining=" + std::to_string(remaining.size()) +
            " denied=" + std::to_string(denied.size()) + " exit=" + std::to_string(exitCode) + "\n";
  Emit(output);
}

void EmitJson(const Options& options, const std::vector<Target>& targets,
              const std::vector<MatchInfo>& matches, const std::vector<MatchInfo>& remaining,
              const std::vector<Denied>& denied, const char* status, int exitCode) {
  const char* mode = options.check ? "check" : "terminate";
  std::string output = "{\"version\":1,\"mode\":\"" + std::string(mode) + "\",\"status\":\"" +
                       std::string(status) + "\",\"exitCode\":" + std::to_string(exitCode) +
                       ",\"targets\":[";
  for (size_t index = 0; index < targets.size(); ++index) {
    if (index > 0) output += ',';
    output += JsonString(targets[index].path);
  }
  output += "],\"matches\":[";
  for (size_t index = 0; index < matches.size(); ++index) {
    if (index > 0) output += ',';
    const auto& match = matches[index];
    output += "{\"pid\":" + std::to_string(match.pid) + ",\"created\":\"" +
              std::to_string(match.created) + "\",\"path\":" + JsonString(match.path) +
              ",\"canTerminate\":" + (match.canTerminate ? "true" : "false") + "}";
  }
  output += "],\"remaining\":[";
  for (size_t index = 0; index < remaining.size(); ++index) {
    if (index > 0) output += ',';
    const auto& match = remaining[index];
    output += "{\"pid\":" + std::to_string(match.pid) + ",\"created\":\"" +
              std::to_string(match.created) + "\",\"path\":" + JsonString(match.path) +
              ",\"canTerminate\":" + (match.canTerminate ? "true" : "false") + "}";
  }
  output += "],\"denied\":[";
  for (size_t index = 0; index < denied.size(); ++index) {
    if (index > 0) output += ',';
    output += "{\"pid\":" + std::to_string(denied[index].pid) +
              ",\"win32\":" + std::to_string(denied[index].error) + "}";
  }
  output += "]}\n";
  Emit(output);
}

void EmitError(const Options& options, const wchar_t* stage, DWORD errorCode) {
  const char* mode = options.check ? "check" : "terminate";
  if (options.json) {
    const std::string error = ToUtf8(stage);
    Emit("{\"version\":1,\"mode\":\"" + std::string(mode) +
         "\",\"status\":\"error\",\"exitCode\":1,\"error\":\"" + error +
         "\",\"errorCode\":" + std::to_string(errorCode) + "}\n");
  } else {
    Emit(std::string("error mode=") + mode + " stage=" + ToUtf8(stage) +
         " win32=" + std::to_string(errorCode) + "\n");
  }
}

bool ParseWaitMs(const std::wstring& value, ULONGLONG* waitMs) {
  if (value.empty()) return false;
  wchar_t* end = nullptr;
  const unsigned long long parsed = std::wcstoull(value.c_str(), &end, 10);
  if (end == value.c_str() || *end != L'\0') return false;
  if (parsed > kMaxWaitMs) return false;
  *waitMs = parsed;
  return true;
}

bool ParseOptions(int argc, wchar_t** argv, Options* options, std::wstring* error) {
  for (int index = 1; index < argc; ++index) {
    const std::wstring argument = argv[index];
    if (argument == L"--check") {
      options->check = true;
    } else if (argument == L"--terminate") {
      options->terminate = true;
    } else if (argument == L"--json") {
      options->json = true;
    } else if (argument == L"--test-force-recheck-mismatch") {
      options->forceRecheckMismatch = true;
    } else if (argument == L"--wait-ms") {
      if (index + 1 >= argc || !ParseWaitMs(argv[++index], &options->waitMs)) {
        *error = L"invalid --wait-ms value";
        return false;
      }
    } else if (argument.rfind(L"--wait-ms=", 0) == 0) {
      if (!ParseWaitMs(argument.substr(10), &options->waitMs)) {
        *error = L"invalid --wait-ms value";
        return false;
      }
    } else if (argument == L"--target") {
      if (index + 1 >= argc || argv[index + 1][0] == L'\0') {
        *error = L"missing --target value";
        return false;
      }
      options->targets.emplace_back(argv[++index]);
    } else if (argument.rfind(L"--target=", 0) == 0) {
      const std::wstring value = argument.substr(9);
      if (value.empty()) {
        *error = L"missing --target value";
        return false;
      }
      options->targets.push_back(value);
    } else {
      *error = L"unknown argument";
      return false;
    }
  }

  if (options->check == options->terminate) {
    *error = L"exactly one of --check or --terminate is required";
    return false;
  }
  if (options->targets.empty()) {
    *error = L"at least one --target is required";
    return false;
  }
  if (options->targets.size() > kMaxTargets) {
    *error = L"too many --target values";
    return false;
  }
  return true;
}

void PrintUsage() {
  const char* usage =
      "nibi-installer-process-helper 1\n"
      "Usage:\n"
      "  nibi-installer-process-helper --check --target <path> [--target <path>...] [--json]\n"
      "  nibi-installer-process-helper --terminate [--wait-ms <ms>] --target <path>... [--json]\n";
  Emit(usage);
}

int Run(const Options& options) {
  std::vector<Target> targets;
  targets.reserve(options.targets.size());
  for (const auto& value : options.targets) {
    const std::wstring normalized = NormalizePath(value, true);
    if (normalized.empty()) {
      EmitError(options, L"target-normalization", ERROR_INVALID_PARAMETER);
      return 1;
    }
    targets.push_back({normalized});
  }

  std::vector<Match> matches;
  std::vector<Denied> denied;
  DWORD scanError = 0;
  if (!ScanTargets(targets, options.terminate, options.forceRecheckMismatch, &matches, &denied,
                   &scanError)) {
    EmitError(options, L"process-enumeration", scanError);
    return 1;
  }

  std::vector<MatchInfo> initial = Describe(matches);
  if (options.check) {
    const bool blocked = !initial.empty();
    const char* status = blocked ? "blocked" : "ok";
    if (options.json) {
      EmitJson(options, targets, initial, {}, denied, status, blocked ? 2 : 0);
    } else {
      EmitLine(options, targets, initial, {}, denied, status, blocked ? 2 : 0);
    }
    return blocked ? 2 : 0;
  }

  std::vector<MatchInfo> remaining;
  if (!initial.empty()) {
    TerminateMatches(&matches);
    matches.clear();

    const ULONGLONG deadline = GetTickCount64() + options.waitMs;
    for (;;) {
      std::vector<Match> current;
      std::vector<Denied> ignored;
      DWORD rescanError = 0;
      if (!ScanTargets(targets, false, options.forceRecheckMismatch, &current, &ignored,
                       &rescanError)) {
        EmitError(options, L"process-rescan", rescanError);
        return 1;
      }
      if (current.empty()) break;
      if (GetTickCount64() >= deadline) {
        remaining = Describe(current);
        break;
      }
      const ULONGLONG left = deadline - GetTickCount64();
      Sleep(static_cast<DWORD>(left < 50 ? left : 50));
    }
  }

  const char* status = remaining.empty() ? "closed" : "remaining";
  const int exitCode = remaining.empty() ? 0 : 3;
  if (options.json) {
    EmitJson(options, targets, initial, remaining, denied, status, exitCode);
  } else {
    EmitLine(options, targets, initial, remaining, denied, status, exitCode);
  }
  return exitCode;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--version") {
    std::puts("nibi-installer-process-helper 1");
    return 0;
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--help") {
    PrintUsage();
    return 0;
  }

  Options options;
  std::wstring error;
  if (!ParseOptions(argc, argv, &options, &error)) {
    EmitError(options, error.c_str(), ERROR_INVALID_PARAMETER);
    PrintUsage();
    return 1;
  }
  return Run(options);
}
