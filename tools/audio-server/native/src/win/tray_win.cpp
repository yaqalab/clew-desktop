// The tray icon and the settings window. The icon is Clew's "c" mark, ink on a light taskbar and cream
// on a dark one: as it is when Clew can reach the files, faded when stopped or something needs the
// user, with a badge while converting. One click opens the settings; the right-click
// menu has the everyday actions. Closing the window keeps the server running; "Quit" stops it.
// The window has two tabs: "Audio files" and "Dictation" (docs/28: the speech server on this
// computer, a child process). Both pages are in one dialog, shown and hidden by the tab strip.
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <windowsx.h>

#include <atomic>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "../../res/resource.h"
#include "../core/files.h"
#include "../core/platform.h"
#include "../core/service.h"
#include "../core/settings.h"
#include "../core/text.h"
#include "app.h"
#include "strings.h"
#include "util.h"

namespace clew::win {

namespace {

constexpr UINT WM_APP_TRAY = WM_APP + 1;
constexpr UINT WM_APP_STATUS = WM_APP + 2;
constexpr UINT WM_APP_SHOW = WM_APP + 3;
constexpr UINT_PTR kRefreshTimer = 1;
const wchar_t kWindowClass[] = L"ClewAudioServerTray";
const wchar_t kMutex[] = L"Local\\ClewAudioServer.SingleInstance";
const wchar_t kRunKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const wchar_t kRunValue[] = L"ClewAudioServer";

enum MenuId {
    ID_OPEN = 1,
    ID_COPY_SECRET,
    ID_COPY_ADDRESS,
    ID_OPEN_FOLDER,
    ID_STARTSTOP,
    ID_DICTATION,
    ID_COPY_STT_KEY,
    ID_AUTOSTART,
    ID_QUIT
};

const int kAudioPage[] = {IDC_STATUS,    IDC_STARTSTOP,   IDC_G_FOLDER,  IDC_FOLDER,    IDC_BROWSE,   IDC_OPENFOLDER,
                          IDC_G_CONN,    IDC_L_PORT,      IDC_PORT,      IDC_L_HOURS,   IDC_HOURS,    IDC_L_ORIGINS,
                          IDC_ORIGINS,   IDC_G_SECRET,    IDC_SECRET,    IDC_SHOW,      IDC_COPY,     IDC_NEWSECRET,
                          IDC_L_SECRET,  IDC_G_CONVERT,   IDC_CONVERT,   IDC_PREPARE,   IDC_L_FFMPEG, IDC_FFMPEG,
                          IDC_FFBROWSE,  IDC_FFFIND,      IDC_L_FFHINT,  IDC_L_CACHE,   IDC_CACHEMB,  IDC_CACHEUSED,
                          IDC_CLEARCACHE};
const int kDictationPage[] = {IDC_STT_STATUS,   IDC_STT_STARTSTOP, IDC_G_STT_MODEL,   IDC_STT_SMALL,   IDC_STT_DL_SMALL,
                              IDC_STT_TURBO,    IDC_STT_DL_TURBO,  IDC_G_STT_FOLDER,  IDC_STT_FOLDER,  IDC_STT_CHANGE,
                              IDC_STT_OPENFOLDER, IDC_STT_FREE,    IDC_G_STT_CONN,    IDC_L_STT_LANG,  IDC_STT_LANG,
                              IDC_L_STT_PORT,   IDC_STT_PORT,      IDC_G_STT_KEY,     IDC_STT_KEY,     IDC_STT_SHOWKEY,
                              IDC_STT_COPYKEY,  IDC_STT_NEWKEY,    IDC_L_STT_KEY,     IDC_STT_AUTOSTART, IDC_L_STT_LOCAL};
// The models' radio buttons and download buttons, in kSttModels' order.
const int kModelRadio[] = {IDC_STT_SMALL, IDC_STT_TURBO};
const int kModelDownload[] = {IDC_STT_DL_SMALL, IDC_STT_DL_TURBO};
static_assert(std::size(kModelRadio) == std::size(kSttModels), "one radio button per model");
// The language list, in the combo box's order. Whisper knows many more; these are the ones Clew
// offers (docs/28 §3.5).
const char* const kLanguages[] = {"", "en", "ja", "fr", "mg"};

struct App {
    HINSTANCE inst = nullptr;
    HWND hwnd = nullptr;
    HWND dlg = nullptr;
    Service* svc = nullptr;
    UINT taskbar_created = 0;
    std::atomic<bool> status_pending{false};
    bool secret_visible = false;
    bool stt_key_visible = false;
    int tab = 0;
    bool stopped_by_user = false;
    // A fixed identity for the tray icon: Windows then keeps the user's "show in the taskbar" choice
    // across updates. Windows ties it to the signed program; when it refuses, the icon goes by id.
    bool use_guid = true;
} g;

// {9C2E6B1A-4F7D-4E3B-8A1C-5D0F2B7E9A43}
const GUID kTrayGuid = {0x9c2e6b1a, 0x4f7d, 0x4e3b, {0x8a, 0x1c, 0x5d, 0x0f, 0x2b, 0x7e, 0x9a, 0x43}};

void identify(NOTIFYICONDATAW& nid) {
    nid.cbSize = sizeof nid;
    nid.hWnd = g.hwnd;
    nid.uID = 1;
    if (g.use_guid) {
        nid.uFlags |= NIF_GUID;
        nid.guidItem = kTrayGuid;
    }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

bool autostart_on() {
    wchar_t buf[MAX_PATH * 2];
    DWORD size = sizeof buf;
    return RegGetValueW(HKEY_CURRENT_USER, kRunKey, kRunValue, RRF_RT_REG_SZ, nullptr, buf, &size) == ERROR_SUCCESS;
}

void set_autostart(bool on) {
    if (on) {
        std::wstring cmd = quote_arg(platform::self_path().wstring());
        RegSetKeyValueW(HKEY_CURRENT_USER, kRunKey, kRunValue, REG_SZ, cmd.c_str(),
                        DWORD((cmd.size() + 1) * sizeof(wchar_t)));
    } else {
        RegDeleteKeyValueW(HKEY_CURRENT_USER, kRunKey, kRunValue);
    }
}

// The secret stays out of Windows' clipboard history and cloud clipboard.
void copy_text(HWND owner, const std::wstring& text, bool sensitive) {
    if (!OpenClipboard(owner)) return;
    EmptyClipboard();
    HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, (text.size() + 1) * sizeof(wchar_t));
    if (mem) {
        memcpy(GlobalLock(mem), text.c_str(), (text.size() + 1) * sizeof(wchar_t));
        GlobalUnlock(mem);
        if (!SetClipboardData(CF_UNICODETEXT, mem)) GlobalFree(mem);
    }
    if (sensitive) {
        UINT exclude = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
        UINT history = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
        UINT cloud = RegisterClipboardFormatW(L"CanUploadToCloudClipboard");
        for (UINT fmt : {history, cloud}) {
            HGLOBAL zero = GlobalAlloc(GMEM_MOVEABLE, sizeof(DWORD));
            if (!zero) continue;
            *static_cast<DWORD*>(GlobalLock(zero)) = 0;
            GlobalUnlock(zero);
            if (!SetClipboardData(fmt, zero)) GlobalFree(zero);
        }
        HGLOBAL empty = GlobalAlloc(GMEM_MOVEABLE, 1);
        if (empty && !SetClipboardData(exclude, empty)) GlobalFree(empty);
    }
    CloseClipboard();
}

std::wstring problem_text(const std::string& p, int port) {
    if (p == "no folder chosen") return tr(S::ProblemNoFolder);
    if (starts_with(p, "port ") && p.find("in use") != std::string::npos) return trf(S::ProblemPortInUse, port);
    if (starts_with(p, "the folder cannot be opened")) return tr(S::ProblemFolderGone);
    return widen(p);
}

std::wstring human_size(std::uint64_t bytes) {
    wchar_t buf[64];
    if (bytes >= 1024ull * 1024 * 1024)
        swprintf_s(buf, L"%.1f GB", double(bytes) / (1024.0 * 1024 * 1024));
    else
        swprintf_s(buf, L"%.0f MB", double(bytes) / (1024.0 * 1024));
    return buf;
}

std::wstring window_text(HWND dlg, int id) {
    HWND h = GetDlgItem(dlg, id);
    int n = GetWindowTextLengthW(h);
    std::wstring s(std::size_t(n) + 1, L'\0');
    GetWindowTextW(h, s.data(), n + 1);
    s.resize(std::size_t(n));
    return s;
}

std::wstring pick(HWND owner, bool folder, const std::wstring& start, const wchar_t* title = nullptr) {
    IFileOpenDialog* d = nullptr;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&d)))) return {};
    DWORD opts = 0;
    d->GetOptions(&opts);
    d->SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | (folder ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST));
    d->SetTitle(title ? title : tr(folder ? S::ChooseFolder : S::ChooseFfmpeg));
    if (!folder) {
        COMDLG_FILTERSPEC spec{L"ffmpeg.exe", L"ffmpeg.exe;*.exe"};
        d->SetFileTypes(1, &spec);
    }
    if (!start.empty()) {
        IShellItem* item = nullptr;
        if (SUCCEEDED(SHCreateItemFromParsingName(start.c_str(), nullptr, IID_PPV_ARGS(&item)))) {
            d->SetFolder(item);
            item->Release();
        }
    }
    std::wstring out;
    if (SUCCEEDED(d->Show(owner))) {
        IShellItem* item = nullptr;
        if (SUCCEEDED(d->GetResult(&item))) {
            PWSTR p = nullptr;
            if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p))) {
                out = p;
                CoTaskMemFree(p);
            }
            item->Release();
        }
    }
    d->Release();
    return out;
}

