# Atomix AI Site Package

Эта папка содержит полную сборку сайта Atomix AI для Netlify.

## Структура

- `index.html` — основной ИИ-бот.
- `assets/loader.css` — единый loader Atomix.
- `manifest.json` — PWA manifest.
- `sw.js` — service worker.
- `netlify/functions/veva-chat.mjs` — основная функция ИИ.
- `netlify/functions/ban-appeals.mjs` — функция апелляций/банов.
- `.env.example` — список нужных API-ключей без реальных секретов.
- `Atomix AI.png` и `icons/` — визуальные ассеты.

## API-ключи

Реальные ключи нельзя хранить в этой папке. Их нужно добавить в Netlify Environment Variables:

- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`
- `TAVILY_API_KEY`

Дополнительно можно настроить:

- `DEEPSEEK_MODEL`
- `DEEPSEEK_VISION_MODEL`
- `GEMINI_VISION_MODEL`
- `CHAT_RATE_LIMIT_PER_MINUTE`
- `APPEALS_RATE_LIMIT_PER_MINUTE`
- `ALLOWED_ORIGINS`

## Деплой

В Netlify укажи:

- Publish directory: корень этой папки
- Functions directory: `netlify/functions`

Для локальной проверки можно открыть `index.html`, но API-функции полноценно работают через Netlify или локальный сервер, который умеет проксировать `/.netlify/functions/*`.
