// The Windows side of platform.h: system randomness, DPAPI for the secret, the user's folders, and
// conversion in a sandboxed child process.
#include <windows.h>
#include <bcrypt.h>
#include <dpapi.h>
#include <sddl.h>
#include <shlobj.h>

#include <atomic>
#include <stdexcept>
#include <thread>
#include <vector>

#include "../core/platform.h"
#include "../core/text.h"
#include "mf_convert.h"
#include "util.h"

namespace clew::platform {

namespace {

const char kEntropy[] = "clew-audio-server/secret/v1";
constexpr DWORD kConvertTimeoutMs = 30 * 60 * 1000;
constexpr SIZE_T kChildMemory = SIZE_T(1536) * 1024 * 1024;

fs::path known_folder(REFKNOWNFOLDERID id) {
    PWSTR p = nullptr;
    fs::path out;
    if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &p))) out = p;
    CoTaskMemFree(p);
    return out;
}

struct Handle {
    HANDLE h = nullptr;
    Handle() = default;
    explicit Handle(HANDLE v) : h(v == INVALID_HANDLE_VALUE ? nullptr : v) {}
    ~Handle() {
        if (h) CloseHandle(h);
    }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    void reset(HANDLE v = nullptr) {
        if (h) CloseHandle(h);
        h = v;
    }
};

// A copy of this process's token at low integrity: what it starts can read the user's files but
// write almost nowhere (not the user's documents, not the registry), whatever a codec does.
HANDLE low_integrity_token() {
    HANDLE self = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(),
                          TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &self))
        return nullptr;
    HANDLE low = nullptr;
    BOOL ok = DuplicateTokenEx(self, 0, nullptr, SecurityImpersonation, TokenPrimary, &low);
    CloseHandle(self);
    if (!ok) return nullptr;
    PSID sid = nullptr;
    if (!ConvertStringSidToSidW(L"S-1-16-4096", &sid)) {
        CloseHandle(low);
        return nullptr;
    }
    TOKEN_MANDATORY_LABEL label{};
    label.Label.Attributes = SE_GROUP_INTEGRITY;
    label.Label.Sid = sid;
    ok = SetTokenInformation(low, TokenIntegrityLevel, &label, DWORD(sizeof label + GetLengthSid(sid)));
    LocalFree(sid);
    if (!ok) {
        CloseHandle(low);
        return nullptr;
    }
    return low;
}

// One process, at most 1.5 GB, no windows, no clipboard, killed with the job.
HANDLE sandbox_job() {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) return nullptr;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
    lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                                           JOB_OBJECT_LIMIT_PROCESS_MEMORY |
                                           JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    lim.BasicLimitInformation.ActiveProcessLimit = 1;
    lim.ProcessMemoryLimit = kChildMemory;
    JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
    ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                             JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS |
                             JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD |
                             JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &lim, sizeof lim) ||
        !SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof ui)) {
        CloseHandle(job);
        return nullptr;
    }
    return job;
}

// Runs `app` sandboxed; what it writes to its standard output becomes `out`. Its standard error is
// kept (a little) to say why it failed.
bool run_sandboxed(const std::wstring& app, std::wstring cmdline, const fs::path& out, std::string* why) {
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE out_r = nullptr, out_w = nullptr, err_r = nullptr, err_w = nullptr;
    if (!CreatePipe(&out_r, &out_w, &sa, 1 << 16) || !CreatePipe(&err_r, &err_w, &sa, 1 << 16)) {
        if (why) *why = "no pipe";
        return false;
    }
    Handle hr(out_r), hw(out_w), er(err_r), ew(err_w);
    SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);

    // Only these two handles reach the child, nothing else this process holds.
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<char> attr_buf(size);
    auto attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attr_buf.data());
    HANDLE inherit[2] = {out_w, err_w};
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, &size) ||
        !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof inherit, nullptr,
                                   nullptr)) {
        if (why) *why = "no attribute list";
        return false;
    }
    STARTUPINFOEXW si{};
    si.StartupInfo.cb = sizeof si;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = nullptr;
    si.StartupInfo.hStdOutput = out_w;
    si.StartupInfo.hStdError = err_w;
    si.lpAttributeList = attrs;

    Handle job(sandbox_job());
    if (!job.h) {
        DeleteProcThreadAttributeList(attrs);
        if (why) *why = "no job object";
        return false;
    }
    DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS;
    PROCESS_INFORMATION pi{};
    Handle token(low_integrity_token());
    BOOL started = token.h && CreateProcessAsUserW(token.h, app.c_str(), cmdline.data(), nullptr, nullptr, TRUE,
                                                   flags, nullptr, nullptr, &si.StartupInfo, &pi);
    if (!started) {
        // Some systems refuse the low-integrity start; the job's limits still hold.
        started = CreateProcessW(app.c_str(), cmdline.data(), nullptr, nullptr, TRUE, flags, nullptr, nullptr,
                                 &si.StartupInfo, &pi);
    }
    DeleteProcThreadAttributeList(attrs);
    if (!started) {
        if (why) *why = "could not start the converter";
        return false;
    }
    Handle process(pi.hProcess), thread(pi.hThread);
    if (!AssignProcessToJobObject(job.h, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1);
        if (why) *why = "could not confine the converter";
        return false;
    }
    ResumeThread(pi.hThread);
    hw.reset();
    ew.reset();

    std::atomic<bool> timed_out{false};
    std::thread watchdog([&] {
        if (WaitForSingleObject(pi.hProcess, kConvertTimeoutMs) == WAIT_TIMEOUT) {
            timed_out = true;
            TerminateJobObject(job.h, 1);
        }
    });
    std::string err;
    std::thread err_reader([&] {
        char buf[1024];
        DWORD n = 0;
        while (ReadFile(er.h, buf, sizeof buf, &n, nullptr) && n > 0)
            if (err.size() < 4096) err.append(buf, n);
    });

    Handle file(CreateFileW(out.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    bool wrote_all = file.h != nullptr;
    std::vector<char> buf(1 << 16);
    DWORD n = 0;
    unsigned long long total = 0;
    while (ReadFile(hr.h, buf.data(), DWORD(buf.size()), &n, nullptr) && n > 0) {
        DWORD done = 0;
        if (wrote_all && (!WriteFile(file.h, buf.data(), n, &done, nullptr) || done != n)) wrote_all = false;
        total += n;
    }
    if (!wrote_all) TerminateJobObject(job.h, 1);
    WaitForSingleObject(pi.hProcess, INFINITE);
    watchdog.join();
    err_reader.join();
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    file.reset();
    if (code == 0 && wrote_all && total > 0 && !timed_out) return true;
    if (why) {
        *why = timed_out ? "took longer than 30 minutes" : !wrote_all ? "could not write the cache" : trim(err);
        if (why->empty()) *why = "the converter stopped (" + std::to_string(code) + ")";
    }
    std::error_code ec;
    fs::remove(out, ec);
    return false;
}

}  // namespace