void open_folder() {
    std::wstring folder = widen(g.svc->settings().folder);
    std::error_code ec;
    if (!folder.empty() && std::filesystem::is_directory(folder, ec))
        ShellExecuteW(nullptr, L"open", folder.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// The space left on the drive of `p`, which need not exist yet. 0 when unknown.
std::uint64_t free_space(std::filesystem::path p) {
    std::error_code ec;
    while (!p.empty() && !std::filesystem::exists(p, ec) && p.has_parent_path() && p.parent_path() != p)
        p = p.parent_path();
    auto space = std::filesystem::space(p, ec);
    return ec ? 0 : space.available;
}

void toggle_dictation() {
    if (g.svc->dictation().wanted())
        g.svc->dictation().stop();
    else
        g.svc->dictation().start();
}

// ---------------------------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------------------------

// Whether the taskbar is light (Windows' "default app mode" and "Windows mode" are separate; the
// tray follows the latter).
bool light_taskbar() {
    DWORD v = 0, size = sizeof v;
    return RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                        L"SystemUsesLightTheme", RRF_RT_REG_DWORD, nullptr, &v, &size) == ERROR_SUCCESS &&
           v == 1;
}

void tray(DWORD message) {
    auto st = g.svc->status();
    bool light = light_taskbar();
    int icon = !st.converting.empty()            ? (light ? IDI_TRAY_BUSY : IDI_TRAY_BUSY_DARK)
               : st.running && st.problem.empty() ? (light ? IDI_TRAY_ON : IDI_TRAY_ON_DARK)
                                                  : (light ? IDI_TRAY_OFF : IDI_TRAY_OFF_DARK);
    std::wstring tip = !st.converting.empty()            ? trf(S::TipConverting, widen(st.converting).c_str())
                       : !st.running && g.stopped_by_user ? std::wstring(tr(S::TipStopped))
                       : !st.problem.empty()             ? trf(S::TipProblem, problem_text(st.problem, st.port).c_str())
                                                         : trf(S::TipRunning, st.port);
    NOTIFYICONDATAW nid{};
    nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP | NIF_MESSAGE;
    identify(nid);
    nid.uCallbackMessage = WM_APP_TRAY;
    LoadIconMetric(g.inst, MAKEINTRESOURCEW(icon), LIM_SMALL, &nid.hIcon);
    wcsncpy_s(nid.szTip, tip.c_str(), _TRUNCATE);
    if (!Shell_NotifyIconW(message, &nid) && message == NIM_ADD && g.use_guid) {
        // A copy that ended without removing its icon still holds the identity: remove, then retry.
        NOTIFYICONDATAW stale{};
        identify(stale);
        Shell_NotifyIconW(NIM_DELETE, &stale);
        if (!Shell_NotifyIconW(NIM_ADD, &nid)) {
            // Windows ties the identity to another copy of the program: go by id instead.
            g.use_guid = false;
            nid.uFlags &= ~NIF_GUID;
            Shell_NotifyIconW(NIM_ADD, &nid);
        }
    }
    if (message == NIM_ADD) {
        nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &nid);
    }
    if (nid.hIcon) DestroyIcon(nid.hIcon);
}

