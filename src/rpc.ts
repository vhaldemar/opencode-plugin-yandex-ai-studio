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
  },
  events: {
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
