// The analysis engine on this computer (clew docs/36 section 5): tools/analysis-server's program,
// run as a child process. It is a translator: Clew sends it one neutral command with the data, it
// runs the command in the researcher's own R, and sends one result back. Clew's Analysis board
// talks to it directly at http://127.0.0.1:<port> with its own key. This side only starts it,
// stops it, restarts it once if it dies, and finds out which R it will use.
//
// One thread of its own does every start and stop, as for dictation (dictation.h), so a child's
// death (reported from the child's thread) never destroys the child from inside itself.
#pragma once

#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "platform.h"

namespace clew {

// A cap on the engine's committed memory, R included (R runs inside the same job). Survey models
// are small; a runaway one stops here rather than slowing the computer down.
constexpr std::uint64_t kAnalysisMemoryLimit = std::uint64_t(4) * 1024 * 1024 * 1024;

struct AnalysisConfig {
    std::filesystem::path program;     // clew-analysis-server(.exe); empty: none installed
    int port = 0;
    std::string backend = "r";
    std::filesystem::path rscript;     // empty: the engine finds R by itself
    std::filesystem::path scripts;     // the researcher's own R scripts; empty: none
    int timeout = 120;                 // seconds one run may take
    std::vector<std::string> origins;  // pages besides this computer's that may call it
    std::string key;                   // handed over on stdin
    bool operator==(const AnalysisConfig& o) const {
        return program == o.program && port == o.port && backend == o.backend && rscript == o.rscript &&
               scripts == o.scripts && timeout == o.timeout && origins == o.origins && key == o.key;
    }
    bool operator!=(const AnalysisConfig& o) const { return !(*this == o); }
};

class Analysis {
public:
    enum class State {
        Off,       // not wanted
        Missing,   // the engine program is not installed
        Starting,  // started; not answering yet
        Ready,     // listening
        Failed,    // stopped by itself; `problem` says why
    };
    // Which R the engine will use, as its `--check` says.
    enum class R { Unknown, Looking, Found, NotFound };
    struct Status {
        State state = State::Off;
        std::string problem;
        R r = R::Unknown;
        std::string r_version;  // "4.3.3" when found
        std::string r_path;     // the Rscript it found, when found
        std::string r_why;      // why not, when not found
    };

    using Notify = std::function<void()>;
    using Log = std::function<void(const std::string&)>;

    // `notify` is called from any thread when the status changed; `log` gets one line per event
    // (never the key, never a request's content).
    Analysis(Notify notify, Log log);
    ~Analysis();
    Analysis(const Analysis&) = delete;
    Analysis& operator=(const Analysis&) = delete;

    // The settings and key it runs with. A running engine restarts when they changed.
    void configure(const AnalysisConfig& config);
    void start();
    void stop();
    bool wanted() const;
    // Asks the engine program again which R it finds (after R was installed, or Rscript chosen).
    void look_for_r();

    Status status() const;

    // A line the engine printed while running: "ready", a problem, or nothing.
    struct LineMeaning {
        bool ready = false;
        std::string problem;
    };
    static LineMeaning read_server_line(const std::string& line, int port);
    // A line of `--check`: "R: 4.3.3 at C:\...\Rscript.exe" or "R: not ready (why)". False for
    // any other line.
    static bool read_check_line(const std::string& line, Status* into);

private:
    void run();
    void launch(std::unique_lock<std::mutex>& lk);
    void launch_check(std::unique_lock<std::mutex>& lk);
    void kill(std::unique_ptr<platform::Child>& child, std::unique_lock<std::mutex>& lk);
    void changed();

    Notify notify_;
    Log log_;
    mutable std::mutex m_;
    std::condition_variable cv_;
    bool quit_ = false;
    bool wake_ = false;

    AnalysisConfig config_;
    bool want_ = false;
    bool restart_ = false;
    int restarts_left_ = 1;
    std::uint64_t generation_ = 0;
    std::unique_ptr<platform::Child> server_;
    bool server_exited_ = false;
    int exit_code_ = 0;
    Status status_;

    bool check_wanted_ = false;
    std::unique_ptr<platform::Child> checker_;
    std::uint64_t check_generation_ = 0;
    bool checker_exited_ = false;
    bool check_heard_ = false;

    std::thread worker_;
};

}  // namespace clew
