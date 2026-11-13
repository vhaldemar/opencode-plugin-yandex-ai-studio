# opencode-plugin-yandex-ai-studio

[OpenCode](https://opencode.ai) plugin: провайдер **Yandex AI Studio** (OpenAI-compatible API) с автоматическим обновлением IAM-токена через `yc iam create-token --profile <profile>`.

## Как работает

- Провайдер регистрируется через `ctx.provider.transform` поверх пакета `@opencode/ai/providers/openai-compatible` (`baseURL: https://ai.api.cloud.yandex.net/v1`), IAM-токен уходит заголовком `Authorization: Bearer <token>`, folder — в `OpenAI-Project`. После каждого обновления токена вызывается `ctx.provider.reload()`, и transform пере-регистрирует провайдера со свежим `apiKey`.
- **Self-heal:** если листинг ответил 401/403 (например, токен в storage реально истёк раньше нашей оценки TTL), плагин принудительно вызывает `yc iam create-token`, минуя кэш и storage, и повторяет запрос; чат-запросы так же спасаются retry-хуком (одна попытка после 401).
- Список моделей подтягивается из codex-ручки `GET {baseURL}/models-codex` (кэш 10 минут, single-flight, последний успешный инвентарь переживает сбои). Это тот же кураторский каталог, что отдаётся Codex CLI: только чат-модели, готовые `display_name`, реальный `context_window`, признак image-входа; фильтруются записи с `visibility != "list"` или `supported_in_api == false`. Ручка отдаёт только `slug`, поэтому modelID конструируется как `gpt://<folder>/<slug>/latest` (формат совпадает с id из OpenAI-листинга). Модели из опции `models` объединяются с каталогом и имеют приоритет.
- Токен кэшируется в plugin storage с TTL 12 ч; за час до истечения планово обновляется (тик раз в 30 минут).
- Обновление — single-flight: конкурентные вызовы (старт сервера, таймер, 401-retry) всегда присоединяются к одному процессу `yc`, а не плодят вкладки браузера.
- `yc` бывает в двух режимах:
  - **quiet** (~1 c): отвечаем, таймаут 10 с;
  - **interactive** (раз в сутки, federation re-auth): детект по stderr (`web site will be opened`), ждём до **5 минут**, шлём события/уведомления.
- Если 5-минутное ожидание не завершено — процесс `yc` убивается, в сессию репортится понятная ошибка («надо было зайти в браузер и авторизоваться»), повтора не будет.

### UX

| Событие | Toast | Футер `YC[AUTH…]` | OS-нотификация |
|---|---|---|---|
| Ждём браузер (до 5 мин) | warning | ✔ | ✔ |
| Токен обновлён | success | — | — |
| Ошибка / таймаут | error | — | ✔ (при таймауте) |

Команда `/yc-auth` — принудительный refresh + synthetic-сообщение с результатом в сессию.

## Конфигурация

Проверенная рабочая настройка — **глобальный** конфиг `~/.config/opencode/opencode.json` (провайдер доступен во всех проектах). Проектный `.opencode/opencode.jsonc` работает так же, если нужен scoped.

### Шаг 1 — секция `plugins` (серверная часть + опции)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/lipkin/repos/opencode-plugin-yandex-ai-studio",
      "options": {
        "profile": "sandbox-fed",
        "folderId": "b1ghsjum2v37c2un8h64",
        "providerID": "yandex-ai-studio",
        "providerName": "Yandex AI Studio (IAM)"
      }
    }
  ]
}
```

`package` — абсолютный путь к каталогу плагина (или имя после публикации в npm). Опции передаются в `setup()` как `ctx.options`.

### Шаг 2 — `enabled_providers` (если ключ уже есть в конфиге)

OpenCode скрывает провайдеров, не входящих в `enabled_providers`, когда тот задан. Провайдер зарегистрируется, но не появится в списках моделей. Добавьте его id:

```jsonc
{
  "enabled_providers": ["ai-studio", "yandex-ai-studio"]
}
```

### Шаг 3 — перезапуск и проверка

```sh
opencode service restart
opencode plugin list        # yandex-ai-studio  local  .../index.ts
opencode models             # yandex-ai-studio/... — модель из листинга /v1/models
```

ПроверитьCredentials можно командой `/yc-auth` в TUI (принудительный refresh + сообщение с результатом).

### Что задать в опциях обязательно

- **`profile`** — профиль `yc` с живой федеративной сессией (`yc iam create-token --profile <имя>` должен отвечать без интерактива).
- **`folderId`** — для user IAM-токенов обязателен: без него API отвечает «folder ID has to be provided in OpenAI-Project header». У федеративных профилей `config get folder-id` пуст, поэтому указывайте явно. Токен и folder должны быть из одного облака (плагин предупреждает, если в id моделей из листинга folder не совпал).

Для headless-режимов (`opencode run`, сервер без TUI) TUI-часть просто не грузится — серверная часть самодостаточна.

### Важные особенности OpenCode (v2.0.x), без которых плагин «не работает»

1. **Корневой entry обязателен.** Загрузчик конфигурированных плагинов ищет части по именам файлов в корне каталога (`index.ts` → серверная, `tui.tsx`, `rpc.ts`); каталог без них **молча пропускается** — ни ошибки, ни warning в логах. В корне репо лежат тонкие реэкспорты, не удаляйте их.
2. **`enabled_providers` скрывает провайдера** (см. шаг 2).
3. **Не смешивать ключи `plugin` (V1) и `plugins` (V2) в одном конфиге**: миграция legacy-ключа может перезатирать V2-массив.
4. **Env-переменные `YC_API_KEY`/`YC_TOKEN` подменяют авторизацию `yc`** (CLI даёт им приоритет над профилем). Плагин вырезает их при spawn, иначе `iam create-token` выпускал бы токен сервисного аккаунта от чужого API-key → 403 от API.

## Опции

| Опция | По умолчанию | Описание |
|---|---|---|
| `profile` | `"default"` | профиль `yc` для `iam create-token` |
| `baseURL` | `https://ai.api.cloud.yandex.net/v1` | endpoint OpenAI-compatible API (AI Studio) |
| `modelsEndpoint` | `{baseURL}/models` | ручка листинга моделей (`null` — отключить листинг) |
| `modelPrefixes` | `["gpt://"]` | фильтр листинга: id моделей с этими префиксами (эмбеддинги/realtime отсекаются) |
| `modelsCacheMs` | `600000` | срок жизни листинга |
| `providerID` | `"yandex-ai-studio"` | id провайдера в OpenCode |
| `folderId` | из профиля `yc` (`config get folder-id`) | folder id для заголовка `OpenAI-Project` (обязателен для user IAM-токенов) |
| `models` | `[]` (только листинг) | модели поверх листинга (`string` или `{id, name, context}`) |
| `ycBin` | `"yc"` | путь к бинарнику `yc` |
| `quietTimeoutMs` | `10000` | таймаут quiet-режима |
| `interactiveTimeoutMs` | `300000` | таймаут браузерной авторизации (5 мин) |
| `refreshIntervalMs` | `1800000` | тик проверки TTL |

## Безопасность

- Полный токен никогда не попадает в логи (`redact()`: первые 6 символов).
- В RPC-событиях токена нет вообще — только состояние и `expiresAt`.
- Токен хранится в plugin-scoped storage OpenCode (`ctx.storage`), локально на машине.

## Разработка

```sh
npm install
npx tsc --noEmit
```

## TODO / идеи

- Опция `authMode` для API-key (без `yc` вообще).
- GUI-часть для OpenCode Desktop.
