#include "headless.h"

#include "files.h"
#include "platform.h"
#include "service.h"
#include "settings.h"
#include "text.h"

namespace clew {

const char* const kHeadlessHelp =
    "Clew audio server: serves the audio files of one folder to Clew, on 127.0.0.1 only.\n"
    "\n"
    "  clew-audio-server                 the tray icon and the settings window (Windows)\n"
    "  clew-audio-server --headless      no window; output on the console\n"
    "\n"
    "With --headless (each option for this run only; the settings window's values are the defaults):\n"
    "  --folder <path>        the folder to serve\n"
    "  --port <n>             default 47821\n"
    "  --allow-origin <url>   a hosted Clew's address (repeatable); loopback is always allowed\n"
    "  --ffmpeg <path>        an ffmpeg to try when the system's codecs cannot convert a file\n"
    "  --no-convert           send every file as it is\n"
    "  --no-system-codecs     convert with --ffmpeg only\n"
    "  --show-secret          print the secret\n"
    "  --reset-secret         make a new secret (saved); the old one stops working\n"
    "  --config <file>        the settings file (default: the settings window's)\n"
    "  --cache-dir <dir>      where converted files are kept\n"
    "  --version\n";

namespace {

bool take(const std::vector<std::string>& args, std::size_t& i, std::string* value) {
    if (i + 1 >= args.size()) return false;
    *value = args[++i];
    return true;
}

}  // namespace

int run_headless(const std::vector<std::string>& args, const Console& console) {
    std::string folder, config, cache_dir, ffmpeg, value;
    std::vector<std::string> origins;
    int port = -1, link_seconds = 0;  // -1: the settings' port; 0: any free port
    bool reset = false, show = false, no_convert = false, no_system = false;
    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& a = args[i];
        if (a == "--headless") continue;
        if (a == "--help" || a == "-h") {
            console.out(kHeadlessHelp);
            return 0;
        }
        if (a == "--version") {
            console.out(std::string(kAppName) + " " + kVersion);
            return 0;
        }
        bool ok = true;
        if (a == "--folder") ok = take(args, i, &folder);
        else if (a == "--config") ok = take(args, i, &config);
        else if (a == "--cache-dir") ok = take(args, i, &cache_dir);
        else if (a == "--ffmpeg") ok = take(args, i, &ffmpeg);
        else if (a == "--allow-origin") {
            ok = take(args, i, &value);
            auto o = ok ? normalize_origin(value) : std::nullopt;
            if (ok && !o) {
                console.out("Not an origin (https://host[:port]): " + value);
                return 2;
            }
            if (o) origins.push_back(*o);
        } else if (a == "--port" || a == "--link-seconds") {
            ok = take(args, i, &value) && all_digits(value) && value.size() <= 6;
            int n = ok ? std::stoi(value) : 0;
            if (a == "--port") {
                ok = ok && n <= 65535;
                port = n;
            } else {
                // For the tests: links that expire within seconds.
                link_seconds = n;
            }
        } else if (a == "--reset-secret") reset = true;
        else if (a == "--show-secret") show = true;
        else if (a == "--no-convert") no_convert = true;
        else if (a == "--no-system-codecs") no_system = true;
        else {
            console.out("Unknown option: " + a + "\n\n" + kHeadlessHelp);
            return 2;
        }
        if (!ok) {
            console.out("Missing or bad value for " + a);
            return 2;
        }
    }

    Service svc(config.empty() ? default_settings_file() : path_from_utf8(config),
                cache_dir.empty() ? platform::cache_dir() : path_from_utf8(cache_dir), console.err);
    Settings s = svc.settings();
    if (!folder.empty()) s.folder = path_to_utf8(std::filesystem::absolute(path_from_utf8(folder)));
    if (port >= 0) s.port = port;
    for (const auto& o : origins) s.origins.push_back(o);
    if (!ffmpeg.empty()) s.ffmpeg = ffmpeg;
    if (no_convert) s.convert = false;
    if (no_system) s.system_codecs = false;
    if (s.folder.empty()) {
        console.out("No folder chosen. Start with --folder <path>, or choose one in the settings window.");
        return 2;
    }
    std::error_code ec;
    if (!std::filesystem::is_directory(path_from_utf8(s.folder), ec)) {
        console.out("Not a folder: " + s.folder);
        return 2;
    }

    bool made = false;
    std::string secret = reset ? svc.reset_secret() : svc.secret(&made);
    made = made || reset;
    if (secret.empty()) {
        console.out("This system could not keep a secret safely, so the server does not start.");
        return 3;
    }
    std::string problem = svc.apply(s, /*persist=*/false);
    if (!svc.server().running()) {
        console.out("Port " + std::to_string(s.port) + " is not available (" + problem + "). Try --port <number>.");
        return 2;
    }
    if (link_seconds > 0) {
        ServerConfig c = *svc.server().config();
        c.link_ttl_sec = link_seconds;
        svc.server().configure(c);
    }

    bool truncated = false;
    auto files = list_audio(svc.server().config()->root, &truncated);
    console.out("Clew audio server  ->  http://127.0.0.1:" + std::to_string(svc.server().port()));
    if (!s.origins.empty()) {
        std::string list;
        for (const auto& o : s.origins) list += (list.empty() ? "" : ", ") + o;
        console.out("Also allowed to call it: " + list);
    }
    console.out("Folder: " + s.folder + "  (" + std::to_string(files.size()) + " audio files" +
                (truncated ? ", more than shown" : "") + ")");
    if (!s.convert)
        console.out("Conversion: off");
    else
        console.out(std::string("Conversion: ") +
                    (s.system_codecs && platform::can_convert() ? "the system's own codecs" : "no system codecs") +
                    (s.ffmpeg.empty() ? "" : ", then " + s.ffmpeg) +
                    " (.wma, .amr and variable-bit-rate mp3 are converted so that browsers play them)");
    if (made || show) {
        console.out("");
        console.out(made ? "Secret (shown once here; the settings window shows it again) - paste it into Clew:"
                         : "Secret - paste it into Clew:");
        console.out("    " + secret);
        console.out("");
    } else {
        console.out("Secret: in the settings window, or start with --show-secret.");
    }
    console.out("Press Ctrl+C to stop.");
    console.wait_for_stop();
    svc.stop();
    return 0;
}

}  // namespace clew
