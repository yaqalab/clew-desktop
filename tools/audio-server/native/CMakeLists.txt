cmake_minimum_required(VERSION 3.20)
project(clew_audio_server VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  # Static C++ runtime: the .exe needs no Visual C++ redistributable.
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  add_compile_options(/W4 /permissive- /utf-8 /sdl /guard:cf /EHsc /Zc:__cplusplus /Qspectre-)
  add_link_options(/guard:cf /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /CETCOMPAT)
  add_compile_definitions(WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE _WIN32_WINNT=0x0A00 WINVER=0x0A00)
else()
  add_compile_options(-Wall -Wextra -fstack-protector-strong -D_FORTIFY_SOURCE=2)
endif()

# The portable core: the HTTP server, links, files, mp3 tags, settings, conversion cache.
add_library(clew_core STATIC
  src/core/convert_cache.cpp
  src/core/files.cpp
  src/core/headless.cpp
  src/core/json.cpp
  src/core/mp3.cpp
  src/core/server.cpp
  src/core/service.cpp
  src/core/settings.cpp
  src/core/sha256.cpp
  src/core/text.cpp
)
target_include_directories(clew_core PUBLIC src/core)

# What each system supplies (platform.h).
if(WIN32)
  add_library(clew_platform STATIC src/win/platform_win.cpp src/win/mf_convert.cpp)
  target_link_libraries(clew_platform PUBLIC ws2_32 bcrypt crypt32 mfplat mfreadwrite mfuuid wmcodecdspuuid
    ole32 shell32 advapi32)
else()
  # macOS and Linux: compatible, not built or tested yet (README, "Other systems").
  add_library(clew_platform STATIC src/posix/platform_posix.cpp)
  find_package(Threads REQUIRED)
  target_link_libraries(clew_platform PUBLIC Threads::Threads)
endif()
target_link_libraries(clew_core PUBLIC clew_platform)
target_link_libraries(clew_platform PUBLIC clew_core)

if(WIN32)
  add_executable(clew-audio-server WIN32
    src/win/main_win.cpp
    src/win/tray_win.cpp
    src/win/strings.cpp
    res/app.rc
  )
  target_link_libraries(clew-audio-server PRIVATE clew_core clew_platform comctl32 user32 gdi32 shlwapi)
  # The manifest is a resource (app.rc), not a step after linking: that step rewrote the fresh exe
  # while an antivirus scan held it open, and failed.
  target_link_options(clew-audio-server PRIVATE /MANIFEST:NO)
  # The resource compiler's includes are not tracked: a changed icon alone must rebuild the resources.
  file(GLOB CLEW_ICONS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/res/icons/*.ico)
  set_source_files_properties(res/app.rc PROPERTIES OBJECT_DEPENDS "${CLEW_ICONS};${CMAKE_CURRENT_SOURCE_DIR}/res/resource.h;${CMAKE_CURRENT_SOURCE_DIR}/res/app.manifest")
else()
  add_executable(clew-audio-server src/posix/main_posix.cpp)
  target_link_libraries(clew-audio-server PRIVATE clew_core clew_platform)
endif()

enable_testing()
add_executable(unit_tests test/unit_tests.cpp)
target_link_libraries(unit_tests PRIVATE clew_core clew_platform)
add_test(NAME unit_tests COMMAND unit_tests)
