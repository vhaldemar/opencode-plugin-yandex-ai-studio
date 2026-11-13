# opencode-plugin-yandex-ai-studio

[OpenCode](https://opencode.ai) plugin: провайдер **Yandex AI Studio** (OpenAI-compatible API) с автоматическим обновлением IAM-токена через `yc iam create-token` (без опции `profile` — без `--profile`).

**Что даёт:**
- провайдер с живым списком моделей (кураторский codex-каталог + raw-листинг), thinking-effort варианты (`#high`, `#none`, …);
- IAM-токен сам обновляется (quiet и интерактивный браузерный вход — с тостами и OS-нотификациями);
- квоты подписки: футер `YC[5ч%/7д%]`, команда `/yc-usage`, умный 429-retry по времени сброса окна;
- self-heal по 401/403 (перезапуск `yc` и повтор);

Команды:
- `/yc-auth` — принудительный refresh токена; результат — тост (success/error).
- `/yc-usage` — сводка по квотам подписки (план, % окна 5ч/7д, относительное время сброса) — тост: success при норме, warning при ≥80% окна, error при исчерпанном лимите.

Как это устроено внутри (transport, self-heal, merge листингов, UX-контракт) — в [ARCHITECTURE.md](./ARCHITECTURE.md); подводные камни платформы OpenCode — в [AGENTS.md](./AGENTS.md).

## Конфигурация

Проверенная рабочая настройка — **глобальный** конфиг `~/.config/opencode/opencode.json` (провайдер доступен во всех проектах). Проектный `.opencode/opencode.jsonc` работает так же, если нужен scoped.

### Шаг 1 — секция `plugins` (серверная часть + опции)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-plugin-yandex-ai-studio",
      "options": {
        "profile": "your-yc-profile",
        "folderId": "your-folder-id",
        "providerID": "yandex-ai-studio",
        "providerName": "Yandex AI Studio"
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
  "enabled_providers": ["your-existing-provider", "yandex-ai-studio"]
}
```

### Шаг 3 — перезапуск и проверка

```sh
opencode service restart
opencode plugin list        # yandex-ai-studio  local  .../index.ts
opencode models             # yandex-ai-studio/... — модель из листинга /v1/models
```

Проверить credentials можно командой `/yc-auth` в TUI (принудительный refresh, результат — тост).

### Что задать в опциях обязательно

- **`profile`** — опционален: если не указан, `yc iam create-token` вызывается **без** `--profile` и использует активный профиль yc (тот, что установлен через `yc config profile activate`). Если указываете — профиль должен иметь живую федеративную сессию.
- **`folderId`** — для user IAM-токенов обязателен: без него API отвечает «folder ID has to be provided in OpenAI-Project header». Плагин пробует взять его из `yc config get folder-id [--profile]`; у федеративных профилей он часто пуст, тогда указывайте явно. Токен и folder должны быть из одного облака.

Для headless-режимов (`opencode run`, сервер без TUI) TUI-часть просто не грузится — серверная часть самодостаточна.

> Подводные камни платформы OpenCode — в [AGENTS.md](./AGENTS.md), внутреннее устройство — в [ARCHITECTURE.md](./ARCHITECTURE.md).

## Опции

| Опция | По умолчанию | Описание |
|---|---|---|
| `profile` | не задан → `yc` без `--profile` (активный профиль yc) | профиль `yc` для `iam create-token` |
| `baseURL` | `https://apps.ai.api.cloud.yandex.net/v1` | база для всех endpoint'ов (apps-вход AI Studio); чат идёт в `{baseURL}/chat/completions` с folder в `OpenAI-Project` |
| `codexModelsEndpoint` | `{baseURL}/models-codex` | ручка кураторского каталога (`x-folder-id`; `null` — отключить) |
| `usageEndpoint` | `{baseURL}/api/codex/usage` | ручка квот подписки (`x-folder-id`; кэш 60 с) |
| `modelsEndpoint` | `{baseURL}/models` | ручка raw-листинга OpenAI (`OpenAI-Project`; `null` — отключить) |
| `modelPrefixes` | `["gpt://"]` | фильтр raw-листинга: остаются только чат-совместимые `gpt://` id (эмбеддеры `emb://` и пр. отсекаются) |
| `modelsCacheMs` | `600000` | срок жизни инвентаря моделей |
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

- GUI-часть для OpenCode Desktop.
