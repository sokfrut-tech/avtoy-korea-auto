@echo off
chcp 65001 >nul
title AVTOY KOREA — Российское зеркало (Локальная проверка)
cd /d "%~dp0"

echo ==============================================================
echo   AVTOY KOREA — Запуск российского сайта на http://localhost:8080
echo ==============================================================
echo.
start "" "http://localhost:8080"
node standby/server.mjs
pause
