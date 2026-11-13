import { Model, Plugin, Provider } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { fetchCodexModels, type CodexCatalogModel } from "./models.js"
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
  /** How long a fetched model list stays valid. */
  modelsCacheMs?: number
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
    const modelsCacheMs = o.modelsCacheMs ?? DEFAULT_MODELS_CACHE_MS

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
      if (codexModelsEndpoint === undefined) return Promise.resolve()
      inventoryInflight ??= (async () => {
        let token = manager.peek() ?? stored?.token
        if (!token) return
        try {
          // 401/403 from YC usually means the cached IAM token is stale even
          // if our TTL math still considers it valid (restored from storage
          // after the real token already expired). Self-heal: force a fresh
          // `yc iam create-token` and retry the catalog once.
          let codex: readonly CodexCatalogModel[]
          try {
            codex = await fetchCodexModels(codexModelsEndpoint, token, { folderId })
          } catch (err) {
            if (!/HTTP 40[13]/.test((err as Error).message)) throw err
            token = (await manager.force()).token
            codex = await fetchCodexModels(codexModelsEndpoint, token, { folderId })
          }

          const seen = new Set(configured.map((m) => String(m.id)))
          if (codex.length > 0) {
            inventory.models = allCodex(codex)
              .filter((m) => !seen.has(m.id))
              .map((m) => {
                const model = {
                  ...Model.Info.default(providerID, Model.ID.make(m.id)),
                  // Pretty display name from the catalog (already curated).
                  name: m.name,
                }
                if (m.context) model.limit.context = m.context
                model.capabilities.input = m.vision ? ["text", "image"] : ["text"]
                return model
              })
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
    if (codexModelsEndpoint === undefined && configured.length === 0) {
      console.warn(
        "yandex-ai-studio: каталог моделей отключен (codexModelsEndpoint=null), а опция models пуста — провайдер будет без моделей",
      )
    }
    const kickRefresh = () =>
      manager
        .ensure()
        .then(async () => {
          if (codexModelsEndpoint !== undefined && Date.now() - inventory.checkedAt > modelsCacheMs) {
            await refreshModels()
          }
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

    // ---- 401 rescue: join the in-flight refresh, then retry once reloaded ----
    const retryHook = await ctx.session.hook("retry", async (event) => {
      if (event.model.providerID !== providerID) return
      const is401 =
        event.error.status === 401 || /401|unauthorized/i.test(event.error.message ?? "")
      if (!is401) return
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
