// What the settings window edits and the next start remembers. The secret is kept sealed by the
// system's key store (platform.h), so the window can show it again; it is never written in clear.
#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "platform.h"

namespace clew {

constexpr int kDefaultPort = 47821;
constexpr int kDefaultLinkHours = 4;
constexpr int kDefaultCacheMb = 4096;
constexpr int kDefaultSttPort = 47822;
constexpr const char* kDefaultSttModel = "small";

struct Settings {
    std::string folder;  // UTF-8, empty until chosen
    int port = kDefaultPort;
    std::vector<std::string> origins;  // hosted Clew addresses; loopback is always allowed
    int link_hours = kDefaultLinkHours;
    bool convert = true;  // convert what browsers cannot play
    bool prepare = true;  // convert those ahead, in the background, after a listing
    int cache_mb = kDefaultCacheMb;
    // Optional: an ffmpeg program, tried when the system's codecs cannot convert a file. Empty: none.
    std::string ffmpeg;
    bool system_codecs = true;  // off: ffmpeg only (for testing it, or when Windows' codecs misbehave)
    std::optional<platform::Sealed> secret;

    // Dictation (docs/28): the speech server on this computer, a child process (dictation.h).
    bool stt_enabled = false;              // start it with the server
    std::string stt_model = kDefaultSttModel;
    std::string stt_models_dir;            // UTF-8; empty: platform::default_stt_models_dir()
    std::string stt_language;              // "", "en", "ja", "fr" or "mg"; "": Clew names one per session
    int stt_port = kDefaultSttPort;
    std::optional<platform::Sealed> stt_secret;  // its key, sealed like `secret`

    static Settings load(const std::filesystem::path& file);
    // Atomic: written beside, then renamed over.
    bool save(const std::filesystem::path& file) const;
};

std::filesystem::path default_settings_file();

// "https://you.github.io/" -> "https://you.github.io"; nothing for what is not an origin.
std::optional<std::string> normalize_origin(const std::string& text);

// A new secret: 24 random bytes, URL-safe base64 (as the Python server makes).
std::string new_secret();

// A new dictation key, in the speech server's shape: "stt.local.<secret>".
std::string new_stt_key();

// The models the Dictation tab offers (tools/stt-server/alefa_stt/models.py has their sources).
// Sizes as listed on Hugging Face, 2026-10-16.
struct SttModel {
    const char* name;
    std::uint64_t bytes;
    bool live;  // fast enough to dictate with (docs/28 §2); otherwise "for files"
};
constexpr SttModel kSttModels[] = {
    {"small", 486212372ull, true},
    {"large-v3-turbo", 1622000000ull, false},
};
bool stt_model_known(const std::string& name);
bool stt_language_known(const std::string& code);

}  // namespace clew
