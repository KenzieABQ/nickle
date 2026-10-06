@echo off
rem Windows launcher: double-click to start Local Downloader.
rem It updates the app from GitHub, installs dependencies if needed, starts
rem the server and opens your browser.
setlocal
cd /d "%~dp0"
title Local Downloader

rem Everything runs inside one block: cmd reads a block fully before running
rem it, so an update that changes this file cannot disturb it.
(
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js was not found. Install it ^(see README.md^) and try again.
    pause
    exit /b 1
  )
  node launch.js
  if errorlevel 1 pause
  exit /b
)
