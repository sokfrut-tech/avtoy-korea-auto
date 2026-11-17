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
echo [2/3] Готовим чистую витрину без секретов (партиями до 18 МБ для защиты от HTTP 413)...
set "GIT_EXE=C:\Program Files\Git\cmd\git.exe"
if not exist "%GIT_EXE%" set "GIT_EXE=git"

pushd standby\public
if not exist ".git" (
  "%GIT_EXE%" init -b main
  "%GIT_EXE%" config user.name "AVTOY KOREA"
  "%GIT_EXE%" config user.email "noreply@avtoykorea.local"
)
"%GIT_EXE%" remote remove origin 2>nul
"%GIT_EXE%" remote add origin "%GV_URL%"

echo.
echo [3/3] Отправляем витрину на российский сервер GitVerse...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Continue'; $pub=(Get-Location).Path; $git='%GIT_EXE%'; $files=& $git status --porcelain -u | ForEach-Object { $_.Substring(3).Trim('\"') } | Where-Object { Test-Path $_ } | Sort-Object { (Get-Item $_).Length }; if (-not $files) { & $git push -u origin main; exit $LASTEXITCODE }; $max=18*1024*1024; $batches=@(); $cur=New-Object System.Collections.Generic.List[string]; $bytes=0L; foreach($f in $files){ $len=(Get-Item $f).Length; if($cur.Count -gt 0 -and ($bytes+$len) -gt $max){ $batches+=,($cur.ToArray()); $cur=New-Object System.Collections.Generic.List[string]; $bytes=0L }; $cur.Add($f); $bytes+=$len }; if($cur.Count -gt 0){ $batches+=,($cur.ToArray()) }; for($i=0;$i -lt $batches.Count;$i++){ & $git add -- $batches[$i]; & $git commit -q -m ('chore: publish showcase batch '+($i+1)+'/'+$batches.Count); & $git push -u origin main; if($LASTEXITCODE -ne 0){ exit $LASTEXITCODE } }"
popd

echo.
echo ========================================================================
echo   ГОТОВО! В настройках репозитория на GitVerse включите вкладку Pages
echo   (ветка main, корневая папка /). Сайт сразу заработает в России бесплатно!
echo ========================================================================
pause