void show_settings();

void menu(int x, int y) {
    auto st = g.svc->status();
    HMENU m = CreatePopupMenu();
    std::wstring head = st.running ? trf(S::MenuStatusRunning, st.port) : std::wstring(tr(S::MenuStatusStopped));
    AppendMenuW(m, MF_STRING | MF_GRAYED, 0, head.c_str());
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING, ID_OPEN, tr(S::MenuOpen));
    AppendMenuW(m, MF_STRING, ID_COPY_SECRET, tr(S::MenuCopySecret));
    AppendMenuW(m, MF_STRING | (st.running ? 0 : MF_GRAYED), ID_COPY_ADDRESS, tr(S::MenuCopyAddress));
    AppendMenuW(m, MF_STRING | (st.folder.empty() ? MF_GRAYED : 0), ID_OPEN_FOLDER, tr(S::MenuOpenFolder));
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING, ID_STARTSTOP, tr(st.running ? S::MenuStop : S::MenuStart));
    bool dictating = g.svc->dictation().wanted();
    AppendMenuW(m, MF_STRING, ID_DICTATION, tr(dictating ? S::MenuDictationStop : S::MenuDictationStart));
    AppendMenuW(m, MF_STRING, ID_COPY_STT_KEY, tr(S::MenuCopySttKey));
    AppendMenuW(m, MF_STRING | (autostart_on() ? MF_CHECKED : 0), ID_AUTOSTART, tr(S::MenuAutostart));
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING, ID_QUIT, tr(S::MenuQuit));
    SetMenuDefaultItem(m, ID_OPEN, FALSE);
    SetForegroundWindow(g.hwnd);
    UINT flags = TPM_RETURNCMD | TPM_RIGHTBUTTON | (GetSystemMetrics(SM_MENUDROPALIGNMENT) ? TPM_RIGHTALIGN : 0);
    int cmd = TrackPopupMenuEx(m, flags, x, y, g.hwnd, nullptr);
    PostMessageW(g.hwnd, WM_NULL, 0, 0);
    DestroyMenu(m);
    switch (cmd) {
        case ID_OPEN: show_settings(); break;
        case ID_COPY_SECRET: copy_text(g.hwnd, widen(g.svc->secret()), true); break;
        case ID_COPY_ADDRESS: copy_text(g.hwnd, L"http://127.0.0.1:" + std::to_wstring(st.port), false); break;
        case ID_OPEN_FOLDER: open_folder(); break;
        case ID_STARTSTOP:
            if (st.running) {
                g.stopped_by_user = true;
                g.svc->stop();
            } else {
                g.stopped_by_user = false;
                g.svc->apply(g.svc->settings(), false);
            }
            break;
        case ID_DICTATION: toggle_dictation(); break;
        case ID_COPY_STT_KEY: copy_text(g.hwnd, widen(g.svc->stt_key()), true); break;
        case ID_AUTOSTART: set_autostart(!autostart_on()); break;
        case ID_QUIT: DestroyWindow(g.hwnd); break;
    }
}

// ---------------------------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------------------------

void message(HWND dlg, const std::wstring& text) { SetDlgItemTextW(dlg, IDC_MESSAGE, text.c_str()); }

void refresh_cache(HWND dlg) {
    SetDlgItemTextW(dlg, IDC_CACHEUSED, trf(S::CacheUsed, human_size(g.svc->cache().bytes_on_disk()).c_str()).c_str());
}

void refresh_dictation(HWND dlg);

