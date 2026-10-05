#include "service.h"

#include <ctime>

#include "files.h"
#include "platform.h"

namespace clew {

namespace {

std::string clock_now() {
    std::time_t t = std::time(nullptr);
    std::tm tm{};
#ifdef _WIN32
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    char buf[16];
    std::strftime(buf, sizeof buf, "%H:%M:%S", &tm);
    return buf;
}

}  // namespace

Service::Service(std::filesystem::path settings_file, std::filesystem::path cache_dir, LogFn log)
    : settings_file_(std::move(settings_file)), forced_cache_dir_(cache_dir), log_(std::move(log)) {
    settings_ = Settings::load(settings_file_);
    cache_ = std::make_unique<ConvertCache>(
        std::move(cache_dir), [this](const auto& in, const auto& out, const platform::ConvertControl& control,
                                     std::string* why) { return convert(in, out, control, why); });
    cache_->set_on_busy([this](const std::string& name) {
        {
            std::lock_guard<std::mutex> g(lock_);
            converting_ = name;
        }
        record(name.empty() ? "conversion finished" : "converting " + name);
        notify();
    });
    cache_->set_on_note([this](const std::string& line) {
        record(line);
        notify();
    });
    server_ = std::make_unique<Server>(cache_.get(), [this](const std::string& line) {
        record(line);
        notify();
    });
}

Service::~Service() {
    server_->stop();
    server_.reset();
    cache_.reset();
}

Settings Service::settings() const {
    std::lock_guard<std::mutex> g(lock_);
    return settings_;
}

void Service::on_change(std::function<void()> fn) {
    std::lock_guard<std::mutex> g(lock_);
    on_change_ = std::move(fn);
}

void Service::notify() {
    std::function<void()> fn;
    {
        std::lock_guard<std::mutex> g(lock_);
        fn = on_change_;
    }
    if (fn) fn();
}

void Service::record(const std::string& line) {
    {
        std::lock_guard<std::mutex> g(lock_);
        recent_.push_back(clock_now() + "  " + line);
        while (recent_.size() > 200) recent_.pop_front();
    }
    if (log_) log_(line);
}

std::vector<std::string> Service::recent() const {
    std::lock_guard<std::mutex> g(lock_);
    return {recent_.begin(), recent_.end()};
}

bool Service::convert(const std::filesystem::path& in, const std::filesystem::path& out,
                      const platform::ConvertControl& control, std::string* why) {
    // The system's codecs first; then the user's own ffmpeg, if they chose one.
    Settings s = settings();
    std::string system_why;
    if (s.system_codecs && platform::can_convert() && platform::convert_to_mp3(in, out, control, &system_why))
        return true;
    if (control.cancelled()) return false;  // put back in the queue: not a failure
    const std::string& ffmpeg = s.ffmpeg;
    if (!ffmpeg.empty()) {
        std::string ffmpeg_why;
        if (platform::ffmpeg_to_mp3(path_from_utf8(ffmpeg), in, out, control, &ffmpeg_why)) return true;
        if (control.cancelled()) return false;
        system_why += system_why.empty() ? ffmpeg_why : "; ffmpeg: " + ffmpeg_why;
    }
    record("could not convert " + path_to_utf8(in.filename()) + (system_why.empty() ? "" : " (" + system_why + ")"));
    if (why) *why = system_why;
    return false;
}

std::string Service::secret(bool* made) {
    if (made) *made = false;
    std::lock_guard<std::mutex> g(lock_);
    if (!secret_.empty()) return secret_;
    if (settings_.secret) {
        if (auto opened = platform::open_secret(*settings_.secret)) {
            secret_ = *opened;
            return secret_;
        }
        // Sealed for another user or another machine: a new one is the only way on.
    }
    std::string fresh = new_secret();
    auto sealed = platform::seal_secret(fresh);
    if (!sealed) return "";
    settings_.secret = *sealed;
    settings_.save(settings_file_);
    secret_ = fresh;
    if (made) *made = true;
    return secret_;
}

std::string Service::reset_secret() {
    {
        std::lock_guard<std::mutex> g(lock_);
        secret_.clear();
        settings_.secret.reset();
    }
    std::string s = secret();
    Settings current = settings();
    std::string problem;
    server_->configure(server_config(current, &problem));
    record("a new secret was made; the old one no longer works");
    notify();
    return s;
}

ServerConfig Service::server_config(const Settings& s, std::string* problem) {
    ServerConfig c;
    for (const auto& o : s.origins) c.origins.insert(o);
    c.link_ttl_sec = s.link_hours * 3600;
    {
        std::lock_guard<std::mutex> g(lock_);
        c.secret = secret_;
    }
    if (s.folder.empty()) {
        *problem = "no folder chosen";
    } else {
        std::error_code ec;
        auto root = std::filesystem::canonical(path_from_utf8(s.folder), ec);
        if (ec || !std::filesystem::is_directory(root, ec))
            *problem = "the folder cannot be opened: " + s.folder;
        else
            c.root = root;
    }
    return c;
}

std::string Service::apply(Settings s, bool persist) {
    int old_port;
    {
        std::lock_guard<std::mutex> g(lock_);
        old_port = settings_.port;
        s.secret = settings_.secret;  // the secret is changed only by reset_secret()
        settings_ = s;
    }
    if (persist) settings_.save(settings_file_);
    secret();
    cache_->set_enabled(s.convert);
    cache_->set_prepare(s.prepare);
    cache_->set_limit_bytes(std::uint64_t(s.cache_mb) * 1024 * 1024);
    std::string problem;
    ServerConfig config = server_config(s, &problem);
    cache_->set_dir(!forced_cache_dir_.empty() ? forced_cache_dir_
                    : config.root.empty()      ? std::filesystem::path()
                                               : config.root / kCacheFolder);
    server_->configure(config);
    // Without a folder there is nothing to serve: not listening says so more plainly than a 503.
    if (server_->running() && (old_port != s.port || config.root.empty())) server_->stop();
    std::string start_problem = server_->running() || config.root.empty() ? "" : start();
    {
        std::lock_guard<std::mutex> g(lock_);
        problem_ = !start_problem.empty() ? start_problem : problem;
    }
    notify();
    return problem_;
}

std::string Service::start() {
    std::string error;
    int port = settings().port;
    if (!server_->start(port, &error)) {
        std::lock_guard<std::mutex> g(lock_);
        problem_ = error;
        return error;
    }
    record("listening on http://127.0.0.1:" + std::to_string(server_->port()));
    return "";
}

void Service::stop() {
    server_->stop();
    record("stopped");
    notify();
}

Service::Status Service::status() const {
    Status st;
    st.running = server_->running();
    st.port = server_->running() ? server_->port() : settings().port;
    st.requests = server_->requests();
    std::lock_guard<std::mutex> g(lock_);
    st.folder = settings_.folder;
    st.problem = problem_;
    st.converting = converting_;
    return st;
}

}  // namespace clew
