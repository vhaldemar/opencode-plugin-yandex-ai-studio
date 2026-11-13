# opencode-plugin-yandex-ai-studio

[OpenCode](https://opencode.ai) plugin: провайдер **Yandex AI Studio** (OpenAI-compatible API) с автоматическим обновлением IAM-токена через `yc iam create-token --profile <profile>`.

## Как работает

- Провайдер регистрируется через `ctx.provider.transform` поверх пакета `@opencode/ai/providers/openai-compatible` (`baseURL: https://llm.api.cloud.yandex.net/v1`), IAM-токен уходит заголовком `Authorization: Bearer <token>`.
- Список моделей подтягивается из OpenAI-совместимой ручки `GET {baseURL}/models` (кэш 10 минут, single-flight, последний успешный инвентарь переживает сбои). Ручка скопирована по folder из заголовка `OpenAI-Project`, а `data[].id` — готовый modelID вида `gpt://<folder>/<model>/latest` с вшитым folder; отображаемое имя укорачивается до `<model>`. Модели из опции `models` объединяются с обнаруженными и имеют приоритет (можно задать `name`/`context`). Фильтр `modelPrefixes` по умолчанию оставляет только чат-модели `gpt://`.
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

## Установка

В проекте, где нужен провайдер:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/lipkin/repos/opencode-plugin-yandex-ai-studio",
      "options": {
        "profile": "sandbox-fed",
        "folderId": "b1ghsjum2v37c2un8h64",
        "models": []
      }
    }
  ],
  // если enabled_providers уже задан — добавьте провайдера туда:
  "enabled_providers": ["yandex-ai-studio"]
}
```

Для headless-режимов (`opencode run`, сервер без TUI) TUI-часть просто не грузится — серверная часть самодостаточна.

### Важные особенности OpenCode (v2.0.x)

1. **Корневой entry обязателен.** Загрузчик конфигурированных плагинов ищет части по именам файлов в корне каталога (`index.ts` → сервер, `tui.tsx`, `rpc.ts`); каталог без них **молча пропускается** (без warning). В корне репо лежат тонкие реэкспорты.
2. **`enabled_providers` скрывает провайдера.** Если в конфиге задан `"enabled_providers": [...]`, провайдер плагина нужно добавить в этот список, иначе он не появится в списках моделей, хотя будет зарегистрирован.
3. **Рекомендуемая настройка — глобальная** (`~/.config/opencode/opencode.json`), ключ `plugins` (V2). В одной конфигурации legacy-ключ `plugin` (V1) и `plugins` не смешивать: первый может перезатирать второй при миграции.

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