void refresh_status(HWND dlg) {
    auto st = g.svc->status();
    std::wstring text = !st.converting.empty()                ? trf(S::TipConverting, widen(st.converting).c_str())
                        : !st.running && g.stopped_by_user    ? std::wstring(tr(S::StatusStopped))
                        : !st.problem.empty()                 ? trf(S::StatusProblem, problem_text(st.problem, st.port).c_str())
                        : st.running                          ? trf(S::StatusRunning, st.port, st.requests)
                                                              : std::wstring(tr(S::StatusStopped));
    SetDlgItemTextW(dlg, IDC_STATUS, text.c_str());
    SetDlgItemTextW(dlg, IDC_STARTSTOP, tr(st.running ? S::Stop : S::Start));

    HWND list = GetDlgItem(dlg, IDC_ACTIVITY);
    auto lines = g.svc->recent();
    SendMessageW(list, WM_SETREDRAW, FALSE, 0);
    SendMessageW(list, LB_RESETCONTENT, 0, 0);
    for (const auto& l : lines) SendMessageW(list, LB_ADDSTRING, 0, LPARAM(widen(l).c_str()));
    if (!lines.empty()) SendMessageW(list, LB_SETTOPINDEX, WPARAM(lines.size() - 1), 0);
    SendMessageW(list, WM_SETREDRAW, TRUE, 0);
    InvalidateRect(list, nullptr, TRUE);
    refresh_dictation(dlg);
}

std::wstring stt_problem_text(const std::string& p, int port) {
    if (starts_with(p, "port ") && p.find("in use") != std::string::npos) return trf(S::ProblemPortInUse, port);
    if (starts_with(p, "not enough memory")) return tr(S::SttNoMemory);
    return widen(p);
}

const wchar_t* languages_text(const std::string& code) {
    return code == "en"   ? tr(S::LangEnglish)
           : code == "ja" ? tr(S::LangJapanese)
           : code == "fr" ? tr(S::LangFrench)
           : code == "mg" ? tr(S::LangMalagasy)
                          : tr(S::LangPerSession);
}

void refresh_dictation(HWND dlg) {
    auto st = g.svc->dictation().status();
    Settings s = g.svc->settings();
    std::wstring model = widen(st.model.empty() ? s.stt_model : st.model);
    std::wstring text;
    switch (st.state) {
        case Dictation::State::Off: text = tr(S::SttOff); break;
        case Dictation::State::Missing: text = tr(S::SttMissing); break;
        case Dictation::State::NoModel: text = trf(S::SttNoModel, model.c_str()); break;
        case Dictation::State::Loading: text = trf(S::SttLoading, model.c_str()); break;
        case Dictation::State::Ready: text = trf(S::SttReady, model.c_str(), languages_text(s.stt_language)); break;
        case Dictation::State::Failed:
            text = trf(S::SttFailed, stt_problem_text(st.problem, s.stt_port).c_str());
            break;
    }
    // A download says how far it is on its own button; a failed one says why here, first.
    if (st.downloading.empty() && !st.download_problem.empty())
        text = trf(S::SttDownloadFailed, widen(st.download_problem).c_str()) + L"\n" + text;
    SetDlgItemTextW(dlg, IDC_STT_STATUS, text.c_str());
    bool wanted = g.svc->dictation().wanted();
    SetDlgItemTextW(dlg, IDC_STT_STARTSTOP, tr(wanted ? S::Stop : S::Start));
    EnableWindow(GetDlgItem(dlg, IDC_STT_STARTSTOP), wanted || st.state != Dictation::State::Missing);

    auto dir = g.svc->stt_models_dir();
    bool installed = st.state != Dictation::State::Missing && !platform::find_stt_server().empty();
    for (std::size_t i = 0; i < std::size(kSttModels); ++i) {
        const auto& m = kSttModels[i];
        bool here = Dictation::model_present(dir, m.name);
        std::wstring line = trf(S::SttModelLine, widen(m.name).c_str(), human_size(m.bytes).c_str(),
                                tr(m.live ? S::SttUseLive : S::SttUseFiles), tr(here ? S::SttHere : S::SttNotHere));
        SetDlgItemTextW(dlg, kModelRadio[i], line.c_str());
        // A model that is not here cannot be chosen, unless it already is.
        bool chosen = IsDlgButtonChecked(dlg, kModelRadio[i]) == BST_CHECKED;
        EnableWindow(GetDlgItem(dlg, kModelRadio[i]), here || chosen);
        EnableWindow(GetDlgItem(dlg, kModelDownload[i]), !here && installed && st.downloading.empty());
        bool fetching = st.downloading == m.name;
        SetDlgItemTextW(dlg, kModelDownload[i],
                        fetching ? (std::to_wstring(st.percent) + L" %").c_str() : tr(S::SttDownload));
    }
    std::uint64_t free = free_space(dir);
    SetDlgItemTextW(dlg, IDC_STT_FREE, free ? trf(S::SttFree, human_size(free).c_str()).c_str() : L"");
}

void download_model(HWND dlg, const SttModel& m) {
    auto dir = g.svc->stt_models_dir();
    std::uint64_t free = free_space(dir);
    std::uint64_t need = m.bytes + m.bytes / 20;
    if (free && free < need) {
        MessageBoxW(dlg, trf(S::SttNoSpace, human_size(need).c_str(), human_size(free).c_str()).c_str(),
                    tr(S::AppName), MB_OK | MB_ICONWARNING);
        return;
    }
    std::wstring ask = trf(S::SttDownloadConfirm, widen(m.name).c_str(), human_size(m.bytes).c_str(),
                           dir.wstring().c_str(), free ? human_size(free).c_str() : L"?");
    if (MessageBoxW(dlg, ask.c_str(), tr(S::AppName), MB_OKCANCEL | MB_ICONQUESTION) != IDOK) return;
    g.svc->dictation().download(m.name);
    refresh_dictation(dlg);
}

