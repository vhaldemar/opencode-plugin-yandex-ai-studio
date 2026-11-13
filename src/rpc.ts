import { Rpc } from "@opencode/plugin/rpc"

/**
 * Single source of truth for the "quota almost exhausted" threshold, shared
 * by the server (toasts logic in the usage command text) and the TUI part
 * (toast + footer color). Must stay in sync with nothing else.
 */
export const QUOTA_WARN_PERCENT = 80

/**
 * RPC contract of the Yandex AI Studio plugin.
 *
 * The server part emits these events during IAM token lifecycle; the TUI part
 * (and any external client) subscribes to them to surface auth state.
 */
export const YandexAuth = Rpc.define({
  id: "yandex-ai-studio",
  methods: {
    status: {
      // No input, output is the current token state (never the token itself).
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["valid", "refreshing", "interactive", "expired", "missing", "failed"] },
          expiresAt: { type: "number" },
          /** Undefined when the plugin runs without the `profile` option. */
          profile: { type: "string" },
        },
        required: ["state"],
        additionalProperties: false,
      },
    },
    usage: {
      // Current subscription usage snapshot (or null before the first fetch).
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: ["object", "null"],
        properties: {
          planType: { type: "string" },
          primaryPercent: { type: "number" },
          secondaryPercent: { type: "number" },
          primaryResetAt: { type: "number" },
          secondaryResetAt: { type: "number" },
          limitReached: { type: "boolean" },
          resetAfterSeconds: { type: "number" },
        },
        required: ["planType", "primaryPercent", "secondaryPercent", "limitReached"],
        additionalProperties: false,
      },
    },
  },
  events: {
    /**
     * Subscription usage/rate limits refreshed (from /v1/api/codex/usage).
     * Percentages are per window: primary = the rolling short window,
     * secondary = the weekly window.
     */
    "usage.updated": {
      schema: {
        type: "object",
        properties: {
          planType: { type: "string" },
          primaryPercent: { type: "number" },
          secondaryPercent: { type: "number" },
          /** Unix ms when the primary window resets (absent = unknown). */
          primaryResetAt: { type: "number" },
          secondaryResetAt: { type: "number" },
          limitReached: { type: "boolean" },
          /** Seconds until the exhausted window resets (absent = unknown). */
          resetAfterSeconds: { type: "number" },
        },
        required: ["planType", "primaryPercent", "secondaryPercent", "limitReached"],
        additionalProperties: false,
      },
    },
    /**
     * Human-readable report requested via /yc-usage (or /yc-auth): shown by
     * the TUI part as a toast. Unlike a synthetic session message, this never
     * reaches the model — the agent is not asked to respond to it.
     */
    "usage.report": {
      schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          variant: { type: "string", enum: ["info", "success", "warning", "error"] },
        },
        required: ["text", "variant"],
        additionalProperties: false,
      },
    },
    /**
     * `yc` opened a browser for re-authorization and is blocking until
     * the user completes login (up to `timeoutMs`).
     */
    "auth.waiting": {
      schema: {
        type: "object",
        properties: {
          /** Undefined when the plugin runs without the `profile` option. */
          profile: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["timeoutMs"],
        additionalProperties: false,
      },
    },
    "auth.succeeded": {
      schema: {
        type: "object",
        properties: {
          /** Undefined when the plugin runs without the `profile` option. */
          profile: { type: "string" },
          expiresAt: { type: "number" },
        },
        required: ["expiresAt"],
        additionalProperties: false,
      },
    },
    "auth.failed": {
      schema: {
        type: "object",
        properties: {
          /** Undefined when the plugin runs without the `profile` option. */
          profile: { type: "string" },
          reason: { type: "string" },
          timedOut: { type: "boolean" },
        },
        required: ["reason", "timedOut"],
        additionalProperties: false,
      },
    },
  },
})