std::string random_bytes(std::size_t n) {
    std::string out(n, '\0');
    if (n && !BCRYPT_SUCCESS(BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(out.data()), ULONG(n),
                                             BCRYPT_USE_SYSTEM_PREFERRED_RNG)))
        throw std::runtime_error("no system randomness");
    return out;
}

std::optional<Sealed> seal_secret(const std::string& plain) {
    DATA_BLOB in{DWORD(plain.size()), reinterpret_cast<BYTE*>(const_cast<char*>(plain.data()))};
    DATA_BLOB entropy{DWORD(sizeof kEntropy - 1), reinterpret_cast<BYTE*>(const_cast<char*>(kEntropy))};
    DATA_BLOB out{};
    if (!CryptProtectData(&in, L"Clew audio server secret", &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN,
                          &out))
        return std::nullopt;
    std::string blob(reinterpret_cast<char*>(out.pbData), out.cbData);
    LocalFree(out.pbData);
    return Sealed{"dpapi", base64_encode(blob)};
}

std::optional<std::string> open_secret(const Sealed& sealed) {
    if (sealed.kind != "dpapi") return std::nullopt;
    auto blob = base64_decode(sealed.data);
    if (!blob || blob->empty()) return std::nullopt;
    DATA_BLOB in{DWORD(blob->size()), reinterpret_cast<BYTE*>(blob->data())};
    DATA_BLOB entropy{DWORD(sizeof kEntropy - 1), reinterpret_cast<BYTE*>(const_cast<char*>(kEntropy))};
    DATA_BLOB out{};
    if (!CryptUnprotectData(&in, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out))
        return std::nullopt;
    std::string plain(reinterpret_cast<char*>(out.pbData), out.cbData);
    SecureZeroMemory(out.pbData, out.cbData);
    LocalFree(out.pbData);
    return plain;
}

fs::path config_dir() { return known_folder(FOLDERID_RoamingAppData) / "clew-audio-server"; }

fs::path cache_dir() { return known_folder(FOLDERID_LocalAppData) / "clew-audio-server" / "cache"; }

fs::path self_path() {
    std::wstring buf(MAX_PATH, L'\0');
    while (true) {
        DWORD n = GetModuleFileNameW(nullptr, buf.data(), DWORD(buf.size()));
        if (n < buf.size()) {
            buf.resize(n);
            return buf;
        }
        buf.resize(buf.size() * 2);
    }
}

bool can_convert() { return win::media_foundation_present(); }

bool convert_to_mp3(const fs::path& in, const fs::path& out, std::string* why) {
    std::wstring app = self_path().wstring();
    std::wstring cmd = win::quote_arg(app) + L" --convert-child " + win::quote_arg(in.wstring());
    return run_sandboxed(app, cmd, out, why);
}

bool ffmpeg_to_mp3(const fs::path& ffmpeg, const fs::path& in, const fs::path& out, std::string* why) {
    std::error_code ec;
    if (!fs::is_regular_file(ffmpeg, ec)) {
        if (why) *why = "not a file: " + ffmpeg.u8string();
        return false;
    }
    std::wstring app = ffmpeg.wstring();
    std::wstring cmd = win::quote_arg(app) +
                       L" -nostdin -hide_banner -loglevel error -i " + win::quote_arg(in.wstring()) +
                       L" -map 0:a:0 -map_metadata -1 -c:a libmp3lame -b:a 128k -write_xing 0 -id3v2_version 0"
                       L" -f mp3 pipe:1";
    return run_sandboxed(app, cmd, out, why);
}

fs::path find_ffmpeg() {
    auto beside = self_path().parent_path() / "ffmpeg.exe";
    std::error_code ec;
    if (fs::is_regular_file(beside, ec)) return beside;
    wchar_t buf[MAX_PATH];
    DWORD n = SearchPathW(nullptr, L"ffmpeg.exe", nullptr, MAX_PATH, buf, nullptr);
    if (n > 0 && n < MAX_PATH) return fs::path(buf);
    return {};
}

}  // namespace clew::platform