void show_page(HWND dlg, int tab) {
    g.tab = tab;
    for (int id : kAudioPage) ShowWindow(GetDlgItem(dlg, id), tab == 0 ? SW_SHOW : SW_HIDE);
    for (int id : kDictationPage) ShowWindow(GetDlgItem(dlg, id), tab == 1 ? SW_SHOW : SW_HIDE);
    TabCtrl_SetCurSel(GetDlgItem(dlg, IDC_TABS), tab);
}

void show_stt_key(HWND dlg, bool visible) {
    g.stt_key_visible = visible;
    HWND edit = GetDlgItem(dlg, IDC_STT_KEY);
    SendMessageW(edit, EM_SETPASSWORDCHAR, visible ? 0 : WPARAM(L'●'), 0);
    SetDlgItemTextW(dlg, IDC_STT_SHOWKEY, tr(visible ? S::Hide : S::Show));
    InvalidateRect(edit, nullptr, TRUE);
}

void show_secret(HWND dlg, bool visible) {
    g.secret_visible = visible;
    HWND edit = GetDlgItem(dlg, IDC_SECRET);
    SendMessageW(edit, EM_SETPASSWORDCHAR, visible ? 0 : WPARAM(L'●'), 0);
    SetDlgItemTextW(dlg, IDC_SHOW, tr(visible ? S::Hide : S::Show));
    InvalidateRect(edit, nullptr, TRUE);
}

