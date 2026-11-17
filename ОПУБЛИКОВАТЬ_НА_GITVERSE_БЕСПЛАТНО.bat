@echo off
chcp 65001 >nul
title AVTOY KOREA — Бесплатная публикация в РФ (GitVerse Pages — 0 руб без карты)
cd /d "%~dp0"

echo ========================================================================
echo   AVTOY KOREA — Обновление и публикация на бесплатный GitVerse Pages (РФ)
echo   Стоимость: 0 руб. Организация/ИП и банковская карта НЕ нужны!
echo ========================================================================
echo.
echo [1/3] Скачиваем свежие авто, отзывы, фото и видео с проверкой SHA-256...
node standby/scripts/migrate-to-ru.mjs
if errorlevel 1 (
  echo.
  echo [ОШИБКА] Не удалось синхронизировать каталог. Проверьте подключение.
  pause
  exit /b 1
)

echo.
set "GV_URL=https://gitverse.ru/opus_pampus/avtoy-korea.git"
set /p GV_INPUT="Ссылка на GitVerse [Enter = %GV_URL%]: "
if not "%GV_INPUT%"=="" set "GV_URL=%GV_INPUT%"

echo.
echo [2/3] Готовим чистую витрину без секретов...
set "GIT_EXE=C:\Program Files\Git\cmd\git.exe"
if not exist "%GIT_EXE%" set "GIT_EXE=git"

pushd standby\public
if not exist ".git" (
  "%GIT_EXE%" init -b main
)
"%GIT_EXE%" remote remove origin 2>nul
"%GIT_EXE%" remote add origin "%GV_URL%"
"%GIT_EXE%" add -A
"%GIT_EXE%" commit -m "chore: update AVTOY KOREA Russian mirror catalogue" 2>nul

echo.
echo [3/3] Отправляем витрину на российский сервер GitVerse...
"%GIT_EXE%" push -u origin main --force
popd

echo.
echo ========================================================================
echo   ГОТОВО! В настройках репозитория на GitVerse включите вкладку Pages
echo   (ветка main, корневая папка /). Сайт сразу заработает в России бесплатно!
echo ========================================================================
pause
