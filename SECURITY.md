# Atomix AI — Security Guide

## Текущая защита

### Серверная часть (Netlify Functions)
- ✅ Все API-ключи (DeepSeek, Gemini, Tavily) хранятся в `process.env` — не видны клиенту
- ✅ Rate limiting для предотвращения abuse
- ✅ CORS-заголовки для ограничения запросов
- ✅ Supabase anon key в клиенте — это публичный ключ, так задумано

### Фронтенд
- ✅ Content-Security-Policy заголовок для защиты от XSS
- ✅ Детекция вредоносных запросов (клиент + серверный промпт)
- ✅ Система банов за нарушения

---

## Рекомендации для Electron (десктопного приложения)

### Проблема
При установке Electron-приложения пользователь может открыть папку с файлами приложения и увидеть:
- Исходный HTML/JS код
- .txt файлы с промптами и правилами безопасности
- Конфигурацию

### Решения

#### 1. Переместить промпты в ENV-переменные (приоритет!)
Вместо .txt файлов на диске используй env-переменные:
```
PROMPT_BASIC=Текст базового промпта...
PROMPT_BEFORE_JAILBREAK=Текст предупреждения...
PROMPT_JAILBREAK=Текст для jailbreak режима...
```
Бэкенд (`veva-chat.mjs`) уже поддерживает это — приоритет отдаётся env-переменным.

#### 2. Использовать ASAR-упаковку
В `electron-builder` конфиге включи:
```json
{
  "asar": true,
  "asarUnpack": ["**/node_modules/sharp/**"]
}
```
Это упакует исходники в один зашифрованный файл `.asar`.

#### 3. Минификация кода
Перед сборкой Electron используй:
```bash
npx terser index.html -o index.min.html --compress --mangle
```
Или webpack/vite для полной сборки.

#### 4. Не включать промпт-файлы в пакет
В `.gitignore` и `electron-builder` исключай:
```
*.txt
site-config/
```
Промпты должны загружаться только с сервера.

#### 5. Проверка целостности
Добавить проверку хеша приложения при запуске, чтобы обнаружить модификации.

---

## Полезные ресурсы
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
