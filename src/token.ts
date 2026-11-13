import { spawn } from "node:child_process"

/**
 * `yc` prioritizes credential env vars (`YC_API_KEY`, `YC_TOKEN`, …) over the
 * profile config. OpenCode servers often inherit such vars (e.g. the API key
 * configured for another provider), which silently switches `iam create-token`
 * to a service-account token. Strip credential vars so the token always comes
 * from the requested `--profile`.
 */
export function cleanYcEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: Record<string, string | undefined> = { ...env }
  for (const key of ["YC_API_KEY", "YC_TOKEN", "YC_IAM_TOKEN", "YC_SERVICE_ACCOUNT_KEY_FILE", "YC_SERVICE_ACCOUNT_KEY"]) {
    delete out[key]
  }
  return out as NodeJS.ProcessEnv
}

export interface TokenState {
  readonly token: string
  readonly expiresAt: number
}

export type TokenEvent =
  | { type: "auth.waiting"; profile: string; timeoutMs: number }
  | { type: "auth.succeeded"; profile: string; expiresAt: number }
  | { type: "auth.failed"; profile: string; reason: string; timedOut: boolean }

/** `yc` was killed because it did not produce a token in time. */
export class YcTimeoutError extends Error {
  constructor(
    message: string,
    /** true when the browser re-auth flow was detected before the timeout */
    readonly interactive: boolean,
  ) {
    super(message)
    this.name = "YcTimeoutError"
  }
}

/** `yc` exited with a non-zero code or empty stdout. */
export class YcExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = "YcExitError"
  }
}

/** Never log a raw IAM token; use this instead. */
export function redact(token: string): string {
  return `${token.slice(0, 6)}…(${token.length})`
}

/** stderr fragments that mean `yc` opened a browser and is waiting for login. */
const INTERACTIVE_MARKER = /web site will be opened|you are going to be authenticated/i
export const DEFAULT_QUIET_TIMEOUT_MS = 10_000
export const DEFAULT_INTERACTIVE_TIMEOUT_MS = 300_000 // 5 minutes
export const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000 // IAM tokens live 12h
export const DEFAULT_SAFETY_MS = 60 * 60 * 1000 // refresh 1h before expiry
export const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000

export interface TokenManagerOptions {
  readonly profile: string
  readonly ycBin?: string
  readonly quietTimeoutMs?: number
  readonly interactiveTimeoutMs?: number
  readonly tokenTtlMs?: number
  readonly safetyMs?: number
}

export interface TokenManagerHost {
  /** Load the persisted token state, if any. */
  load(): Promise<TokenState | undefined>
  /** Persist the token state (plugin-scoped storage). */
  save(state: TokenState): Promise<void>
  /** Emit a lifecycle event (RPC events, logs, ...). */
  emit(event: TokenEvent): Promise<void> | void
  /** Structured log sink; never pass the raw token here. */
  log(message: string, data?: Record<string, unknown>): void
}

export class TokenManager {
  private readonly profile: string
  private readonly ycBin: string
  private readonly quietTimeoutMs: number
  private readonly interactiveTimeoutMs: number
  private readonly tokenTtlMs: number
  private readonly safetyMs: number
  private readonly host: TokenManagerHost

  private state: TokenState | undefined
  private inflight: Promise<TokenState> | undefined
  private ignoreStorage = false
  private lastError: Error | undefined

  constructor(options: TokenManagerOptions, host: TokenManagerHost) {
    this.profile = options.profile
    this.ycBin = options.ycBin ?? "yc"
    this.quietTimeoutMs = options.quietTimeoutMs ?? DEFAULT_QUIET_TIMEOUT_MS
    this.interactiveTimeoutMs = options.interactiveTimeoutMs ?? DEFAULT_INTERACTIVE_TIMEOUT_MS
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
    this.safetyMs = options.safetyMs ?? DEFAULT_SAFETY_MS
    this.host = host
  }

  /** True when the cached token is fresh enough to use. */
  isValid(state = this.state, now = Date.now()): boolean {
    return state !== undefined && now < state.expiresAt - this.safetyMs
  }

  /** True when the token is fully expired (requests will 401). */
  isExpired(now = Date.now()): boolean {
    return this.state === undefined || now >= this.state.expiresAt
  }

  /** Current token, without refreshing. Undefined when there is none. */
  peek(): string | undefined {
    return this.state?.token
  }

