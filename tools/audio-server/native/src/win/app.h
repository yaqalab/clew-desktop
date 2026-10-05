#pragma once

#include <windows.h>

namespace clew::win {

// The tray icon and the settings window; returns when the user quits.
int run_tray(HINSTANCE instance);

}  // namespace clew::win
