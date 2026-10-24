# AVTOY KOREA — сайт и Telegram-бот

Исходный файл Cloudflare Worker: `worker.js`. Имя файла и папка проекта сохранены.

## Что умеет бот

Webhook-адрес после публикации Worker: `https://avtoy-korea-auto.sokfrut.workers.dev/telegram/webhook`

Команды:
- `/start` — приветствие и меню;
- `/help` — подсказка;
- `/countries` — Корея, Китай, ОАЭ;
- `/catalog` — как проходит подбор (это описание процесса, не живой каталог объявлений);
- `/contact` — сайт и канал;
- `/reply CHAT_ID текст` — ответ клиенту от имени бота, доступен только администратору.

Сообщения клиентов бот пересылает в административный чат. В уведомлении указывается Chat ID, который используется для команды `/reply`.

## Настройка перед запуском

В Cloudflare Workers → `avtoy-korea-auto` → Settings → Variables and Secrets добавьте:

- `TELEGRAM_BOT_TOKEN` — новый токен бота, сохранённый как Secret;
- `TELEGRAM_CHAT_ID` — Chat ID административного чата;
- `TELEGRAM_WEBHOOK_SECRET` — отдельная случайная строка 1–256 символов из букв A-Z/a-z, цифр, подчёркивания и дефиса. Сохранить как Secret.

Не добавляйте токены в GitHub, исходный код, скриншоты или публичные сообщения. Если ранее токен публиковался в чате, сначала отзовите его у `@BotFather` и создайте новый.

После публикации Worker нужно зарегистрировать webhook у Telegram, передав:
- URL: `https://avtoy-korea-auto.sokfrut.workers.dev/telegram/webhook`
- `secret_token`: значение `TELEGRAM_WEBHOOK_SECRET`

Telegram webhook должен быть зарегистрирован именно с новым токеном бота. Без публикации Worker, секретов и регистрации webhook бот ещё не работает в Telegram.

## Проверки и безопасность

- Секрет webhook проверяется по заголовку `X-Telegram-Bot-Api-Secret-Token`.
- Команда `/reply` доступна только чату, указанному в `TELEGRAM_CHAT_ID`.
- Форма сайта использует `POST /api/request`; при настроенных Telegram-секретах заявки отправляются в административный чат.
- Перед публикацией проверьте команды тестовым сообщением и отправку тестовой заявки.

## Резервные версии

Перед изменением `worker.js` создаётся копия в `versions/worker_YYYY-MM-DD_HH-MM-SS.js` (время Германии). Основной файл всегда называется `worker.js`.
