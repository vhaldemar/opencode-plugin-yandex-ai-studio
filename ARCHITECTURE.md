# Как работает плагин изнутри

Архитектурные детали провайдера для контрибьюторов; пользовательская инструкция — в [README](./README.md), платформенныеquirks — в [AGENTS.md](./AGENTS.md).

## Провайдер и transport

- Провайдер регистрируется через `ctx.provider.transform` поверх пакета `@opencode/ai/providers/openai-compatible` (`baseURL: https://apps.ai.api.cloud.yandex.net/v1`, CNAME на `apps-ai-api.ml-rag.cloud.yandex.net`), IAM-токен уходит заголовком `Authorization: Bearer <token>`, folder — в `OpenAI-Project`. После каждого обновления токена вызывается `ctx.provider.reload()`, и transform пере-регистрирует провайдера со свежим `apiKey`.
- **Self-heal:** если листинг ответил 401/403 (например, токен в storage реально истёк раньше нашей оценки TTL), плагин принудительно вызывает `yc iam create-token`, минуя кэш и storage, и повторяет запрос; чат-запросы так же спасаются retry-хуком (одна попытка после 401).

## Токен (`src/token.ts`)

- Токен кэшируется в plugin storage с TTL 12 ч; за час до истечения планово обновляется (тик раз в 30 минут).
- Обновление — single-flight: конкурентные вызовы (старт сервера, таймер, 401-retry) всегда присоединяются к одному процессу `yc`, а не плодят вкладки браузера.
- `yc` бывает в двух режимах:
  - **quiet** (~1 c): отвечаем, таймаут 10 с;
  - **interactive** (раз в сутки, federation re-auth): детект по stderr (`web site will be opened`), ждём до **5 минут**, шлём события/уведомления.
- Если 5-минутное ожидание не завершено — процесс `yc` убивается, ошибка репортится тостом и OS-нотификацией («надо было зайти в браузер и авторизоваться»), повтора не будет.

## Список моделей (`src/models.ts`)

Мердж двух листингов (кэш 10 минут, single-flight, последний успешный инвентарь переживает сбои):

- **кураторский codex-каталог** `GET {baseURL}/models-codex` (folder в `x-folder-id`): только чат-модели, готовые `display_name`, реальный `context_window`, признак image-входа; записи с `visibility != "list"` или `supported_in_api == false` отбрасываются;
- **raw-листинг** `GET {baseURL}/models` (folder в `OpenAI-Project`): id вида `gpt://<folder>/<slug>/latest`, фильтр `modelPrefixes`.
- Если slug есть в обоих — побеждает codex-инфо (имя/контекст/vision), modelID берётся точный из raw-листинга; модели только из raw-листинга добавляются с коротким именем. Опция `models` накладывается поверх и имеет приоритет.

### Thinking efforts

Из кураторского каталога тянется `supported_reasoning_levels` (+ `default_reasoning_level`). Базовая модель равна дефолтному effort'у; каждый другой effort экспонируется как вариант `provider/<model>#<effort>` — вариант кладёт `reasoning_effort` в тело chat-запроса (например `yandex-ai-studio/gpt://<folder>/<model>/latest#high`). Reasoning-контент моделей приходит в `reasoning_content` и отображается нативно.

## Квоты и 429 (`GET {baseURL}/api/codex/usage`)

Квоты берутся из codex-ручки (folder через `x-folder-id`, кэш 60 с) и обновляются в фоне вместе с инвентарём моделей. При **429** (rate limit) retry-хук читает `reset_after_seconds` и ставит задержку повтора до момента сброса окна (с запасом 5 с, капа 15 мин) вместо слепого экспоненциального backoff.

## UX-контракт (`src/rpc.ts`, `src/tui.tsx`)

| Событие | Toast | Футер | OS-нотификация |
|---|---|---|---|
| Ждём браузер (до 5 мин) | warning | `YC[AUTH…]` (жёлтый) | ✔ |
| Токен обновлён | success | — | — |
| Ошибка / таймаут | error | — | ✔ (при таймауте) |
| Квота: usage-снапшот получен | — | `YC[1%/4%]` (зелёный; красный при ≥80%) | — |
| Квота ≥80% окна 5ч | warning | — | — |
| Лимит подписки исчерпан | error | — | — |
| `/yc-usage` / `/yc-auth` | success / warning / error | — | — |

Отчёты команд идут через RPC-событие `usage.report` в TUI-тост, а **не** synthetic-сообщением в сессию: synthetic имеет `delivery: "steer"`, то есть становится промптом, на который агент отвечает. Тост гарантирует, что отчёт — чисто UI-инфо: модель не привлекается, в сессию ничего не пишется, токены не тратятся (trade-off: отчёт живёт ~10 с и не остаётся в скролле сессии).
