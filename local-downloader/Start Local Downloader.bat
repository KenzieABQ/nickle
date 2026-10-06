@echo off
rem Windows launcher: double-click to start Local Downloader.
setlocal
cd /d "%~dp0"
title Local Downloader

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it ^(see README.md^) and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

node server.js --open
if errorlevel 1 pause
