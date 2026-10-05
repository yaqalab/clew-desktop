#include "settings.h"

#include <fstream>
#include <sstream>

#include "files.h"
#include "json.h"
#include "text.h"

namespace clew {

namespace {

int clamp_int(const json::Value& v, int lo, int hi, int fallback) {
    if (!v.is_number()) return fallback;
    double n = v.num();
    if (n < lo || n > hi) return fallback;
    return int(n);
}

}  // namespace

std::filesystem::path default_settings_file() { return platform::config_dir() / "settings.json"; }

Settings Settings::load(const std::filesystem::path& file) {
    Settings s;
    std::ifstream in(file, std::ios::binary);
    if (!in) return s;
    std::stringstream buf;
    buf << in.rdbuf();
    std::string text = buf.str();
    if (starts_with(text, "\xEF\xBB\xBF")) text = text.substr(3);
    auto v = json::parse(text);
    if (!v || !v->is_object() || !(*v)["v"].is_number() || (*v)["v"].num() != 1) return s;
    const auto& d = *v;
    if (d["folder"].is_string()) s.folder = d["folder"].str();
    s.port = clamp_int(d["port"], 1024, 65535, kDefaultPort);
    if (d["origins"].is_array()) {
        for (const auto& o : d["origins"].items()) {
            if (!o.is_string()) continue;
            if (auto n = normalize_origin(o.str())) s.origins.push_back(*n);
        }
    }
    s.link_hours = clamp_int(d["linkHours"], 1, 24 * 7, kDefaultLinkHours);
    if (d["convert"].is_bool()) s.convert = d["convert"].boolean();
    if (d["prepare"].is_bool()) s.prepare = d["prepare"].boolean();
    s.cache_mb = clamp_int(d["cacheMb"], 256, 1024 * 1024, kDefaultCacheMb);
    if (d["ffmpeg"].is_string()) s.ffmpeg = d["ffmpeg"].str();
    if (d["systemCodecs"].is_bool()) s.system_codecs = d["systemCodecs"].boolean();
    const auto& secret = d["secret"];
    if (secret["kind"].is_string() && secret["data"].is_string())
        s.secret = platform::Sealed{secret["kind"].str(), secret["data"].str()};
    return s;
}

bool Settings::save(const std::filesystem::path& file) const {
    json::Value d = json::Value::object();
    d.set("v", 1);
    d.set("folder", folder);
    d.set("port", port);
    json::Value o = json::Value::array();
    for (const auto& origin : origins) o.push(origin);
    d.set("origins", o);
    d.set("linkHours", link_hours);
    d.set("convert", convert);
    d.set("prepare", prepare);
    d.set("cacheMb", cache_mb);
    d.set("ffmpeg", ffmpeg);
    d.set("systemCodecs", system_codecs);
    if (secret) {
        json::Value sv = json::Value::object();
        sv.set("kind", secret->kind);
        sv.set("data", secret->data);
        d.set("secret", sv);
    }
    std::error_code ec;
    std::filesystem::create_directories(file.parent_path(), ec);
    auto tmp = file;
    tmp += ".tmp";
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) return false;
        out << d.dump(2) << "\n";
        if (!out) return false;
    }
    std::filesystem::rename(tmp, file, ec);
    if (ec) {
        std::filesystem::remove(tmp, ec);
        return false;
    }
    return true;
}

std::optional<std::string> normalize_origin(const std::string& text) {
    std::string s = trim(text);
    while (!s.empty() && s.back() == '/') s.pop_back();
    std::string lower = to_lower(s);
    std::size_t scheme = starts_with(lower, "https://") ? 8 : starts_with(lower, "http://") ? 7 : 0;
    if (scheme == 0 || s.size() == scheme) return std::nullopt;
    // host[:port], no path, no user info, no wildcard.
    std::string rest = lower.substr(scheme);
    for (char c : rest) {
        bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == ':' || c == '[' ||
                  c == ']';
        if (!ok) return std::nullopt;
    }
    if (rest.front() == '.' || rest.front() == ':' || rest.front() == '-') return std::nullopt;
    auto colon = rest.rfind(':');
    if (colon != std::string::npos && rest.find(']') == std::string::npos) {
        std::string port = rest.substr(colon + 1);
        if (!all_digits(port) || port.size() > 5 || std::stoi(port) == 0 || std::stoi(port) > 65535)
            return std::nullopt;
    }
    return lower;
}

std::string new_secret() { return base64url_encode(platform::random_bytes(24)); }

}  // namespace clew
