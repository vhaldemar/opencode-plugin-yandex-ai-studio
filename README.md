# opencode-plugin-yandex-ai-studio

[OpenCode](https://opencode.ai) plugin: провайдер **Yandex AI Studio** (OpenAI-compatible API) с автоматическим обновлением IAM-токена через `yc iam create-token --profile <profile>`.

## Как работает

- Провайдер регистрируется через `ctx.provider.transform` поверх пакета `@opencode/ai/providers/openai-compatible` (`baseURL: https://apps.ai.api.cloud.yandex.net/v1`, CNAME на `apps-ai-api.ml-rag.cloud.yandex.net`), IAM-токен уходит заголовком `Authorization: Bearer <token>`, folder — в `OpenAI-Project`. После каждого обновления токена вызывается `ctx.provider.reload()`, и transform пере-регистрирует провайдера со свежим `apiKey`.
- **Self-heal:** если листинг ответил 401/403 (например, токен в storage реально истёк раньше нашей оценки TTL), плагин принудительно вызывает `yc iam create-token`, минуя кэш и storage, и повторяет запрос; чат-запросы так же спасаются retry-хуком (одна попытка после 401).
- Список моделей — мердж двух листингов (кэш 10 минут, single-flight, последний успешный инвентарь переживает сбои):
  - **кураторский codex-каталог** `GET {baseURL}/models-codex` (folder в `x-folder-id`): только чат-модели, готовые `display_name`, реальный `context_window`, признак image-входа; записи с `visibility != "list"` или `supported_in_api == false` отбрасываются;
  - **raw-листинг** `GET {baseURL}/models` (folder в `OpenAI-Project`): id вида `gpt://<folder>/<slug>/latest`, фильтр `modelPrefixes`.
  - Если slug есть в обоих — побеждает codex-инфо (имя/контекст/vision), modelID берётся точный из raw-листинга; модели только из raw-листинга добавляются с коротким именем. Опция `models` накладывается поверх и имеет приоритет.
- Токен кэшируется в plugin storage с TTL 12 ч; за час до истечения планово обновляется (тик раз в 30 минут).
- Обновление — single-flight: конкурентные вызовы (старт сервера, таймер, 401-retry) всегда присоединяются к одному процессу `yc`, а не плодят вкладки браузера.
- `yc` бывает в двух режимах:
  - **quiet** (~1 c): отвечаем, таймаут 10 с;
  - **interactive** (раз в сутки, federation re-auth): детект по stderr (`web site will be opened`), ждём до **5 минут**, шлём события/уведомления.
- Если 5-минутное ожидание не завершено — процесс `yc` убивается, ошибка репортится тостом и OS-нотификацией («надо было зайти в браузер и авторизоваться»), повтора не будет.

### UX

| Событие | Toast | Футер | OS-нотификация |
|---|---|---|---|
| Ждём браузер (до 5 мин) | warning | `YC[AUTH…]` (жёлтый) | ✔ |
| Токен обновлён | success | — | — |
| Ошибка / таймаут | error | — | ✔ (при таймауте) |
| Квота: usage-снапшот получен | — | `YC[1%/4%]` (зелёный; красный при ≥80%) | — |
| Квота ≥80% окна 5ч | warning | — | — |
| Лимит подписки исчерпан | error | — | — |
| `/yc-usage` / `/yc-auth` | success / warning / error | — | — |

Команды:
- `/yc-auth` — принудительный refresh токена; результат — тост (success/error).
- `/yc-usage` — сводка по квотам подписки (план, % окна 5ч/7д, относительное время сброса) — тост: success при норме, warning при ≥80% окна, error при исчерпанном лимите.

Отчёты команд идут через RPC-событие `usage.report` в TUI-тост, а **не** synthetic-сообщением в сессию: synthetic имеет `delivery: "steer"`, то есть становится промптом, на который агент отвечает. Тост гарантирует, что отчёт — чисто UI-инфо: модель не привлекается, в сессию ничего не пишется, токены не тратятся (trade-off: отчёт живёт ~10 с и не остаётся в скролле сессии).

Thinking efforts: из кураторского каталога тянется `supported_reasoning_levels` (+ `default_reasoning_level`). Базовая модель равна дефолтному effort'у; каждый другой effort экспонируется как вариант `provider/<model>#<effort>` — вариант кладёт `reasoning_effort` в тело chat-запроса (например `yandex-ai-studio/gpt://<folder>/<model>/latest#high`). Reasoning-контент моделей приходит в `reasoning_content` и отображается нативно.

Квоты берутся из codex-ручки `GET {baseURL}/api/codex/usage` (folder через `x-folder-id`, кэш 60 с) и обновляются в фоне вместе с инвентарём моделей. При **429** (rate limit) retry-хук читает `reset_after_seconds` и ставит задержку повтора до момента сброса окна (с запасом 5 с, капа 15 мин) вместо слепого экспоненциального backoff.

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

> Подводные камни платформы OpenCode (корневые entry-файлы, гонки холодного старта, V1/V2 ключи конфига, `YC_*` env) собраны в [AGENTS.md](./AGENTS.md).

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
