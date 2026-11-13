# opencode-plugin-yandex-ai-studio

[OpenCode](https://opencode.ai) plugin: провайдер **Yandex AI Studio** (OpenAI-compatible API) с автоматическим обновлением IAM-токена через `yc iam create-token --profile <profile>`.

## Как работает

- Провайдер регистрируется через `ctx.provider.transform` поверх пакета `@opencode/ai/providers/openai-compatible` (`baseURL: https://llm.api.cloud.yandex.net/v1`), IAM-токен уходит заголовком `Authorization: Bearer <token>`.
- Список моделей подтягивается из OpenAI-совместимой ручки `GET {baseURL}/models` (кэш 10 минут, single-flight, последний успешный инвентарь переживает сбои); модели из опции `models` объединяются с обнаруженными и имеют приоритет (можно задать `name`/`context`).
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
// .opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/lipkin/repos/opencode-plugin-yandex-ai-studio",
      "options": {
        "profile": "sandbox-fed",
        "//": "folderId можно не указывать, если у профиля yc есть folder-id",
        "models": []
      }
      }
    }
  ]
}
```

Для headless-режимов (`opencode run`, сервер без TUI) TUI-часть просто не грузится — серверная часть самодостаточна.

## Опции

| Опция | По умолчанию | Описание |
|---|---|---|
| `profile` | `"default"` | профиль `yc` для `iam create-token` |
| `baseURL` | `https://llm.api.cloud.yandex.net/v1` | endpoint OpenAI-compatible API |
| `modelsEndpoint` | `{baseURL}/models` | ручка листинга моделей (`null` — отключить листинг) |
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
