// What the settings window edits and the next start remembers. The secret is kept sealed by the
// system's key store (platform.h), so the window can show it again; it is never written in clear.
#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "platform.h"

namespace clew {

constexpr int kDefaultPort = 47821;
constexpr int kDefaultLinkHours = 4;
constexpr int kDefaultCacheMb = 4096;

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

    static Settings load(const std::filesystem::path& file);
    // Atomic: written beside, then renamed over.
    bool save(const std::filesystem::path& file) const;
};

std::filesystem::path default_settings_file();

// "https://you.github.io/" -> "https://you.github.io"; nothing for what is not an origin.
std::optional<std::string> normalize_origin(const std::string& text);

// A new secret: 24 random bytes, URL-safe base64 (as the Python server makes).
std::string new_secret();

}  // namespace clew