  /**
   * Return a usable token. Single-flight: concurrent callers join the same
   * in-flight refresh instead of spawning competing `yc` processes (and
   * competing browser tabs).
   */
  async ensure(): Promise<TokenState> {
    if (this.isValid()) return this.state!
    this.inflight ??= this.doEnsure().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Force a refresh even when the cache is still valid. */
  async force(): Promise<TokenState> {
    this.state = undefined
    // The stored token may be the stale one we are rejecting right now:
    // skip the storage fallback once so ensure() really calls `yc`.
    this.ignoreStorage = true
    return this.ensure()
  }

  /** Is a refresh currently running (and is it the interactive browser flow)? */
  status(): { refreshing: boolean; expired: boolean; expiresAt?: number } {
    return {
      refreshing: this.inflight !== undefined,
      expired: this.isExpired(),
      expiresAt: this.state?.expiresAt,
    }
  }

  private async doEnsure(): Promise<TokenState> {
    const skipStorage = this.ignoreStorage
    this.ignoreStorage = false
    if (this.state !== undefined) {
      if (this.isValid(this.state)) return this.state
    } else if (!skipStorage) {
      const stored = await this.host.load()
      if (stored && stored.token) {
        this.state = stored
        if (this.isValid(stored)) {
          this.host.log("token loaded from storage", { expiresAt: stored.expiresAt })
          return stored
        }
        this.state = undefined
        // Stored token is close to expiry: fall through to a fresh `yc` call
        // (it is cheap and silent while the yc session is alive).
      }
    }

    const token = await this.runYc()
    this.state = { token, expiresAt: Date.now() + this.tokenTtlMs }
    await this.host.save(this.state)
    this.lastError = undefined
    this.host.log("token refreshed", { expiresAt: this.state.expiresAt })
    await this.host.emit({ type: "auth.succeeded", profile: this.profile, expiresAt: this.state.expiresAt })
    return this.state
  }

  /**
   * Run `yc iam create-token --profile <profile>` and return the raw token.
   *
   * Two modes, distinguished by stderr markers:
   * - quiet: cached federation session, answers in ~1s; killed after quietTimeoutMs.
   * - interactive: `yc` opened a browser and blocks until login; we emit
   *   `auth.waiting` immediately and allow up to interactiveTimeoutMs.
   */
  private async runYc(): Promise<string> {
    const quietMs = this.quietTimeoutMs
    const child = spawn(this.ycBin, ["iam", "create-token", "--profile", this.profile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanYcEnv(process.env),
    })

    let stdout = ""
    let stderr = ""
    let interactive = false
    let killed = false
    let timer: ReturnType<typeof setTimeout> = setTimeout(kill, quietMs)

    function kill() {
      killed = true
      child.kill()
    }
    const extendToInteractive = () => {
      clearTimeout(timer)
      timer = setTimeout(kill, this.interactiveTimeoutMs)
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
      if (!interactive && INTERACTIVE_MARKER.test(stderr)) {
        interactive = true
        this.host.log("interactive re-auth: browser opened, waiting for login", {
          timeoutMs: this.interactiveTimeoutMs,
        })
        void this.host.emit({
          type: "auth.waiting",
          profile: this.profile,
          timeoutMs: this.interactiveTimeoutMs,
        })
        extendToInteractive()
      }
    })

    const code: number | null = await new Promise((resolve) => {
      child.on("error", (err) => {
        clearTimeout(timer)
        this.lastError = err
        resolve(-1)
        stderr += String(err)
      })
      child.on("close", (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })

    if (killed) {
      const reason = interactive
        ? `Yandex AI Studio: вход в браузере не был завершён за ${Math.round(this.interactiveTimeoutMs / 1000)} с. ` +
          `Выполните вход и повторите (команда /yc-auth или заново opencode). ` +
          `Проверить вручную: ${this.ycBin} iam create-token --profile ${this.profile}`
        : `Yandex AI Studio: ${this.ycBin} iam create-token не ответил за ${Math.round(quietMs / 1000)} с (quiet-режим). ` +
          `Проверьте установку yc и сеть: ${this.ycBin} iam create-token --profile ${this.profile}`
      this.lastError = new YcTimeoutError(reason, interactive)
      this.host.emit({
        type: "auth.failed",
        profile: this.profile,
        reason,
        timedOut: true,
      })
      throw this.lastError
    }

    const token = stdout.trim()
    if (code !== 0 || !token) {
      const reason =
        `Yandex AI Studio: ${this.ycBin} iam create-token --profile ${this.profile} ` +
        `завершился с кодом ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`
      this.lastError = new YcExitError(reason, code, stderr)
      this.host.emit({ type: "auth.failed", profile: this.profile, reason, timedOut: false })
      throw this.lastError
    }

    this.host.log("yc returned a token", { token: redact(token), interactive })
    return token
  }
}
