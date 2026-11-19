// PBKDF2-HMAC-SHA-256 (RFC 8018) and scrypt (RFC 7914), over sha256.h. Portable, no third-party
// code; the RFC 7914 test vectors are in test/unit_tests.cpp.
//
// Why it is here (docs/22 §10.5, A20): the Python audio server keeps only an scrypt hash of its
// secret (N 2^14, r 8, p 1, 32 bytes, in its config.json). With scrypt, this server can accept that
// secret too, so a person who switches from the Python server to this one pastes nothing again.
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace clew {

std::string pbkdf2_hmac_sha256(const std::string& password, const std::string& salt,
                               std::uint32_t iterations, std::size_t length);

// nullopt when the parameters are not ones scrypt allows (N a power of two above 1, r and p at
// least 1), or would need more than 64 MiB: what is checked here is a stored hash, so the
// parameters are fixed by whoever wrote it, and an outsized pair is refused rather than tried.
std::optional<std::string> scrypt(const std::string& password, const std::string& salt,
                                  std::uint64_t n, std::uint32_t r, std::uint32_t p,
                                  std::size_t length);

}  // namespace clew
