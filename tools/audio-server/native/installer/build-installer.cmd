@echo off
rem Builds the program (Release, unit tests run), then the installer:
rem   tools\audio-server\native\dist\clew-audio-server-setup-<version>.exe
rem Needs Visual Studio's C++ tools and Inno Setup 6 (winget install JRSoftware.InnoSetup).
setlocal
cd /d "%~dp0"
call ..\build.cmd Release || exit /b 1
set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (echo Inno Setup 6 was not found: winget install JRSoftware.InnoSetup& exit /b 1)
"%ISCC%" /Q clew-audio-server.iss || exit /b 1
echo Built: %~dp0..\dist