void fill(HWND dlg) {
    Settings s = g.svc->settings();
    SetDlgItemTextW(dlg, IDC_FOLDER, widen(s.folder).c_str());
    SetDlgItemInt(dlg, IDC_PORT, UINT(s.port), FALSE);
    SetDlgItemInt(dlg, IDC_HOURS, UINT(s.link_hours), FALSE);
    std::wstring origins;
    for (const auto& o : s.origins) origins += widen(o) + L"\r\n";
    SetDlgItemTextW(dlg, IDC_ORIGINS, origins.c_str());
    SetDlgItemTextW(dlg, IDC_SECRET, widen(g.svc->secret()).c_str());
    CheckDlgButton(dlg, IDC_CONVERT, s.convert ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(dlg, IDC_PREPARE, s.prepare ? BST_CHECKED : BST_UNCHECKED);
    SetDlgItemTextW(dlg, IDC_FFMPEG, widen(s.ffmpeg).c_str());
    SetDlgItemInt(dlg, IDC_CACHEMB, UINT(s.cache_mb), FALSE);
    CheckDlgButton(dlg, IDC_AUTOSTART, autostart_on() ? BST_CHECKED : BST_UNCHECKED);

    for (std::size_t i = 0; i < std::size(kSttModels); ++i)
        CheckDlgButton(dlg, kModelRadio[i], s.stt_model == kSttModels[i].name ? BST_CHECKED : BST_UNCHECKED);
    SetDlgItemTextW(dlg, IDC_STT_FOLDER, g.svc->stt_models_dir().wstring().c_str());
    int lang = 0;
    for (int i = 0; i < int(std::size(kLanguages)); ++i)
        if (s.stt_language == kLanguages[i]) lang = i;
    SendDlgItemMessageW(dlg, IDC_STT_LANG, CB_SETCURSEL, WPARAM(lang), 0);
    SetDlgItemInt(dlg, IDC_STT_PORT, UINT(s.stt_port), FALSE);
    SetDlgItemTextW(dlg, IDC_STT_KEY, widen(g.svc->stt_key()).c_str());
    CheckDlgButton(dlg, IDC_STT_AUTOSTART, s.stt_enabled ? BST_CHECKED : BST_UNCHECKED);
}

void label(HWND dlg) {
    SetWindowTextW(dlg, tr(S::AppName));
    struct {
        int id;
        S s;
    } const texts[] = {
        {IDC_G_FOLDER, S::GroupFolder},   {IDC_BROWSE, S::Browse},       {IDC_OPENFOLDER, S::Open},
        {IDC_G_CONN, S::GroupConnection}, {IDC_L_PORT, S::Port},         {IDC_L_HOURS, S::LinkHours},
        {IDC_L_ORIGINS, S::Origins},      {IDC_G_SECRET, S::GroupSecret}, {IDC_L_SECRET, S::SecretHint},
        {IDC_SHOW, S::Show},              {IDC_COPY, S::Copy},           {IDC_NEWSECRET, S::NewSecret},
        {IDC_G_CONVERT, S::GroupConversion}, {IDC_CONVERT, S::Convert},  {IDC_PREPARE, S::Prepare},
        {IDC_L_FFMPEG, S::Ffmpeg},        {IDC_FFBROWSE, S::Browse},     {IDC_FFFIND, S::FfmpegFind},
        {IDC_L_FFHINT, S::FfmpegHint},    {IDC_L_CACHE, S::CacheLimit},  {IDC_CLEARCACHE, S::ClearCache},
        {IDC_AUTOSTART, S::Autostart},    {IDC_L_ACTIVITY, S::Activity}, {IDOK, S::Save},
        {IDCANCEL, S::Close},
        {IDC_G_STT_MODEL, S::GroupSttModel}, {IDC_STT_DL_SMALL, S::SttDownload}, {IDC_STT_DL_TURBO, S::SttDownload},
        {IDC_G_STT_FOLDER, S::GroupSttFolder}, {IDC_STT_CHANGE, S::Change}, {IDC_STT_OPENFOLDER, S::Open},
        {IDC_G_STT_CONN, S::GroupSttConn}, {IDC_L_STT_LANG, S::Language}, {IDC_L_STT_PORT, S::Port},
        {IDC_G_STT_KEY, S::GroupSttKey},  {IDC_STT_SHOWKEY, S::Show},   {IDC_STT_COPYKEY, S::Copy},
        {IDC_STT_NEWKEY, S::NewKey},   {IDC_L_STT_KEY, S::SttKeyHint}, {IDC_STT_AUTOSTART, S::SttAutostart},
        {IDC_L_STT_LOCAL, S::SttLocal},
    };
    for (const auto& t : texts) SetDlgItemTextW(dlg, t.id, tr(t.s));
    SendDlgItemMessageW(dlg, IDC_STT_LANG, CB_RESETCONTENT, 0, 0);
    for (S s : {S::LangChosen, S::LangEnglish, S::LangJapanese, S::LangFrench, S::LangMalagasy})
        SendDlgItemMessageW(dlg, IDC_STT_LANG, CB_ADDSTRING, 0, LPARAM(tr(s)));
    SendDlgItemMessageW(dlg, IDC_STT_PORT, EM_LIMITTEXT, 5, 0);
    HWND tabs = GetDlgItem(dlg, IDC_TABS);
    TabCtrl_DeleteAllItems(tabs);
    S tab_names[] = {S::TabAudio, S::TabDictation};
    for (int i = 0; i < 2; ++i) {
        TCITEMW item{};
        item.mask = TCIF_TEXT;
        item.pszText = const_cast<LPWSTR>(tr(tab_names[i]));
        TabCtrl_InsertItem(tabs, i, &item);
    }
    SendDlgItemMessageW(dlg, IDC_PORT, EM_LIMITTEXT, 5, 0);
    SendDlgItemMessageW(dlg, IDC_HOURS, EM_LIMITTEXT, 3, 0);
    SendDlgItemMessageW(dlg, IDC_CACHEMB, EM_LIMITTEXT, 7, 0);
    SendDlgItemMessageW(dlg, IDC_ORIGINS, EM_LIMITTEXT, 4000, 0);
}

bool read_int(HWND dlg, int id, int lo, int hi, int* out) {
    BOOL ok = FALSE;
    UINT v = GetDlgItemInt(dlg, id, &ok, FALSE);
    if (!ok || int(v) < lo || int(v) > hi) return false;
    *out = int(v);
    return true;
}

void bad(HWND dlg, int id, const std::wstring& text) {
    message(dlg, text);
    MessageBeep(MB_ICONWARNING);
    SetFocus(GetDlgItem(dlg, id));
    SendDlgItemMessageW(dlg, id, EM_SETSEL, 0, -1);
}

void save(HWND dlg) {
    Settings s = g.svc->settings();
    std::wstring folder = window_text(dlg, IDC_FOLDER);
    folder = widen(trim(narrow(folder)));
    std::error_code ec;
    if (!folder.empty() && !std::filesystem::is_directory(folder, ec)) return bad(dlg, IDC_FOLDER, tr(S::BadFolder));
    if (!read_int(dlg, IDC_PORT, 1024, 65535, &s.port)) return bad(dlg, IDC_PORT, tr(S::BadPort));
    if (!read_int(dlg, IDC_HOURS, 1, 168, &s.link_hours)) return bad(dlg, IDC_HOURS, tr(S::BadHours));
    if (!read_int(dlg, IDC_CACHEMB, 256, 1024 * 1024, &s.cache_mb)) return bad(dlg, IDC_CACHEMB, tr(S::BadCache));
    std::vector<std::string> origins;
    std::string lines = narrow(window_text(dlg, IDC_ORIGINS));
    std::size_t at = 0;
    while (at <= lines.size()) {
        std::size_t end = lines.find('\n', at);
        if (end == std::string::npos) end = lines.size();
        std::string line = trim(lines.substr(at, end - at));
        at = end + 1;
        if (line.empty()) continue;
        auto o = normalize_origin(line);
        if (!o) return bad(dlg, IDC_ORIGINS, trf(S::BadOrigin, widen(line).c_str()));
        origins.push_back(*o);
    }
    std::wstring ffmpeg = widen(trim(narrow(window_text(dlg, IDC_FFMPEG))));
    if (!ffmpeg.empty() && !std::filesystem::is_regular_file(ffmpeg, ec)) return bad(dlg, IDC_FFMPEG, tr(S::BadFfmpeg));
    if (!read_int(dlg, IDC_STT_PORT, 1024, 65535, &s.stt_port) || s.stt_port == s.port) {
        show_page(dlg, 1);
        return bad(dlg, IDC_STT_PORT, tr(S::BadSttPort));
    }
    for (std::size_t i = 0; i < std::size(kSttModels); ++i)
        if (IsDlgButtonChecked(dlg, kModelRadio[i]) == BST_CHECKED) s.stt_model = kSttModels[i].name;
    LRESULT lang = SendDlgItemMessageW(dlg, IDC_STT_LANG, CB_GETCURSEL, 0, 0);
    if (lang >= 0 && lang < LRESULT(std::size(kLanguages))) s.stt_language = kLanguages[lang];
    s.stt_enabled = IsDlgButtonChecked(dlg, IDC_STT_AUTOSTART) == BST_CHECKED;

    s.folder = narrow(folder);
    s.origins = origins;
    s.ffmpeg = narrow(ffmpeg);
    s.convert = IsDlgButtonChecked(dlg, IDC_CONVERT) == BST_CHECKED;
    s.prepare = IsDlgButtonChecked(dlg, IDC_PREPARE) == BST_CHECKED;
    set_autostart(IsDlgButtonChecked(dlg, IDC_AUTOSTART) == BST_CHECKED);
    g.stopped_by_user = false;
    std::string problem = g.svc->apply(s);
    fill(dlg);
    message(dlg, problem.empty() ? std::wstring(tr(S::Saved)) : problem_text(problem, s.port));
    refresh_status(dlg);
    tray(NIM_MODIFY);
}

INT_PTR CALLBACK settings_proc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_INITDIALOG: {
            HICON icon_big = nullptr, icon_small = nullptr;
            LoadIconMetric(g.inst, MAKEINTRESOURCEW(IDI_APP), LIM_LARGE, &icon_big);
            LoadIconMetric(g.inst, MAKEINTRESOURCEW(IDI_APP), LIM_SMALL, &icon_small);
            SendMessageW(dlg, WM_SETICON, ICON_BIG, LPARAM(icon_big));
            SendMessageW(dlg, WM_SETICON, ICON_SMALL, LPARAM(icon_small));
            label(dlg);
            fill(dlg);
            show_secret(dlg, false);
            show_stt_key(dlg, false);
            show_page(dlg, g.tab);
            refresh_status(dlg);
            refresh_cache(dlg);
            if (g.svc->settings().folder.empty()) message(dlg, tr(S::FirstRun));
            SetTimer(dlg, kRefreshTimer, 3000, nullptr);
            return TRUE;
        }
        case WM_TIMER:
            refresh_cache(dlg);
            return TRUE;
        case WM_APP_STATUS:
            refresh_status(dlg);
            return TRUE;
        case WM_NOTIFY: {
            auto* hdr = reinterpret_cast<NMHDR*>(lp);
            if (hdr->idFrom == IDC_TABS && hdr->code == TCN_SELCHANGE) {
                show_page(dlg, TabCtrl_GetCurSel(hdr->hwndFrom));
                return TRUE;
            }
            break;
        }
        case WM_COMMAND:
            switch (LOWORD(wp)) {
                case IDOK: save(dlg); return TRUE;
                case IDCANCEL: DestroyWindow(dlg); return TRUE;
                case IDC_STARTSTOP:
                    if (g.svc->status().running) {
                        g.stopped_by_user = true;
                        g.svc->stop();
                    } else {
                        g.stopped_by_user = false;
                        g.svc->apply(g.svc->settings(), false);
                    }
                    refresh_status(dlg);
                    return TRUE;
                case IDC_BROWSE: {
                    std::wstring p = pick(dlg, true, window_text(dlg, IDC_FOLDER));
                    if (!p.empty()) SetDlgItemTextW(dlg, IDC_FOLDER, p.c_str());
                    return TRUE;
                }
                case IDC_OPENFOLDER: open_folder(); return TRUE;
                case IDC_SHOW: show_secret(dlg, !g.secret_visible); return TRUE;
                case IDC_COPY:
                    copy_text(dlg, widen(g.svc->secret()), true);
                    message(dlg, tr(S::Copied));
                    return TRUE;
                case IDC_NEWSECRET:
                    if (MessageBoxW(dlg, tr(S::NewSecretConfirm), tr(S::AppName),
                                    MB_OKCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2) == IDOK) {
                        SetDlgItemTextW(dlg, IDC_SECRET, widen(g.svc->reset_secret()).c_str());
                        show_secret(dlg, true);
                    }
                    return TRUE;
                case IDC_FFBROWSE: {
                    std::wstring p = pick(dlg, false, {});
                    if (!p.empty()) SetDlgItemTextW(dlg, IDC_FFMPEG, p.c_str());
                    return TRUE;
                }
                case IDC_FFFIND: {
                    auto found = platform::find_ffmpeg();
                    if (found.empty())
                        message(dlg, tr(S::FfmpegNotFound));
                    else
                        SetDlgItemTextW(dlg, IDC_FFMPEG, found.c_str());
                    return TRUE;
                }
                case IDC_CLEARCACHE:
                    g.svc->cache().clear();
                    refresh_cache(dlg);
                    return TRUE;
                case IDC_STT_STARTSTOP:
                    toggle_dictation();
                    refresh_dictation(dlg);
                    return TRUE;
                case IDC_STT_DL_SMALL:
                case IDC_STT_DL_TURBO:
                    for (std::size_t i = 0; i < std::size(kSttModels); ++i)
                        if (kModelDownload[i] == LOWORD(wp)) download_model(dlg, kSttModels[i]);
                    return TRUE;
                case IDC_STT_CHANGE: {
                    // Takes effect at once: a download goes where the window says.
                    std::wstring p = pick(dlg, true, g.svc->stt_models_dir().wstring(), tr(S::ChooseModelsFolder));
                    if (p.empty()) return TRUE;
                    Settings s = g.svc->settings();
                    s.stt_models_dir = narrow(p);
                    g.svc->apply(s);
                    SetDlgItemTextW(dlg, IDC_STT_FOLDER, p.c_str());
                    refresh_dictation(dlg);
                    return TRUE;
                }
                case IDC_STT_OPENFOLDER: {
                    auto dir = g.svc->stt_models_dir();
                    std::error_code ec;
                    std::filesystem::create_directories(dir, ec);
                    ShellExecuteW(nullptr, L"open", dir.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                    return TRUE;
                }
                case IDC_STT_SHOWKEY: show_stt_key(dlg, !g.stt_key_visible); return TRUE;
                case IDC_STT_COPYKEY:
                    copy_text(dlg, widen(g.svc->stt_key()), true);
                    message(dlg, tr(S::Copied));
                    return TRUE;
                case IDC_STT_NEWKEY:
                    if (MessageBoxW(dlg, tr(S::NewSttKeyConfirm), tr(S::AppName),
                                    MB_OKCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2) == IDOK) {
                        SetDlgItemTextW(dlg, IDC_STT_KEY, widen(g.svc->reset_stt_key()).c_str());
                        show_stt_key(dlg, true);
                    }
                    return TRUE;
                case IDC_STT_SMALL:
                case IDC_STT_TURBO:
                    return TRUE;
            }
            break;
        case WM_DESTROY:
            KillTimer(dlg, kRefreshTimer);
            // Nothing of the secret stays in the closed window's memory longer than needed.
            SetDlgItemTextW(dlg, IDC_SECRET, L"");
            SetDlgItemTextW(dlg, IDC_STT_KEY, L"");
            g.dlg = nullptr;
            return TRUE;
    }
    return FALSE;
}

