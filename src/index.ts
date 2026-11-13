import { Model, Plugin, Provider } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { fetchCodexModels, fetchCodexUsage, fetchModels, type CodexCatalogModel, type CodexUsage } from "./models.js"
import { YandexAuth } from "./rpc.js"
import {
  cleanYcEnv,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_SAFETY_MS,
  DEFAULT_TOKEN_TTL_MS,
  TokenManager,
  type TokenState,
} from "./token.js"

/**
 * Plugin options (object form in opencode.jsonc `plugins` array).
 */
export interface Options {
  /** `yc` config profile used by `yc iam create-token --profile <name>`. */
  profile?: string
  /** Base URL of the OpenAI-compatible API. */
  baseURL?: string
  /** Provider id and display name inside OpenCode. */
  providerID?: string
  providerName?: string
  /** Yandex Cloud folder id; sent as `OpenAI-Project` header (required for user IAM tokens). */
  folderId?: string
  /** Path to the `yc` binary (default: `yc` from PATH). */
  ycBin?: string
  /**
   * Codex catalog endpoint (`GET /v1/models-codex`, folder via `x-folder-id`).
   * `null` disables remote listing; the `models` option is then used as-is.
   */
  codexModelsEndpoint?: string | null
  /**
   * Raw OpenAI-compatible listing endpoint (`GET /v1/models`, folder via
   * `OpenAI-Project`). Merged with the curated catalog: codex info wins for
   * models present in both, the rest is added from here (filtered by
   * `modelPrefixes`).
   */
  modelsEndpoint?: string | null
  /** How long a fetched model list stays valid. */
  modelsCacheMs?: number
  /** Filter for the raw OpenAI listing: only ids with one of these prefixes. */
  modelPrefixes?: string[]
  /** Subscription usage/rate-limit endpoint (`GET /api/codex/usage`). `null` disables quota tracking. */
  usageEndpoint?: string | null
  /** Model ids exposed by the provider on top of the catalog. */
  models?: (string | { id: string; name?: string; context?: number })[]
  /** Refresh tick; the token is refreshed only when close to expiry. */
  refreshIntervalMs?: number
  quietTimeoutMs?: number
  interactiveTimeoutMs?: number
  tokenTtlMs?: number
  safetyMs?: number
}

const DEFAULT_BASE_URL = "https://apps.ai.api.cloud.yandex.net/v1"
const DEFAULT_MODELS_CACHE_MS = 10 * 60 * 1000
/** In the raw OpenAI listing only `gpt://` ids are chat-capable. */
const DEFAULT_MODEL_PREFIXES = ["gpt://"]

/** `gpt://<folder>/<name>/latest` → `<name>`; plain ids pass through. */
function shortModelName(id: string): string {
  const stripped = id.replace(/^[a-z]+:\/\/[^/]+\//, "").replace(/\/latest$/, "")
  return stripped.length > 0 ? stripped : id
}

const STORAGE_KEY = "iam-token"

/**
 * folderId precedence: plugin option → `yc config get folder-id --profile`.
 * The OpenAI-compatible API requires it (OpenAI-Project header) for user IAM
 * tokens; warns when neither source provides one.
 */
async function resolveFolderId(o: Options, profile: string, ycBin: string): Promise<string | undefined> {
  if (o.folderId) return o.folderId
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        ycBin,
        ["config", "get", "folder-id", "--profile", profile],
        { timeout: 5_000, env: cleanYcEnv(process.env) },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      )
    })
    const folderId = out.trim()
    if (folderId) {
      console.log("yandex-ai-studio: folder-id taken from yc profile:", profile)
      return folderId
    }
  } catch {
    // Profiles without folder-id (pure federation auth) are normal.
  }
  console.warn(
    `yandex-ai-studio: folderId не задан (ни в опциях, ни в профиле yc «${profile}»). ` +
      "API вернёт ошибку без заголовка OpenAI-Project; укажите опцию folderId.",
  )
  return undefined
}

