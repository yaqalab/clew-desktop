// Every string the window and the tray show, in English and Japanese. Japanese when Windows' own
// display language is Japanese, English otherwise.
#pragma once

#include <string>

namespace clew::win {

enum class S {
    AppName,
    TipRunning,     // %d port
    TipConverting,  // %s name
    TipStopped,
    TipProblem,  // %s
    MenuStatusRunning,
    MenuStatusStopped,
    MenuOpen,
    MenuCopySecret,
    MenuCopyAddress,
    MenuOpenFolder,
    MenuStop,
    MenuStart,
    MenuAutostart,
    MenuQuit,
    StatusRunning,  // %d port, %llu requests
    StatusStopped,
    StatusProblem,  // %s
    ProblemNoFolder,
    ProblemPortInUse,  // %d
    ProblemFolderGone,
    GroupFolder,
    Browse,
    Open,
    GroupConnection,
    Port,
    LinkHours,
    Origins,
    GroupSecret,
    SecretHint,
    Show,
    Hide,
    Copy,
    NewSecret,
    NewSecretConfirm,
    GroupConversion,
    Convert,
    Prepare,
    Ffmpeg,
    FfmpegFind,
    FfmpegHint,
    FfmpegNotFound,
    CacheLimit,
    CacheUsed,  // %s
    ClearCache,
    Autostart,
    Activity,
    Save,
    Close,
    Saved,
    Copied,
    BadPort,
    BadHours,
    BadCache,
    BadOrigin,  // %s
    BadFolder,
    BadFfmpeg,
    ChooseFolder,
    ChooseFfmpeg,
    FirstRun,
    AlreadyRunning,
    Start,
    Stop,
};

const wchar_t* tr(S id);
// tr() with printf-style arguments.
std::wstring trf(S id, ...);

}  // namespace clew::win
