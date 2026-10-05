#include "strings.h"

#include <windows.h>

#include <cstdarg>
#include <cwchar>

namespace clew::win {

namespace {

struct Pair {
    S id;
    const wchar_t* en;
    const wchar_t* ja;
};

// clang-format off
const Pair kStrings[] = {
    {S::AppName, L"Clew audio server", L"Clew オーディオサーバー"},
    {S::TipRunning, L"Clew audio server — running on 127.0.0.1:%d", L"Clew オーディオサーバー — 127.0.0.1:%d で実行中"},
    {S::TipConverting, L"Clew audio server — converting %s…", L"Clew オーディオサーバー — %s を変換中…"},
    {S::TipStopped, L"Clew audio server — stopped", L"Clew オーディオサーバー — 停止中"},
    {S::TipProblem, L"Clew audio server — %s", L"Clew オーディオサーバー — %s"},
    {S::MenuStatusRunning, L"Running on 127.0.0.1:%d", L"127.0.0.1:%d で実行中"},
    {S::MenuStatusStopped, L"Stopped", L"停止中"},
    {S::MenuOpen, L"Open settings", L"設定を開く"},
    {S::MenuCopySecret, L"Copy the secret", L"シークレットをコピー"},
    {S::MenuCopyAddress, L"Copy the address", L"アドレスをコピー"},
    {S::MenuOpenFolder, L"Open the audio folder", L"音声フォルダーを開く"},
    {S::MenuStop, L"Stop the server", L"サーバーを停止"},
    {S::MenuStart, L"Start the server", L"サーバーを開始"},
    {S::MenuAutostart, L"Start with Windows", L"Windows の起動時に開始"},
    {S::MenuQuit, L"Quit", L"終了"},
    {S::StatusRunning, L"Running — http://127.0.0.1:%d · requests so far: %llu", L"実行中 — http://127.0.0.1:%d · これまでのリクエスト: %llu 件"},
    {S::StatusStopped, L"Stopped. Clew cannot reach your audio files until it starts again.", L"停止中です。再開するまで Clew から音声ファイルにアクセスできません。"},
    {S::StatusProblem, L"Not running: %s", L"停止中: %s"},
    {S::ProblemNoFolder, L"choose the folder of your audio files below.", L"下で音声ファイルのフォルダーを選択してください。"},
    {S::ProblemPortInUse, L"port %d is used by another program; choose another port below.", L"ポート %d は他のプログラムが使用中です。下で別のポートを選択してください。"},
    {S::ProblemFolderGone, L"the folder cannot be opened (a disconnected drive?).", L"フォルダーを開けません（ドライブが接続されていない可能性があります）。"},
    {S::GroupFolder, L"Folder of your audio files", L"音声ファイルのフォルダー"},
    {S::Browse, L"Browse…", L"参照…"},
    {S::Open, L"Open", L"開く"},
    {S::GroupConnection, L"Connection", L"接続"},
    {S::Port, L"Port", L"ポート"},
    {S::LinkHours, L"Play links last (hours)", L"再生リンクの有効期間（時間）"},
    {S::Origins, L"Other Clew addresses allowed to connect, one per line (a Clew on this computer is always allowed):", L"接続を許可する他の Clew のアドレス（1 行に 1 つ。このコンピューター上の Clew は常に許可されます）："},
    {S::GroupSecret, L"Secret", L"シークレット"},
    {S::SecretHint, L"Paste it into Clew (“From the audio server…”). Kept encrypted for your Windows account.", L"Clew の「オーディオサーバーから…」に貼り付けてください。Windows アカウント用に暗号化して保存。"},
    {S::Show, L"Show", L"表示"},
    {S::Hide, L"Hide", L"隠す"},
    {S::Copy, L"Copy", L"コピー"},
    {S::NewSecret, L"New secret…", L"作り直す…"},
    {S::NewSecretConfirm, L"Make a new secret?\n\nThe one Clew has stops working at once; you then paste the new one into Clew.", L"新しいシークレットを作成しますか？\n\nClew に保存されているシークレットはすぐに使えなくなります。新しいシークレットを Clew に貼り付けてください。"},
    {S::GroupConversion, L"Conversion", L"変換"},
    {S::Convert, L"Convert what browsers cannot play well (WMA, AMR, variable-bit-rate MP3) with Windows' own codecs", L"ブラウザーで正しく再生できないファイル（WMA、AMR、可変ビットレート MP3）を Windows 標準のコーデックで変換する"},
    {S::Prepare, L"Prepare WMA and AMR files in the background, so they open at once", L"WMA と AMR ファイルをバックグラウンドで事前に変換し、すぐに開けるようにする"},
    {S::Ffmpeg, L"ffmpeg (optional)", L"ffmpeg（任意）"},
    {S::FfmpegFind, L"Find", L"検索"},
    {S::FfmpegHint, L"Used only when Windows cannot convert a file; empty: never.", L"Windows で変換できない場合のみ使用（空欄：使用しない）。"},
    {S::FfmpegNotFound, L"No ffmpeg.exe was found beside this program or on PATH.", L"このプログラムと同じ場所や PATH に ffmpeg.exe が見つかりませんでした。"},
    {S::CacheLimit, L"Cache limit (MB)", L"キャッシュ（MB）"},
    {S::CacheUsed, L"%s in use", L"使用中: %s"},
    {S::ClearCache, L"Clear cache", L"キャッシュを消去"},
    {S::Autostart, L"Start with Windows", L"Windows の起動時に開始"},
    {S::Activity, L"Recent activity (kept in memory only, never written to disk)", L"最近のアクティビティ（メモリ上のみに保持され、ディスクには書き込まれません）"},
    {S::Save, L"Save", L"保存"},
    {S::Close, L"Close", L"閉じる"},
    {S::Saved, L"Saved.", L"保存しました。"},
    {S::Copied, L"Copied.", L"コピーしました。"},
    {S::BadPort, L"The port is a number from 1024 to 65535.", L"ポートは 1024〜65535 の数値で指定してください。"},
    {S::BadHours, L"Links last from 1 to 168 hours.", L"リンクの有効期間は 1〜168 時間で指定してください。"},
    {S::BadCache, L"The cache limit is at least 256 MB.", L"キャッシュ上限は 256 MB 以上で指定してください。"},
    {S::BadOrigin, L"Not an address: %s (write it as https://host or https://host:port).", L"アドレスではありません: %s（https://ホスト または https://ホスト:ポート の形式で入力してください）。"},
    {S::BadFolder, L"This folder does not exist.", L"このフォルダーは存在しません。"},
    {S::BadFfmpeg, L"This ffmpeg file does not exist.", L"この ffmpeg ファイルは存在しません。"},
    {S::ChooseFolder, L"Choose the folder of your audio files", L"音声ファイルのフォルダーを選択"},
    {S::ChooseFfmpeg, L"Choose ffmpeg.exe", L"ffmpeg.exe を選択"},
    {S::FirstRun, L"Choose the folder of your audio files to start.", L"開始するには音声ファイルのフォルダーを選択してください。"},
    {S::AlreadyRunning, L"The Clew audio server is already running; its icon is in the notification area.", L"Clew オーディオサーバーはすでに実行中です。通知領域にアイコンがあります。"},
    {S::Start, L"Start", L"開始"},
    {S::Stop, L"Stop", L"停止"},
};
// clang-format on

// Windows' display language, unless CLEW_AUDIO_LANG says "en" or "ja".
bool japanese() {
    static const bool ja = [] {
        wchar_t forced[8] = {};
        if (GetEnvironmentVariableW(L"CLEW_AUDIO_LANG", forced, 8) > 0) return wcscmp(forced, L"ja") == 0;
        return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_JAPANESE;
    }();
    return ja;
}

}  // namespace

const wchar_t* tr(S id) {
    for (const auto& p : kStrings)
        if (p.id == id) return japanese() ? p.ja : p.en;
    return L"?";
}

std::wstring trf(S id, ...) {
    wchar_t buf[1024];
    va_list args;
    va_start(args, id);
    _vsnwprintf_s(buf, _countof(buf), _TRUNCATE, tr(id), args);
    va_end(args);
    return buf;
}

}  // namespace clew::win
