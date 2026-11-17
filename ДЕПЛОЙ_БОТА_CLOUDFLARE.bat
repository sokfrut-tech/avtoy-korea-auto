@echo off
chcp 65001 >nul
title AVTOY KOREA — Прямой деплой бота (Telegram + MAX) в Cloudflare
cd /d "%~dp0"

echo ========================================================================
echo   AVTOY KOREA — Обновление боевого бота (Telegram + MAX) напрямую с ПК
echo   (Работает бесплатно даже когда закончились минуты GitHub Actions!)
echo ========================================================================
echo.
echo [1/3] Восстанавливаем логотип и проверяем SHA-256...
node standby/scripts/restore-worker-assets.mjs
if errorlevel 1 (
  echo [ОШИБКА] Проверка ассетов не прошла.
  pause
  exit /b 1
)

echo.
echo [2/3] Проверяем синтаксис и запускаем 250 автотестов...
call npm.cmd test
if errorlevel 1 (
  echo [ОШИБКА] Тесты не прошли, деплой отменён.
  pause
  exit /b 1
)

echo.
echo [3/3] Запускаем публикацию в Cloudflare (при первом запуске откроется окно входа Cloudflare)...
call npx.cmd --yes wrangler@4 deploy

echo.
echo ========================================================================
echo   ГОТОВО! Боевой Worker с поддержкой Telegram + MAX обновлён!
echo ========================================================================
pause
