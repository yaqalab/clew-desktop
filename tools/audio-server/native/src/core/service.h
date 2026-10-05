// The running service: settings, secret, conversion cache and HTTP server together. The tray app
// and the headless mode both drive one of these; neither talks to the server directly.
#pragma once

#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "convert_cache.h"
#include "server.h"
#include "settings.h"

namespace clew {

class Service {
public:
    using LogFn = std::function<void(const std::string& line)>;

    Service(std::filesystem::path settings_file, std::filesystem::path cache_dir, LogFn log);
    ~Service();

    const std::filesystem::path& settings_file() const { return settings_file_; }
    Settings settings() const;

    // Opens the kept secret, or makes, seals and saves a new one. `made` tells which.
    // Empty when the system cannot seal one (then the server refuses every listing).
    std::string secret(bool* made = nullptr);
    std::string reset_secret();

    // Takes these settings: saves them (unless `persist` is false: headless overrides), updates the
    // server, and restarts it when the port changed. Returns a problem to show, or "".
    std::string apply(Settings s, bool persist = true);
    std::string start();
    void stop();

    struct Status {
        bool running = false;
        int port = 0;
        std::string folder;      // full path, for this machine's own window only
        std::string problem;     // why it is not running, or ""
        std::string converting;  // the file being converted, or ""
        std::uint64_t requests = 0;
    };
    Status status() const;

    // The last lines of activity (method, path, status; never a query), newest last.
    std::vector<std::string> recent() const;

    ConvertCache& cache() { return *cache_; }
    Server& server() { return *server_; }

    // Called from any thread when the status changed; keep it short (post a message).
    void on_change(std::function<void()> fn);

private:
    void notify();
    void record(const std::string& line);
    bool convert(const std::filesystem::path& in, const std::filesystem::path& out, std::string* why);
    ServerConfig server_config(const Settings& s, std::string* problem);

    std::filesystem::path settings_file_;
    LogFn log_;
    mutable std::mutex lock_;
    Settings settings_;
    std::string secret_;
    std::string problem_;
    std::string converting_;
    std::deque<std::string> recent_;
    std::function<void()> on_change_;
    std::unique_ptr<ConvertCache> cache_;
    std::unique_ptr<Server> server_;
};

}  // namespace clew
