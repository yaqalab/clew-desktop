// PBKDF2-HMAC-SHA-256 and scrypt, as RFC 8018 §5.2 and RFC 7914 §§3-6 write them. See scrypt.h.
#include "scrypt.h"

#include <algorithm>
#include <cstring>
#include <vector>

#include "sha256.h"

namespace clew {

std::string pbkdf2_hmac_sha256(const std::string& password, const std::string& salt,
                               std::uint32_t iterations, std::size_t length) {
    std::string out;
    out.reserve(length);
    for (std::uint32_t block = 1; out.size() < length; ++block) {
        std::string first = salt;
        first += static_cast<char>((block >> 24) & 0xff);
        first += static_cast<char>((block >> 16) & 0xff);
        first += static_cast<char>((block >> 8) & 0xff);
        first += static_cast<char>(block & 0xff);
        Digest u = hmac_sha256(password, first);
        Digest t = u;
        for (std::uint32_t i = 1; i < iterations; ++i) {
            u = hmac_sha256(password, std::string(u.begin(), u.end()));
            for (std::size_t k = 0; k < t.size(); ++k) t[k] ^= u[k];
        }
        std::size_t take = length - out.size() < t.size() ? length - out.size() : t.size();
        out.append(reinterpret_cast<const char*>(t.data()), take);
    }
    return out;
}

namespace {

inline std::uint32_t rotl(std::uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }

// Salsa20/8 core (RFC 7914 §3), in place on 16 words.
void salsa20_8(std::uint32_t b[16]) {
    std::uint32_t x[16];
    std::memcpy(x, b, sizeof x);
    for (int i = 0; i < 8; i += 2) {
        x[4] ^= rotl(x[0] + x[12], 7);
        x[8] ^= rotl(x[4] + x[0], 9);
        x[12] ^= rotl(x[8] + x[4], 13);
        x[0] ^= rotl(x[12] + x[8], 18);
        x[9] ^= rotl(x[5] + x[1], 7);
        x[13] ^= rotl(x[9] + x[5], 9);
        x[1] ^= rotl(x[13] + x[9], 13);
        x[5] ^= rotl(x[1] + x[13], 18);
        x[14] ^= rotl(x[10] + x[6], 7);
        x[2] ^= rotl(x[14] + x[10], 9);
        x[6] ^= rotl(x[2] + x[14], 13);
        x[10] ^= rotl(x[6] + x[2], 18);
        x[3] ^= rotl(x[15] + x[11], 7);
        x[7] ^= rotl(x[3] + x[15], 9);
        x[11] ^= rotl(x[7] + x[3], 13);
        x[15] ^= rotl(x[11] + x[7], 18);
        x[1] ^= rotl(x[0] + x[3], 7);
        x[2] ^= rotl(x[1] + x[0], 9);
        x[3] ^= rotl(x[2] + x[1], 13);
        x[0] ^= rotl(x[3] + x[2], 18);
        x[6] ^= rotl(x[5] + x[4], 7);
        x[7] ^= rotl(x[6] + x[5], 9);
        x[4] ^= rotl(x[7] + x[6], 13);
        x[5] ^= rotl(x[4] + x[7], 18);
        x[11] ^= rotl(x[10] + x[9], 7);
        x[8] ^= rotl(x[11] + x[10], 9);
        x[9] ^= rotl(x[8] + x[11], 13);
        x[10] ^= rotl(x[9] + x[8], 18);
        x[12] ^= rotl(x[15] + x[14], 7);
        x[13] ^= rotl(x[12] + x[15], 9);
        x[14] ^= rotl(x[13] + x[12], 13);
        x[15] ^= rotl(x[14] + x[13], 18);
    }
    for (int i = 0; i < 16; ++i) b[i] += x[i];
}

// scryptBlockMix (§4): 2r blocks of 16 words in `b`, `y` the same size as scratch.
void block_mix(std::uint32_t* b, std::uint32_t* y, std::uint32_t r) {
    std::uint32_t x[16];
    std::memcpy(x, b + (2 * r - 1) * 16, sizeof x);
    for (std::uint32_t i = 0; i < 2 * r; ++i) {
        for (int k = 0; k < 16; ++k) x[k] ^= b[i * 16 + k];
        salsa20_8(x);
        // Even outputs to the first half, odd to the second.
        std::uint32_t at = (i % 2 == 0 ? i / 2 : r + i / 2) * 16;
        std::memcpy(y + at, x, sizeof x);
    }
    std::memcpy(b, y, sizeof(std::uint32_t) * 32 * r);
}

// scryptROMix (§5) on one 128r-byte block, held as 32r little-endian words.
void ro_mix(std::uint32_t* x, std::uint32_t r, std::uint64_t n, std::vector<std::uint32_t>& v,
            std::vector<std::uint32_t>& y) {
    const std::size_t words = 32 * static_cast<std::size_t>(r);
    for (std::uint64_t i = 0; i < n; ++i) {
        std::memcpy(v.data() + i * words, x, words * sizeof(std::uint32_t));
        block_mix(x, y.data(), r);
    }
    for (std::uint64_t i = 0; i < n; ++i) {
        // Integerify: the first word of the last 64-byte block, mod N (N is at most 2^32 here).
        std::uint64_t j = x[(2 * r - 1) * 16] & (n - 1);
        const std::uint32_t* vj = v.data() + j * words;
        for (std::size_t k = 0; k < words; ++k) x[k] ^= vj[k];
        block_mix(x, y.data(), r);
    }
}

}  // namespace

std::optional<std::string> scrypt(const std::string& password, const std::string& salt,
                                  std::uint64_t n, std::uint32_t r, std::uint32_t p,
                                  std::size_t length) {
    if (n < 2 || (n & (n - 1)) != 0 || n > (1ull << 32) || r == 0 || p == 0 || length == 0) return std::nullopt;
    const std::uint64_t limit = 64ull << 20;
    if (static_cast<std::uint64_t>(r) * p > (1u << 20)) return std::nullopt;
    if (128ull * r * n > limit || 128ull * r * p > limit) return std::nullopt;

    const std::size_t bytes = 128 * static_cast<std::size_t>(r);
    std::string b = pbkdf2_hmac_sha256(password, salt, 1, bytes * p);
    std::vector<std::uint32_t> x(bytes / 4), y(bytes / 4), v(static_cast<std::size_t>(n) * (bytes / 4));
    for (std::uint32_t i = 0; i < p; ++i) {
        const unsigned char* in = reinterpret_cast<const unsigned char*>(b.data()) + i * bytes;
        for (std::size_t k = 0; k < x.size(); ++k)
            x[k] = static_cast<std::uint32_t>(in[4 * k]) | (static_cast<std::uint32_t>(in[4 * k + 1]) << 8) |
                   (static_cast<std::uint32_t>(in[4 * k + 2]) << 16) |
                   (static_cast<std::uint32_t>(in[4 * k + 3]) << 24);
        ro_mix(x.data(), r, n, v, y);
        for (std::size_t k = 0; k < x.size(); ++k) {
            b[i * bytes + 4 * k] = static_cast<char>(x[k] & 0xff);
            b[i * bytes + 4 * k + 1] = static_cast<char>((x[k] >> 8) & 0xff);
            b[i * bytes + 4 * k + 2] = static_cast<char>((x[k] >> 16) & 0xff);
            b[i * bytes + 4 * k + 3] = static_cast<char>((x[k] >> 24) & 0xff);
        }
    }
    std::string out = pbkdf2_hmac_sha256(password, b, 1, length);
    // The intermediate state held the password's derivation: not left lying in freed memory.
    std::fill(b.begin(), b.end(), '\0');
    std::fill(v.begin(), v.end(), 0u);
    std::fill(x.begin(), x.end(), 0u);
    return out;
}

}  // namespace clew
