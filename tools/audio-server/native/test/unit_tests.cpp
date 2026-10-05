// Unit tests for the portable core. No framework: each CHECK prints what failed, and the exit code
// is the number of failures. The HTTP behaviour is tested against the real program by test_native.py.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "files.h"
#include "json.h"
#include "mp3.h"
#include "platform.h"
#include "server.h"
#include "settings.h"
#include "sha256.h"
#include "text.h"

using namespace clew;
namespace fs = std::filesystem;

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++checks;                                                            \
        if (!(cond)) {                                                       \
            ++failures;                                                      \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);      \
        }                                                                    \
    } while (0)

static std::string hex(const Digest& d) {
    static const char* h = "0123456789abcdef";
    std::string s;
    for (auto b : d) {
        s += h[b >> 4];
        s += h[b & 15];
    }
    return s;
}

static void sha256_vectors() {
    // FIPS 180-2 examples.
    CHECK(hex(sha256("")) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(hex(sha256("abc")) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    CHECK(hex(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")) ==
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    std::string million(1000000, 'a');
    CHECK(hex(sha256(million)) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    // RFC 4231 test cases 1, 2 and 6 (a key longer than a block).
    CHECK(hex(hmac_sha256(std::string(20, '\x0b'), "Hi There")) ==
          "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    CHECK(hex(hmac_sha256("Jefe", "what do ya want for nothing?")) ==
          "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    CHECK(hex(hmac_sha256(std::string(131, '\xaa'), "Test Using Larger Than Block-Size Key - Hash Key First")) ==
          "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    CHECK(equal_constant_time("abc", "abc"));
    CHECK(!equal_constant_time("abc", "abd"));
    CHECK(!equal_constant_time("abc", "ab"));
}

static void text_helpers() {
    CHECK(base64_encode("") == "");
    CHECK(base64_encode("f") == "Zg==");
    CHECK(base64_encode("fo") == "Zm8=");
    CHECK(base64_encode("foobar") == "Zm9vYmFy");
    CHECK(*base64_decode("Zm9vYmE=") == "fooba");
    CHECK(!base64_decode("Zm9v!"));
    CHECK(base64url_encode("\xfb\xff") == "-_8");
    // As Python's quote(s, safe="") and unquote_plus.
    CHECK(percent_encode("2026/spring/b c.m4a") == "2026%2Fspring%2Fb%20c.m4a");
    CHECK(percent_encode("\xe3\x81\x82") == "%E3%81%82");
    CHECK(percent_decode("a%2Fb+c%zz") == "a/b c%zz");
    auto q = parse_query("p=a.wav&exp=12&sig=x&p=other&empty=");
    CHECK(q["p"] == "a.wav" && q["exp"] == "12" && q["sig"] == "x" && q.count("empty") == 0);
    CHECK(is_utf8("caf\xc3\xa9 \xe6\x97\xa5"));
    CHECK(!is_utf8("\xc3"));
    CHECK(!is_utf8("\xed\xa0\x80"));  // a lone surrogate
    CHECK(!is_utf8("\xc0\xaf"));      // an overlong "/"
}

static void json_round_trip() {
    // Not a raw string: MSVC decodes \u escapes even there.
    const std::string text = "{\"a\": [1, 2.5, true, null], \"b\": \"x\\u00e9\\ud83d\\ude00\\n\", \"c\": {}}";
    auto v = json::parse(text);
    CHECK(v && v->is_object());
    CHECK((*v)["a"].items().size() == 4 && (*v)["a"].items()[1].num() == 2.5);
    CHECK((*v)["b"].str() == "x\xc3\xa9\xf0\x9f\x98\x80\n");
    CHECK((*v)["missing"].kind() == json::Value::Kind::Null);
    CHECK(v->dump() == text);
    CHECK(!json::parse("{\"a\": }"));
    CHECK(!json::parse("[1,]"));
    CHECK(!json::parse("\"\\ud800\""));
    CHECK(!json::parse("{} x"));
    std::string deep(40, '[');
    deep += std::string(40, ']');
    CHECK(!json::parse(deep));
    CHECK(json::Value(static_cast<long long>(1759651200000)).dump() == "1759651200000");
}

static void ranges() {
    auto r = parse_range(nullptr, 100);
    CHECK(r.kind == ByteRange::None);
    std::string h = "bytes=0-9";
    r = parse_range(&h, 100);
    CHECK(r.kind == ByteRange::Ok && r.first == 0 && r.last == 9);
    h = "bytes=90-";
    r = parse_range(&h, 100);
    CHECK(r.kind == ByteRange::Ok && r.first == 90 && r.last == 99);
    h = "bytes=-10";
    r = parse_range(&h, 100);
    CHECK(r.kind == ByteRange::Ok && r.first == 90 && r.last == 99);
    h = "bytes=-500";
    r = parse_range(&h, 100);
    CHECK(r.kind == ByteRange::Ok && r.first == 0);
    h = "bytes=50-1000";
    r = parse_range(&h, 100);
    CHECK(r.kind == ByteRange::Ok && r.last == 99);
    for (const char* bad : {"bytes=100-", "bytes=5-2", "bytes=-0", "bytes=-", "items=0-1", "bytes=0-1,5-6",
                            "bytes=99999999999999999999-"}) {
        h = bad;
        CHECK(parse_range(&h, 100).kind == ByteRange::Bad);
    }
}

static void origins_and_hosts() {
    CHECK(loopback_origin("http://localhost:5173"));
    CHECK(loopback_origin("http://127.0.0.1"));
    CHECK(loopback_origin("https://[::1]:8443"));
    CHECK(!loopback_origin("http://localhost.evil.example"));
    CHECK(!loopback_origin("http://127.0.0.1.evil.example"));
    CHECK(!loopback_origin("null"));
    CHECK(loopback_host("127.0.0.1:47821"));
    CHECK(loopback_host("LOCALHOST"));
    CHECK(!loopback_host("evil.example"));
    CHECK(!loopback_host("127.0.0.1:47821@evil"));
    CHECK(*normalize_origin(" https://You.github.io/ ") == "https://you.github.io");
    CHECK(*normalize_origin("http://192.168.1.5:8080") == "http://192.168.1.5:8080");
    CHECK(!normalize_origin("https://*.github.io"));
    CHECK(!normalize_origin("https://a.example/path"));
    CHECK(!normalize_origin("ftp://a.example"));
    CHECK(!normalize_origin("https://user@a.example"));
    CHECK(!normalize_origin("https://a.example:99999"));
}

static void write(const fs::path& p, const std::string& data) {
    fs::create_directories(p.parent_path());
    std::ofstream(p, std::ios::binary) << data;
}

static void folders(const fs::path& tmp) {
    fs::path root = tmp / "interviews";
    write(root / "a.wav", "aaaa");
    write(root / "old-dictaphone.WMA", "w");
    write(root / "2026" / "spring" / "b.m4a", "b");
    write(root / "notes.txt", "n");
    write(root / ".hidden" / "c.mp3", "c");
    write(root / ".secret.mp3", "s");
    write(root / path_from_utf8("\xe6\x97\xa5\xe6\x9c\xac.mp3"), "j");
    write(tmp / "outside.mp3", "o");
    root = fs::canonical(root);

    bool truncated = true;
    auto files = list_audio(root, &truncated);
    std::vector<std::string> paths;
    for (const auto& f : files) paths.push_back(f.path);
    CHECK(!truncated);
    CHECK(paths.size() == 4);
    if (paths.size() == 4) {
        CHECK(paths[0] == "2026/spring/b.m4a");
        CHECK(paths[1] == "a.wav");
        CHECK(paths[2] == "old-dictaphone.WMA");
        CHECK(paths[3] == "\xe6\x97\xa5\xe6\x9c\xac.mp3");
    }
    CHECK(files.size() > 1 && files[1].size == 4 && files[1].mime == "audio/wav" && files[1].modified_ms > 0);

    CHECK(resolve_audio(root, "a.wav").has_value());
    CHECK(resolve_audio(root, "2026/spring/b.m4a").has_value());
    CHECK(resolve_audio(root, "2026\\spring\\b.m4a").has_value());
    CHECK(resolve_audio(root, "\xe6\x97\xa5\xe6\x9c\xac.mp3").has_value());
    for (const char* bad : {"", "../outside.mp3", "2026/../../outside.mp3", "/etc/passwd", "\\a.wav", "C:/x.mp3",
                            "c:a.wav", ".secret.mp3", ".hidden/c.mp3", "notes.txt", "a.wav:stream", "a.wav.",
                            "a.wav ", "CON.mp3", "nul", "com1.wav", "a\"b.mp3", "2026//spring/b.m4a", "./a.wav",
                            "missing.mp3", "\xff.mp3"}) {
        CHECK(!resolve_audio(root, bad).has_value());
        if (resolve_audio(root, bad)) std::printf("     resolved: %s\n", bad);
    }
}

static std::string frame(std::uint8_t fill, const char* tag) {
    // MPEG1 layer III, 128 kbit/s, 44.1 kHz, stereo, no padding, no checksum: 417 bytes.
    std::string f(417, char(fill));
    f[0] = static_cast<char>(0xFF);
    f[1] = static_cast<char>(0xFB);
    f[2] = static_cast<char>(0x90);
    f[3] = char(0x00);
    if (tag) std::memcpy(&f[4 + 32], tag, 4);
    return f;
}

static void mp3_heads(const fs::path& tmp) {
    std::string plain;
    for (int i = 0; i < 5; ++i) plain += frame(0x55, nullptr);
    write(tmp / "cbr.mp3", frame(0, "Info") + plain);
    write(tmp / "vbr.mp3", frame(0, "Xing") + plain);
    std::string id3 = std::string("ID3\x04\x00\x00\x00\x00\x00\x0a", 10) + std::string(10, '\0');
    write(tmp / "id3.mp3", id3 + frame(0, "Info") + plain);
    write(tmp / "plain.mp3", plain);
    write(tmp / "not.mp3", "not an mp3 at all");
    auto h = read_mp3_head(tmp / "cbr.mp3");
    std::uint64_t a = 0, b = 0;
    CHECK(h.kind == Mp3Head::Info && h.blank(&a, &b) && a == 36 && b == 417);
    h = read_mp3_head(tmp / "vbr.mp3");
    CHECK(h.kind == Mp3Head::Xing && !h.blank(&a, &b));
    h = read_mp3_head(tmp / "id3.mp3");
    CHECK(h.kind == Mp3Head::Info && h.tag_start == 20 + 36 && h.frame_end == 20 + 417);
    CHECK(read_mp3_head(tmp / "plain.mp3").kind == Mp3Head::None);
    CHECK(read_mp3_head(tmp / "not.mp3").kind == Mp3Head::None);
    CHECK(read_mp3_head(tmp / "missing.mp3").kind == Mp3Head::None);
}

static void settings_file(const fs::path& tmp) {
    fs::path file = tmp / "settings" / "settings.json";
    Settings s;
    s.folder = "D:\\interviews \xe6\x97\xa5";
    s.port = 50000;
    s.origins = {"https://you.github.io"};
    s.convert = false;
    s.ffmpeg = "C:\\tools\\ffmpeg.exe";
    s.secret = platform::seal_secret("not-a-real-secret");
    CHECK(s.secret.has_value());
    CHECK(s.save(file));
    std::ifstream in(file, std::ios::binary);
    std::string raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    CHECK(raw.find("not-a-real-secret") == std::string::npos);  // sealed, not in clear
#ifdef _WIN32
    CHECK(raw.find(base64_encode("not-a-real-secret")) == std::string::npos);
#endif
    Settings back = Settings::load(file);
    CHECK(back.folder == s.folder && back.port == 50000 && back.origins == s.origins && !back.convert);
    CHECK(back.ffmpeg == s.ffmpeg);
    CHECK(back.secret && *platform::open_secret(*back.secret) == "not-a-real-secret");
    // A broken file starts from the defaults.
    write(file, "{ not json");
    Settings broken = Settings::load(file);
    CHECK(broken.folder.empty() && broken.port == kDefaultPort && !broken.secret);
    CHECK(new_secret().size() == 32 && new_secret() != new_secret());
}

int main() {
    fs::path tmp = fs::temp_directory_path() / ("clew-unit-" + std::to_string(std::rand()) +
                                                 std::to_string(reinterpret_cast<std::uintptr_t>(&failures) & 0xFFFF));
    fs::remove_all(tmp);
    fs::create_directories(tmp);
    sha256_vectors();
    text_helpers();
    json_round_trip();
    ranges();
    origins_and_hosts();
    folders(tmp);
    mp3_heads(tmp);
    settings_file(tmp);
    std::error_code ec;
    fs::remove_all(tmp, ec);
    std::printf("%d checks, %d failed\n", checks, failures);
    return failures;
}
