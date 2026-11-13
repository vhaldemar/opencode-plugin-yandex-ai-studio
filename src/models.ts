export interface RemoteModel {
  readonly id: string
  readonly owned_by?: string
}

/**
 * Fetch the model list from the OpenAI-compatible endpoint
 * (`GET {endpoint}` with `Authorization: Bearer <token>`).
 * Response shape: `{ data: [{ id, ... }] }`.
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
    if (!res.ok) throw new Error(`${endpoint} → HTTP ${res.status}`)
    const body = (await res.json()) as { data?: { id?: string; owned_by?: string }[] }
    return (body.data ?? [])
      .map((m) => ({ id: String(m.id), owned_by: m.owned_by }))
      .filter((m) => m.id.length > 0)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }
}
