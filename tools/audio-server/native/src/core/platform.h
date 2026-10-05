// What each operating system supplies. Windows: src/win/. macOS and Linux: src/posix/
// (compatible, not built or tested yet; see the README).
#pragma once

#include <filesystem>
#include <optional>
#include <string>

namespace clew::platform {

namespace fs = std::filesystem;

// Cryptographically strong random bytes from the system.
std::string random_bytes(std::size_t n);

// A secret sealed by the system's own key store, for this user only.
// Windows: DPAPI (CurrentUser). macOS: the Keychain. Linux: the Secret Service, or a 0600 file.
struct Sealed {
    std::string kind;  // "dpapi", "keychain", "file"...
    std::string data;  // base64, or a key-store reference
};
std::optional<Sealed> seal_secret(const std::string& plain);
std::optional<std::string> open_secret(const Sealed& sealed);

// Roaming settings, and a machine-local cache (converted files are large).
fs::path config_dir();
fs::path cache_dir();

// Whether this system can convert audio without any extra program.
bool can_convert();

// Writes `in` as a 128 kbit/s constant-bit-rate mp3 with no seek table to `out`, with the system's
// own codecs. Runs isolated from the server where the system allows (Windows: a low-integrity child
// process in a job object).
bool convert_to_mp3(const fs::path& in, const fs::path& out, std::string* why);

// The same with an ffmpeg program the user chose (optional, a fallback; nothing is linked).
bool ffmpeg_to_mp3(const fs::path& ffmpeg, const fs::path& in, const fs::path& out, std::string* why);

// An ffmpeg beside this program, else on PATH; empty when none.
fs::path find_ffmpeg();

// This program's own file.
fs::path self_path();

}  // namespace clew::platform
