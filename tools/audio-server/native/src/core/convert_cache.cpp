#include "convert_cache.h"

#include <algorithm>
#include <vector>

#include "files.h"
#include "sha256.h"
#include "text.h"

namespace clew {

namespace {

constexpr int kConvertKbps = 128;

std::string hex(const Digest& d, std::size_t n) {
    static const char* h = "0123456789abcdef";
    std::string out;
    for (std::size_t i = 0; i < n && i < d.size(); ++i) {
        out += h[d[i] >> 4];
        out += h[d[i] & 15];
    }
    return out;
}

}  // namespace

bool unplayable(const fs::path& path) {
    std::string ext = to_lower(path_to_utf8(path.extension()));
    return ext == ".wma" || ext == ".amr";
}

ConvertCache::ConvertCache(fs::path dir, ConvertFn convert) : dir_(std::move(dir)), convert_(std::move(convert)) {
    worker_ = std::thread([this] { worker(); });
}

ConvertCache::~ConvertCache() {
    {
        std::lock_guard<std::mutex> g(queue_lock_);
        stopping_ = true;
        queue_.clear();
    }
    queue_cv_.notify_all();
    if (worker_.joinable()) worker_.join();
}

void ConvertCache::set_on_busy(BusyFn fn) {
    std::lock_guard<std::mutex> g(lock_);
    on_busy_ = std::move(fn);
}

void ConvertCache::busy(const std::string& name) {
    BusyFn fn;
    {
        std::lock_guard<std::mutex> g(lock_);
        fn = on_busy_;
    }
    if (fn) fn(name);
}

Mp3Head ConvertCache::head_of(const fs::path& path) {
    std::error_code ec;
    auto size = fs::file_size(path, ec);
    if (ec) return {};
    auto mtime = fs::last_write_time(path, ec).time_since_epoch().count();
    if (ec) return {};
    {
        std::lock_guard<std::mutex> g(lock_);
        auto it = heads_.find(path);
        if (it != heads_.end() && it->second.mtime == mtime && it->second.size == size) return it->second.head;
    }
    Mp3Head head = read_mp3_head(path);
    std::lock_guard<std::mutex> g(lock_);
    heads_[path] = Seen{std::int64_t(mtime), size, head};
    return head;
}

bool ConvertCache::needs(const fs::path& path) {
    if (!enabled()) return false;
    if (unplayable(path)) return true;
    if (to_lower(path_to_utf8(path.extension())) != ".mp3") return false;
    auto kind = head_of(path).kind;
    return kind == Mp3Head::Xing || kind == Mp3Head::Vbri;
}

fs::path ConvertCache::target_of(const fs::path& path) const {
    std::error_code ec;
    auto size = fs::file_size(path, ec);
    auto mtime = fs::last_write_time(path, ec).time_since_epoch().count();
    std::string key = path_to_utf8(path) + "\n" + std::to_string(mtime) + "\n" + std::to_string(size) + "\n" +
                      std::to_string(kConvertKbps) + "\nsystem-codec-1";
    return dir_ / (hex(sha256(key), 16) + ".mp3");
}

std::optional<fs::path> ConvertCache::converted(const fs::path& path) {
    std::error_code ec;
    auto hit = target_of(path);
    if (!fs::is_regular_file(hit, ec)) return std::nullopt;
    // The most recently used survives the trimming.
    fs::last_write_time(hit, fs::file_time_type::clock::now(), ec);
    return hit;
}

std::optional<fs::path> ConvertCache::convert(const fs::path& path) {
    if (!needs(path)) return std::nullopt;
    auto target = target_of(path);
    std::shared_ptr<std::mutex> once;
    {
        std::lock_guard<std::mutex> g(lock_);
        auto& slot = once_[path_to_utf8(target.filename())];
        if (!slot) slot = std::make_shared<std::mutex>();
        once = slot;
    }
    {
        std::lock_guard<std::mutex> g(*once);
        if (auto hit = converted(path)) return hit;
        std::error_code ec;
        fs::create_directories(dir_, ec);
        auto part = target;
        part.replace_extension(".part");
        {
            std::lock_guard<std::mutex> g2(lock_);
            ++running_;
        }
        busy(path_to_utf8(path.filename()));
        std::string why;
        bool ok = convert_(path, part, &why) && fs::file_size(part, ec) > 0 && !ec;
        if (ok) {
            fs::rename(part, target, ec);
            ok = !ec;
        }
        bool idle;
        {
            std::lock_guard<std::mutex> g2(lock_);
            idle = --running_ == 0;
            if (!ok) failed_.insert(path);
        }
        if (idle) busy("");
        if (!ok) {
            fs::remove(part, ec);
            return std::nullopt;
        }
    }
    trim(target);
    return target;
}

void ConvertCache::trim(const fs::path& keep) {
    struct Item {
        fs::file_time_type at;
        std::uint64_t size;
        fs::path path;
    };
    std::vector<Item> items;
    std::uint64_t total = 0;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(dir_, ec)) {
        if (e.path().extension() != ".mp3") continue;
        std::error_code ec2;
        Item it{e.last_write_time(ec2), e.file_size(ec2), e.path()};
        if (ec2) continue;
        total += it.size;
        items.push_back(it);
    }
    std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.at < b.at; });
    for (const auto& it : items) {
        if (total <= limit_) break;
        if (it.path == keep) continue;
        std::error_code ec2;
        if (fs::remove(it.path, ec2)) total -= it.size;
    }
}

void ConvertCache::prepare(const std::vector<fs::path>& paths) {
    if (!enabled() || !prepare_) return;
    {
        std::lock_guard<std::mutex> g(queue_lock_);
        for (const auto& p : paths) {
            if (!unplayable(p) || queued_.count(p)) continue;
            {
                std::lock_guard<std::mutex> g2(lock_);
                if (failed_.count(p)) continue;
            }
            queued_.insert(p);
            queue_.push_back(p);
        }
    }
    queue_cv_.notify_one();
}

void ConvertCache::worker() {
    while (true) {
        fs::path next;
        {
            std::unique_lock<std::mutex> g(queue_lock_);
            queue_cv_.wait(g, [this] { return stopping_ || !queue_.empty(); });
            if (stopping_) return;
            next = queue_.front();
            queue_.pop_front();
        }
        if (enabled() && bytes_on_disk() < limit_ / 2 && !converted(next)) convert(next);
        std::lock_guard<std::mutex> g(queue_lock_);
        queued_.erase(next);
    }
}

std::uint64_t ConvertCache::bytes_on_disk() const {
    std::uint64_t total = 0;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(dir_, ec)) {
        std::error_code ec2;
        if (e.is_regular_file(ec2)) total += e.file_size(ec2);
    }
    return total;
}

void ConvertCache::clear() {
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(dir_, ec)) {
        auto ext = e.path().extension();
        if (ext == ".mp3" || ext == ".part") {
            std::error_code ec2;
            fs::remove(e.path(), ec2);
        }
    }
    std::lock_guard<std::mutex> g(lock_);
    failed_.clear();
}

}  // namespace clew
