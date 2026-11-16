@echo off
setlocal
chcp 65001 >nul

set "APP_EXE=%~dp0Zvuk-Glass-Observatory-3.0.0-Test.exe"
if not exist "%APP_EXE%" set "APP_EXE=%~dp0src-tauri\target\release\zvuk-glass.exe"
if not exist "%APP_EXE%" (
  echo Не найден Zvuk-Glass-Observatory-3.0.0-Test.exe
  echo Оставьте этот CMD рядом с тестовым EXE.
  pause
  exit /b 1
)

rem По умолчанию тестовая копия хранит настройки и WebView2 в своей папке Data.
rem /shared — явно использовать данные основной установленной версии.
if /I "%~1"=="/shared" (
  shift
  start "" /D "%~dp0" "%APP_EXE%" %*
  exit /b
)

set "APPDATA=%~dp0Data"
if not exist "%APPDATA%" md "%APPDATA%"
start "" /D "%~dp0" "%APP_EXE%" --portable %*
