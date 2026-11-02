@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
pushd "%~dp0"
set "DEV_PROFILE=%LOCALAPPDATA%\OriCode\dev-user-data"
call npm --prefix extensions/oricode-agent run compile
if errorlevel 1 (
	popd
	exit /b 1
)
if not exist "%DEV_PROFILE%" mkdir "%DEV_PROFILE%"
start "OriCode Dev" /min cmd /c ""%~dp0scripts\code.bat" --user-data-dir="%DEV_PROFILE%" --skip-welcome --disable-extension=GitHub.copilot --disable-extension=GitHub.copilot-chat --disable-extension=GitHub.copilot-nightly --disable-extension=GitHub.copilot-chat-nightly %* > "%DEV_PROFILE%\oricode-console.log" 2>&1"
set "EXIT_CODE=%ERRORLEVEL%"
popd
endlocal & exit /b %EXIT_CODE%