export default Plugin.define({
  id: "yandex-ai-studio",
  async setup(ctx) {
    const o = (ctx.options ?? {}) as Options
    const profile = o.profile ?? "default"
    const providerID = Provider.ID.make(o.providerID ?? "yandex-ai-studio")
    const baseURL = o.baseURL ?? DEFAULT_BASE_URL
    const refreshIntervalMs = o.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    const ycBin = o.ycBin ?? "yc"

    /** Explicit option wins; otherwise fall back to the yc profile's folder-id. */
    const folderId = await resolveFolderId(o, profile, ycBin)

    // ---- RPC contract: auth events for the TUI part ----
    const rpc = await ctx.rpc.register(YandexAuth, {
      status: async () => {
        const s = manager.status()
        const state: string = s.refreshing
          ? "refreshing"
          : s.expired
            ? s.expiresAt === undefined
              ? "missing"
              : "expired"
            : "valid"
        const out: { state: string; profile: string; expiresAt?: number } = { state, profile }
        if (s.expiresAt !== undefined) out.expiresAt = s.expiresAt
        return out
      },
    })

    // ---- token manager: single-flight refresh around `yc iam create-token` ----
    const manager = new TokenManager(
      {
        profile,
        ycBin,
        quietTimeoutMs: o.quietTimeoutMs,
        interactiveTimeoutMs: o.interactiveTimeoutMs,
        tokenTtlMs: o.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS,
        safetyMs: o.safetyMs ?? DEFAULT_SAFETY_MS,
      },
      {
        load: async () => (await ctx.storage.get(STORAGE_KEY)) as TokenState | undefined,
        save: async (state) => {
          await ctx.storage.set(STORAGE_KEY, state as unknown as Parameters<typeof ctx.storage.set>[1])
        },
        emit: async (event) => {
          try {
            // Public auth.waiting / auth.succeeded / auth.failed events.
            const name = event.type
            await rpc.events.emit(
              name as "auth.waiting" | "auth.succeeded" | "auth.failed",
              event as never,
            )
          } catch (err) {
            console.error("yandex-ai-studio: failed to emit auth event", err)
          }
        },
        log: (message, data) => {
          console.log("yandex-ai-studio:", message, data ?? {})
        },
      },
    )

    // ---- provider registration ----
    // The transform is replayed synchronously on every reload(); it must read
    // the *current* token from the manager, so after a successful refresh we
    // call ctx.provider.reload() to re-register with the fresh apiKey.
    const stored = (await ctx.storage.get(STORAGE_KEY)) as TokenState | undefined

    const codexModelsEndpoint =
      o.codexModelsEndpoint === null
        ? undefined
        : o.codexModelsEndpoint ?? `${baseURL.replace(/\/+$/, "")}/models-codex`
    const modelsEndpoint =
      o.modelsEndpoint === null
        ? undefined
        : o.modelsEndpoint ?? `${baseURL.replace(/\/+$/, "")}/models`
    const modelPrefixes = o.modelPrefixes ?? DEFAULT_MODEL_PREFIXES
    const modelsCacheMs = o.modelsCacheMs ?? DEFAULT_MODELS_CACHE_MS

    // ---- usage/rate limits (codex /api/codex/usage) ----
    const usageEndpoint =
      o.usageEndpoint === null
        ? undefined
        : o.usageEndpoint ?? `${baseURL.replace(/\/+$/, "")}/api/codex/usage`
    const usageCacheMs = 60_000
    const usage = { snapshot: undefined as CodexUsage | undefined, checkedAt: 0, inflight: undefined as Promise<void> | undefined }
    const refreshUsage = (force = false) => {
      if (usageEndpoint === undefined) return Promise.resolve()
      if (!force && Date.now() - usage.checkedAt < usageCacheMs) return Promise.resolve()
      usage.inflight ??= (async () => {
        try {
          const token = manager.peek() ?? stored?.token
          if (!token) return
          const snapshot = await fetchCodexUsage(usageEndpoint, token, { folderId })
          usage.snapshot = snapshot
          usage.checkedAt = Date.now()
          await rpc.events.emit("usage.updated", snapshot as never).catch(() => {})
        } catch (err) {
          // Usage is advisory only; never surface it as an error.
          console.warn("yandex-ai-studio: usage fetch failed:", (err as Error).message)
        } finally {
          usage.inflight = undefined
        }
      })()
      return usage.inflight
    }

    /** Configured specs take precedence over remotely discovered ids. */
    const configured = (o.models ?? []).map((spec) => {
      const entry = typeof spec === "string" ? { id: spec } : spec
      const model = {
        ...Model.Info.default(providerID, Model.ID.make(entry.id)),
        name: entry.name ?? entry.id,
      }
      if (entry.context) model.limit.context = entry.context
      return model
    })

    // Remote inventory: the curated Codex catalog (`/v1/models-codex`),
    // fetched with the IAM token, cached, single-flight, keeps the last good list.
    const inventory = { models: [] as typeof configured, checkedAt: 0 }
    const allCodex = (pages: readonly CodexCatalogModel[]) => pages.filter((m) => m.visible && m.supportedInApi)
    let inventoryInflight: Promise<void> | undefined
    const refreshModels = () => {
      if (codexModelsEndpoint === undefined && modelsEndpoint === undefined) return Promise.resolve()
      inventoryInflight ??= (async () => {
        let token = manager.peek() ?? stored?.token
        if (!token) return
        // TS: a local copy keeps the non-undefined narrowing inside closures.
        let currentToken = token
        try {
          // 401/403 from YC usually means the cached IAM token is stale even
          // if our TTL math still considers it valid (restored from storage
          // after the real token already expired). Self-heal: force a fresh
          // `yc iam create-token` and retry both listings once.
          const fetchAll = async () => {
            let codex: readonly CodexCatalogModel[] = []
            if (codexModelsEndpoint !== undefined) {
              codex = await fetchCodexModels(codexModelsEndpoint, currentToken, { folderId })
            }
            let remote: readonly { id: string }[] = []
            if (modelsEndpoint !== undefined) {
              remote = await fetchModels(modelsEndpoint, currentToken, { folderId })
            }
            return { codex, remote }
          }
          let fetched: Awaited<ReturnType<typeof fetchAll>>
          try {
            fetched = await fetchAll()
          } catch (err) {
            if (!/HTTP 40[13]/.test((err as Error).message)) throw err
            token = (await manager.force()).token
            currentToken = token
            fetched = await fetchAll()
          }
          const { codex, remote } = fetched

          // Merge: curated codex info wins; raw-listing models not in the
          // catalog are appended (filtered to chat-capable `gpt://` ids).
          const exactIds = new Map<string, string>()
          for (const m of remote) {
            exactIds.set(shortModelName(m.id), m.id)
          }
          const curated = allCodex(codex)
          const covered = new Set(curated.map((m) => m.slug))
          const catalogModels = curated.map((m) => {
            const id = exactIds.get(m.slug) ?? m.id
            const model = {
              ...Model.Info.default(providerID, Model.ID.make(id)),
              // Pretty display name from the catalog (already curated).
              name: m.name,
            }
            if (m.context) model.limit.context = m.context
            model.capabilities.input = m.vision ? ["text", "image"] : ["text"]
            return model
          })
          const extraModels = remote
            .filter((m) => exactIds.get(shortModelName(m.id)) === m.id) // dedup by slug
            .filter((m) => modelPrefixes.some((p) => m.id.startsWith(p)))
            .filter((m) => !covered.has(shortModelName(m.id)))
            .map((m) => ({
              ...Model.Info.default(providerID, Model.ID.make(m.id)),
              // gpt://<folder>/<name>/latest → <name>
              name: shortModelName(m.id),
            }))

          const seen = new Set(configured.map((m) => String(m.id)))
          if (catalogModels.length + extraModels.length > 0) {
            inventory.models = [...catalogModels, ...extraModels].filter((m) => !seen.has(String(m.id)))
            inventory.checkedAt = Date.now()
          }
        } catch (err) {
          // Keep the last successful inventory through transient outages.
          console.error("yandex-ai-studio: model catalog failed:", (err as Error).message)
        } finally {
          inventoryInflight = undefined
        }
      })()
      return inventoryInflight
    }

    await ctx.provider.transform((editor) => {
      const token = manager.peek() ?? stored?.token ?? "PENDING-YC-LOGIN"
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: o.providerName ?? "Yandex AI Studio",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL,
            // IAM token goes as `Authorization: Bearer <token>` (apiKey → bearer
            // in the openai-compatible package).
            apiKey: token,
            ...(folderId ? { headers: { "OpenAI-Project": folderId } } : {}),
          },
        },
        models: [...configured, ...inventory.models],
      })
    })

    // ---- start refresh flow in the background; never block setup() ----
    if (codexModelsEndpoint === undefined && modelsEndpoint === undefined && configured.length === 0) {
      console.warn(
        "yandex-ai-studio: оба листинга отключены (codexModelsEndpoint=null, modelsEndpoint=null), а опция models пуста — провайдер будет без моделей",
      )
    }
    const kickRefresh = () =>
      manager
        .ensure()
        .then(async () => {
          if (
            (codexModelsEndpoint !== undefined || modelsEndpoint !== undefined) &&
            Date.now() - inventory.checkedAt > modelsCacheMs
          ) {
            await refreshModels()
          }
          void refreshUsage()
          await ctx.provider.reload()
        })
        .catch((err: Error) => {
          console.error("yandex-ai-studio: token refresh failed:", err.message)
        })
    void kickRefresh()

    // ---- periodic check: refresh ahead of expiry, and stale model inventory ----
    const timer = setInterval(
      () => {
        if (manager.status().refreshing) return
        if (!manager.isValid() || Date.now() - inventory.checkedAt > modelsCacheMs) void kickRefresh()
      },
      refreshIntervalMs,
    )

    // ---- 401 rescue + 429 rate-limit backoff ----
    const retryHook = await ctx.session.hook("retry", async (event) => {
      if (event.model.providerID !== providerID) return
      const message = event.error.message ?? ""
      const is401 = event.error.status === 401 || /401|unauthorized/i.test(message)
      const is429 = event.error.status === 429 || /429|rate.?limit/i.test(message)
      if (!is401 && !is429) return
      if (is429) {
        // Ask the usage endpoint when the window resets and sleep until then
        // (capped) instead of a blind exponential backoff.
        void refreshUsage(true)
        const snapshot = usage.snapshot
        const resetIn = snapshot?.resetAfterSeconds ?? 60
        const delay = Math.min(resetIn + 5, 15 * 60) * 1000
        console.warn(
          `yandex-ai-studio: rate limit reached (primary ${snapshot?.primaryPercent}%, weekly ${snapshot?.secondaryPercent}%); retry in ${Math.round(delay / 1000)}s`,
        )
        event.decision = { retry: true, delay }
        return
      }
      if (event.attempt >= 3) {
        event.decision = { retry: false }
        return
      }
      const s = manager.status()
      if (!s.refreshing && manager.isValid()) {
        // Token already fresh again (a previous retry beat us to it).
        event.decision = { retry: true, delay: 500 }
        return
      }
      try {
        // Joins the in-flight refresh (may be the 5-minute interactive flow).
        await manager.ensure()
        await ctx.provider.reload()
        event.decision = { retry: true, delay: 500 }
      } catch (err) {
        event.decision = { retry: false }
        console.error("yandex-ai-studio: refresh during retry failed:", (err as Error).message)
      }
    })

    // ---- /yc-usage command: subscription quota snapshot ----
    const fmtReset = (resetAt?: number) => {
      if (!resetAt) return ""
      const seconds = Math.max(0, Math.round((resetAt - Date.now()) / 1000))
      const d = Math.floor(seconds / 86400)
      const h = Math.floor((seconds % 86400) / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      const rel =
        d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${m} мин`
      return `, сброс через ${rel}`
    }
    const fmtWindow = (label: string, percent: number, resetAt?: number) => `${label}: ${percent}%${fmtReset(resetAt)}`
    await ctx.command.transform((editor) => {
      editor.add({
        name: "yc-usage",
        description: "Show Yandex AI Studio subscription usage and rate limits",
        execute: async ({ sessionID }) => {
          let text: string
          try {
            await refreshUsage(true)
            const u = usage.snapshot
            if (!u) {
              text = "❌ Yandex AI Studio: не удалось получить данные о квотах"
            } else {
              const warn = u.limitReached ? "⚠️ Лимит исчерпан!\n" : ""
              text =
                `📊 Yandex AI Studio (план ${u.planType})\n` +
                warn +
                fmtWindow("Окно 5ч", u.primaryPercent, u.primaryResetAt) +
                "\n" +
                fmtWindow("Окно 7д", u.secondaryPercent, u.secondaryResetAt)
            }
          } catch (err) {
            text = `❌ Yandex AI Studio: ${(err as Error).message}`
          }
          await ctx.session.synthetic({ sessionID, text })
        },
      })
    })

    // ---- /yc-auth command: manual forced refresh ----
    await ctx.command.transform((editor) => {
      editor.add({
        name: "yc-auth",
        description: "Refresh the Yandex Cloud IAM token (yc iam create-token)",
        execute: async ({ sessionID }) => {
          let text: string
          try {
            const state = await manager.force()
            await ctx.provider.reload()
            text = `✅ Yandex AI Studio: IAM-токен обновлён, действует до ${new Date(state.expiresAt).toLocaleString()}`
          } catch (err) {
            text = `❌ Yandex AI Studio: не удалось обновить IAM-токен: ${(err as Error).message}`
          }
          await ctx.session.synthetic({ sessionID, text })
        },
      })
    })

    return () => {
      clearInterval(timer)
      void retryHook.dispose()
    }
  },
})
