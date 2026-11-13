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
