#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

// Native owner of the CLI Job object.
//
// Protocol over the control pipe (one LF-terminated frame per event):
//   helper -> Host: "ready <cli-pid>", "started", "root <exit-code>", "empty"
//   Host -> helper: "start", "close"
//
// The CLI is created suspended, assigned to the Job through the creation
// attribute list, and only resumed after the Host sends "start". On EOF the
// helper gives the CLI a 1800 ms grace window before terminating the Job.
// KILL_ON_JOB_CLOSE guarantees the tree dies when this process or the Host
// disappears.

namespace {
constexpr ULONGLONG kGraceMs = 1800;
constexpr ULONGLONG kStartupMs = 10000;

struct Handle {
  HANDLE value = nullptr;
  ~Handle() {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
  }
};

bool send(HANDLE pipe, const std::string& message) {
  const auto frame = message + "\n";
  DWORD count = 0;
  return WriteFile(pipe, frame.data(), static_cast<DWORD>(frame.size()), &count, nullptr) &&
         count == frame.size();
}

// Quote one argument for CreateProcessW using the documented backslash rules.
std::wstring quote(const std::wstring& arg) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const auto c : arg) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    result.append(slashes * (c == L'"' ? 2 : 1), L'\\');
    slashes = 0;
    if (c == L'"') result += L'\\';
    result += c;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}

int fail(const char* stage) {
  std::fprintf(stderr, "[nibi-runtime-host] %s failed (%lu)\n", stage, GetLastError());
  return 1;
}

