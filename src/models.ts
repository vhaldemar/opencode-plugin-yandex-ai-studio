/**
 * Normalized model entry from the Codex catalog
 * (`GET {baseURL}/models-codex`, folder via `x-folder-id` header).
 */
export interface CodexCatalogModel {
  /** Full modelID, constructed as `gpt://<folder>/<slug>/latest`. */
  readonly id: string
  readonly slug: string
  /** Human-readable name (`display_name`), falls back to the slug. */
  readonly name: string
  /** Context window in tokens, when reported. */
  readonly context?: number
  /** The model accepts image input. */
  readonly vision: boolean
  /** `visibility == "list"` — should appear in pickers. */
  readonly visible: boolean
  /** The model can be called via the API (in chat requests). */
  readonly supportedInApi: boolean
}

export interface RemoteModel {
  readonly id: string
}

/**
 * Subscription usage/rate limits from the Codex endpoint
 * (`GET {baseURL}/api/codex/usage`, folder via `x-folder-id`).
 */
export interface CodexUsage {
  readonly planType: string
  readonly primaryPercent: number
  readonly secondaryPercent: number
  readonly primaryResetAt?: number
  readonly secondaryResetAt?: number
  /** True when a rate limit window is exhausted (requests will 429). */
  readonly limitReached: boolean
  /** Seconds until the exhausted window resets; for the retry backoff. */
  readonly resetAfterSeconds?: number
}

/**
 * Fetch the subscription usage snapshot. Used for quota display and to
 * schedule a smart retry after a 429.
 */
export async function fetchCodexUsage(
  endpoint: string,
  token: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; folderId?: string } = {},
): Promise<CodexUsage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000)
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener("abort", onAbort)
  try {
    const res = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(opts.folderId ? { "x-folder-id": opts.folderId } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>")
      throw new Error(`${endpoint} → HTTP ${res.status}: ${body.slice(0, 300)} (token=${token.slice(0, 6)}…)`)
    }
    interface Window {
      used_percent?: number
      reset_after_seconds?: number
      reset_at?: number
    }
    interface Raw {
      plan_type?: string
      rate_limit?: {
        allowed?: boolean
        limit_reached?: boolean
        primary_window?: Window
        secondary_window?: Window
      }
    }
    const body = (await res.json()) as Raw
    const rate = body.rate_limit
    const pct = (w?: Window) => (typeof w?.used_percent === "number" ? Math.max(0, Math.min(100, w.used_percent)) : 0)
    const limitReached = rate?.limit_reached === true || rate?.allowed === false
    // Prefer the window that is exhausted; otherwise the stricter (larger) one.
    const resetSource =
      rate?.primary_window?.reset_after_seconds && rate?.primary_window.used_percent === 100
        ? rate.primary_window
        : rate?.secondary_window
    return {
      planType: body.plan_type ?? "unknown",
      primaryPercent: pct(rate?.primary_window),
      secondaryPercent: pct(rate?.secondary_window),
      primaryResetAt:
        typeof rate?.primary_window?.reset_at === "number" ? rate.primary_window.reset_at * 1000 : undefined,
      secondaryResetAt:
        typeof rate?.secondary_window?.reset_at === "number" ? rate.secondary_window.reset_at * 1000 : undefined,
      limitReached,
      resetAfterSeconds:
        typeof resetSource?.reset_after_seconds === "number" ? resetSource.reset_after_seconds : undefined,
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Fetch the curated model catalog from the Codex-compatible endpoint
 * (`GET {endpoint}` with `Authorization: Bearer <token>` and `x-folder-id`).
 * Response shape: `{ models: [{ slug, display_name, ... }] }`.
 * The endpoint lists only chat-capable models and carries rich metadata
 * (context window, input modalities). It returns slugs, not full modelID
 * URIs, so the `gpt://<folder>/<slug>/latest` id is constructed here.
 */
export async function fetchCodexModels(
  endpoint: string,
  token: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; folderId?: string } = {},
): Promise<readonly CodexCatalogModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000)
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener("abort", onAbort)
  try {
    const res = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        // The Codex endpoint takes the folder from this header (not OpenAI-Project).
        ...(opts.folderId ? { "x-folder-id": opts.folderId } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>")
      // Never log the raw token: only its redacted prefix goes into the error.
      throw new Error(`${endpoint} → HTTP ${res.status}: ${body.slice(0, 300)} (token=${token.slice(0, 6)}…)`)
    }
    interface Raw {
      slug?: string
      display_name?: string
      context_window?: number
      input_modalities?: string[]
      visibility?: string
      supported_in_api?: boolean
    }
    const body = (await res.json()) as { models?: Raw[] }
    return (body.models ?? [])
      .filter((m) => (m.slug ?? "").length > 0)
      .map((m) => ({
        // The endpoint exposes only the slug; the modelID URI format is
        // gpt://<folder>/<slug>/latest (matches the plain listing ids).
        id: `gpt://${opts.folderId}/${m.slug}/latest`,
        slug: String(m.slug),
        name: m.display_name ?? String(m.slug),
        context: typeof m.context_window === "number" && m.context_window > 0 ? m.context_window : undefined,
        vision: (m.input_modalities ?? []).includes("image"),
        visible: m.visibility !== "hidden",
        supportedInApi: m.supported_in_api !== false,
      }))
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Fetch the raw model list from the OpenAI-compatible endpoint
 * (`GET {endpoint}` with `Authorization: Bearer <token>`; the folder goes in
 * the `OpenAI-Project` header there, unlike the Codex catalog's `x-folder-id`).
 * Response shape: `{ data: [{ id, ... }] }`; ids are full modelID URIs
 * (`gpt://<folder>/<name>/latest`).
 */
export async function fetchModels(
  endpoint: string,
  token: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; folderId?: string } = {},
): Promise<readonly RemoteModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000)
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener("abort", onAbort)
  try {
    const res = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(opts.folderId ? { "openai-project": opts.folderId } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>")
      // Never log the raw token: only its redacted prefix goes into the error.
      throw new Error(`${endpoint} → HTTP ${res.status}: ${body.slice(0, 300)} (token=${token.slice(0, 6)}…)`)
    }
    const body = (await res.json()) as { data?: { id?: string }[] }
    return (body.data ?? [])
      .map((m) => ({ id: String(m.id) }))
      .filter((m) => m.id.length > 0)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }
}