void show_settings() {
    if (!g.dlg) g.dlg = CreateDialogParamW(g.inst, MAKEINTRESOURCEW(IDD_SETTINGS), nullptr, settings_proc, 0);
    if (!g.dlg) return;
    ShowWindow(g.dlg, IsIconic(g.dlg) ? SW_RESTORE : SW_SHOW);
    SetForegroundWindow(g.dlg);
}

// ---------------------------------------------------------------------------------------------
// The hidden window that owns the tray icon
// ---------------------------------------------------------------------------------------------

LRESULT CALLBACK tray_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == g.taskbar_created && msg != 0) {
        tray(NIM_ADD);  // Explorer restarted: the icon must be added again.
        return 0;
    }
    switch (msg) {
        case WM_APP_TRAY:
            switch (LOWORD(lp)) {
                case NIN_SELECT:
                case NIN_KEYSELECT: show_settings(); return 0;
                case WM_CONTEXTMENU: menu(GET_X_LPARAM(wp), GET_Y_LPARAM(wp)); return 0;
            }
            return 0;
        case WM_APP_STATUS:
            g.status_pending = false;
            tray(NIM_MODIFY);
            if (g.dlg) SendMessageW(g.dlg, WM_APP_STATUS, 0, 0);
            return 0;
        case WM_APP_SHOW: show_settings(); return 0;
        case WM_SETTINGCHANGE:
            // The light/dark switch arrives as "ImmersiveColorSet".
            if (lp && wcscmp(reinterpret_cast<const wchar_t*>(lp), L"ImmersiveColorSet") == 0) tray(NIM_MODIFY);
            return 0;
        case WM_ENDSESSION:
            if (wp) DestroyWindow(hwnd);
            return 0;
        case WM_DESTROY: {
            NOTIFYICONDATAW nid{};
            identify(nid);
            Shell_NotifyIconW(NIM_DELETE, &nid);
            PostQuitMessage(0);
            return 0;
        }
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

int quit_running() {
    HWND other = FindWindowW(kWindowClass, nullptr);
    if (!other) return 0;
    DWORD pid = 0;
    GetWindowThreadProcessId(other, &pid);
    HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
    PostMessageW(other, WM_CLOSE, 0, 0);
    DWORD waited = process ? WaitForSingleObject(process, 10000) : WAIT_FAILED;
    if (process) CloseHandle(process);
    return waited == WAIT_OBJECT_0 ? 0 : 1;
}

int run_tray(HINSTANCE instance) {
    // One server per Windows session: a second start opens the first one's window instead.
    HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutex);
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND other = FindWindowW(kWindowClass, nullptr);
        if (other) {
            DWORD pid = 0;
            GetWindowThreadProcessId(other, &pid);
            AllowSetForegroundWindow(pid);
            PostMessageW(other, WM_APP_SHOW, 0, 0);
        } else {
            MessageBoxW(nullptr, tr(S::AlreadyRunning), tr(S::AppName), MB_OK | MB_ICONINFORMATION);
        }
        return 0;
    }
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    INITCOMMONCONTROLSEX icc{sizeof icc, ICC_STANDARD_CLASSES | ICC_TAB_CLASSES};
    InitCommonControlsEx(&icc);

    g.inst = instance;
    static Service svc(default_settings_file(), {}, nullptr);
    g.svc = &svc;

    WNDCLASSEXW wc{sizeof wc};
    wc.lpfnWndProc = tray_proc;
    wc.hInstance = instance;
    wc.lpszClassName = kWindowClass;
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_APP));
    RegisterClassExW(&wc);
    // A real (hidden) top-level window, not message-only: it must receive TaskbarCreated.
    g.hwnd = CreateWindowExW(0, kWindowClass, tr(S::AppName), WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, instance,
                             nullptr);
    g.taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");
    ChangeWindowMessageFilterEx(g.hwnd, g.taskbar_created, MSGFLT_ALLOW, nullptr);

    svc.on_change([] {
        // Many requests make many changes; one repaint is enough.
        if (!g.status_pending.exchange(true)) PostMessageW(g.hwnd, WM_APP_STATUS, 0, 0);
    });
    svc.secret();
    svc.apply(svc.settings(), false);
    svc.start_dictation_if_enabled();
    tray(NIM_ADD);
    if (svc.settings().folder.empty()) show_settings();

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        if (g.dlg && IsDialogMessageW(g.dlg, &m)) continue;
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    svc.stop();
    if (mutex) CloseHandle(mutex);
    // Connection threads and a running conversion are not waited for: the process ends, and the
    // job object ends the converter with it.
    ExitProcess(0);
}

}  // namespace clew::win