int checkEmpty(const wchar_t* name) {
  Handle previous{OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, name)};
  // The kernel destroys the Job after the last handle closes and all members
  // exit; ERROR_FILE_NOT_FOUND therefore proves the original Job is gone.
  if (!previous.value) return GetLastError() == ERROR_FILE_NOT_FOUND ? 0 : fail("open previous Job");
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(previous.value, JobObjectBasicAccountingInformation, &accounting,
                                 sizeof(accounting), nullptr))
    return fail("previous Job membership");
  return accounting.ActiveProcesses == 0 ? 0 : 2;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--version") {
    std::puts("nibi-runtime-host 1");
    return 0;
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--check-empty") return checkEmpty(argv[2]);
  if (argc < 5) return fail("arguments");

  const DWORD parentPid = wcstoul(argv[2], nullptr, 10);
  Handle parent{OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid)};
  if (!parent.value) return fail("parent handle");
  Handle control{CreateFileW(argv[1], GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0,
                             nullptr)};
  if (control.value == INVALID_HANDLE_VALUE) return fail("control pipe");
  ULONG serverPid = 0;
  if (!GetNamedPipeServerProcessId(control.value, &serverPid) || serverPid != parentPid ||
      WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT)
    return fail("control owner");

  Handle job{CreateJobObjectW(nullptr, argv[3])};
  if (!job.value || GetLastError() == ERROR_ALREADY_EXISTS) return fail("create unique Job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits)))
    return fail("configure Job");

  // Passing the Job through the creation attribute list closes the spawn/assign
  // race: the CLI is born inside the Job even if this helper dies immediately.
  // The CLI stays suspended until the Host has installed its protocol listeners.
  Handle input, output, error;
  HANDLE inherited[3];
  Handle* copies[] = {&input, &output, &error};
  const DWORD ids[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i = 0; i < 3; ++i) {
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(ids[i]), GetCurrentProcess(),
                         &copies[i]->value, 0, TRUE, DUPLICATE_SAME_ACCESS))
      return fail("stdio handles");
    inherited[i] = copies[i]->value;
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  std::vector<unsigned char> storage(size);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) return fail("handle list");
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                 sizeof(inherited), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    return fail("inherit list");
  }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value,
                                 sizeof(job.value), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    return fail("creation Job attribute");
  }
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = input.value;
  si.StartupInfo.hStdOutput = output.value;
  si.StartupInfo.hStdError = error.value;
  si.lpAttributeList = attributes;
  std::wstring command;
  for (int i = 4; i < argc; ++i) {
    if (i > 4) command += L' ';
    command += quote(argv[i]);
  }
  PROCESS_INFORMATION pi{};
  const BOOL created =
      CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                     CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr,
                     nullptr, &si.StartupInfo, &pi);
  const DWORD createError = GetLastError();
  DeleteProcThreadAttributeList(attributes);
  if (!created) {
    SetLastError(createError);
    return fail("create suspended CLI");
  }
  Handle root{pi.hProcess}, primaryThread{pi.hThread};
  BOOL assigned = FALSE;
  if (!IsProcessInJob(root.value, job.value, &assigned) || !assigned) {
    TerminateProcess(root.value, 1);
    return fail("verify creation Job ownership");
  }

  bool start = false, close = false, lost = false;
  std::string controlLine;
  bool running = false, rootExited = false, forced = false;
  ULONGLONG closeAt = 0;
  const ULONGLONG startupDeadline = GetTickCount64() + kStartupMs;
  if (!send(control.value, "ready " + std::to_string(pi.dwProcessId))) lost = true;
  int result = 0;
  for (;;) {
    DWORD available = 0;
    if (!lost && !PeekNamedPipe(control.value, nullptr, 0, nullptr, &available, nullptr))
      lost = true;
    while (!lost && available-- > 0) {
      char c = 0;
      DWORD count = 0;
      if (!ReadFile(control.value, &c, 1, &count, nullptr) || count != 1) {
        lost = true;
        break;
      }
      if (c == '\n') {
        if (controlLine == "start")
          start = true;
        else if (controlLine == "close")
          close = true;
        else
          lost = true;
        controlLine.clear();
      } else if (controlLine.size() < 32) {
        controlLine += c;
      } else {
        lost = true;
      }
    }
    const ULONGLONG now = GetTickCount64();
    const bool abandoned = lost || WaitForSingleObject(parent.value, 0) == WAIT_OBJECT_0;
    if (!running && start && !close && !abandoned) {
      if (ResumeThread(primaryThread.value) == static_cast<DWORD>(-1)) {
        result = fail("resume CLI");
        break;
      }
      running = true;
      if (!send(control.value, "started")) lost = true;
    }
    if (!rootExited && WaitForSingleObject(root.value, 0) == WAIT_OBJECT_0) {
      rootExited = true;
      DWORD code = 0;
      if (!GetExitCodeProcess(root.value, &code)) {
        result = fail("root exit status");
        break;
      }
      if (!lost && !send(control.value, "root " + std::to_string(code))) lost = true;
    }
    if (close && closeAt == 0) closeAt = now;
    // Root exit means the CLI finished its own shutdown; remaining members still
    // belong to the Job and must not be released based on the root PID.
    const bool mustTerminate =
        abandoned || rootExited || (!running && (close || now >= startupDeadline)) ||
        (closeAt != 0 && now - closeAt >= kGraceMs);
    if (mustTerminate && !forced) {
      if (!TerminateJobObject(job.value, 1)) {
        result = fail("terminate Job");
        break;
      }
      forced = true;
    }
    if (rootExited) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting,
                                     sizeof(accounting), nullptr)) {
        result = fail("query Job membership");
        break;
      }
      if (accounting.ActiveProcesses == 0) {
        if (!lost) send(control.value, "empty");
        break;
      }
    }
    // Wait on handles; the short poll only re-reads the kernel Job count. It
    // never enumerates system processes and never treats a timeout as empty.
    HANDLE waits[] = {parent.value, root.value};
    if (abandoned)
      Sleep(50);
    else
      WaitForMultipleObjects(rootExited ? 1 : 2, waits, FALSE, 50);
  }
  // An abnormal exit is still covered by the last Job handle closing.
  return result;
}
