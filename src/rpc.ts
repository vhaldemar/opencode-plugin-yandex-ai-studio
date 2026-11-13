import { Rpc } from "@opencode/plugin/rpc"

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
          profile: { type: "string" },
        },
        required: ["state", "profile"],
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
        },
        required: ["planType", "primaryPercent", "secondaryPercent", "limitReached"],
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
          profile: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["profile", "timeoutMs"],
        additionalProperties: false,
      },
    },
    "auth.succeeded": {
      schema: {
        type: "object",
        properties: {
          profile: { type: "string" },
          expiresAt: { type: "number" },
        },
        required: ["profile", "expiresAt"],
        additionalProperties: false,
      },
    },
    "auth.failed": {
      schema: {
        type: "object",
        properties: {
          profile: { type: "string" },
          reason: { type: "string" },
          timedOut: { type: "boolean" },
        },
        required: ["profile", "reason", "timedOut"],
        additionalProperties: false,
      },
    },
  },
})
