import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { QUOTA_WARN_PERCENT, YandexAuth } from "./rpc.js"

/**
 * TUI part: surfaces the plugin auth lifecycle and subscription usage.
 *
 * - OS notification when `yc` opens the browser (you might be in another window)
 * - toast on waiting / success / failure / rate limit
 * - persistent footer indicator: YC[AUTH…] while logging in, YC[p%/w%] otherwise
 */
export default Plugin.define({
  id: "yandex-ai-studio.tui",
  setup(context) {
    const auth = context.client.rpc(YandexAuth)
    const [waiting, setWaiting] = createSignal(false)
    const [usage, setUsage] = createSignal<{ primaryPercent: number; secondaryPercent: number } | undefined>()

    const notify = (title: string, message: string) =>
      void context.attention
        .notify({ title, message, notification: { when: "always" } })
        .catch(() => {})

    const stop = auth.events.on("auth.waiting", (event) => {
      const data = event.data as { profile: string; timeoutMs: number }
      const minutes = Math.round(data.timeoutMs / 60_000)
      setWaiting(true)
      context.ui.toast.show({
        title: "Yandex AI Studio",
        message: `Требуется вход в Yandex Cloud (профиль «${data.profile}»): откройте браузер и авторизуйтесь. Ждём до ${minutes} мин.`,
        variant: "warning",
      })
      notify("OpenCode ждёт входа в Yandex Cloud", "yc открыл браузер для авторизации")
    })

    const stopSucceeded = auth.events.on("auth.succeeded", (event) => {
      const data = event.data as { expiresAt: number }
      setWaiting(false)
      context.ui.toast.show({
        title: "Yandex AI Studio",
        message: `IAM-токен обновлён (до ${new Date(data.expiresAt).toLocaleTimeString()})`,
        variant: "success",
        duration: 3000,
      })
    })

    const stopFailed = auth.events.on("auth.failed", (event) => {
      const data = event.data as { reason: string; timedOut: boolean }
      setWaiting(false)
      context.ui.toast.show({
        title: "Yandex AI Studio",
        message: data.reason,
        variant: "error",
      })
      if (data.timedOut) {
        notify("Не удалось обновить YC-токен", "Вход в браузере не был завершён вовремя")
      }
    })

    const stopUsage = auth.events.on("usage.updated", (event) => {
      const data = event.data as {
        planType: string
        primaryPercent: number
        secondaryPercent: number
        limitReached: boolean
        primaryResetAt?: number
      }
      setUsage({ primaryPercent: data.primaryPercent, secondaryPercent: data.secondaryPercent })
      if (data.limitReached) {
        context.ui.toast.show({
          title: "Yandex AI Studio",
          message: `Лимит подписки исчерпан (${data.primaryPercent}% окна 5ч / ${data.secondaryPercent}% недели)`,
          variant: "error",
        })
      } else if (data.primaryPercent >= QUOTA_WARN_PERCENT) {
        context.ui.toast.show({
          title: "Yandex AI Studio",
          message: `Квота почти исчерпана: ${data.primaryPercent}% окна 5ч`,
          variant: "warning",
        })
      }
    })

    // /yc-usage and /yc-auth results: a toast, not a synthetic session message,
    // so the report never becomes a prompt the agent answers to.
    const stopReport = auth.events.on("usage.report", (event) => {
      const data = event.data as { text: string; variant: "info" | "success" | "warning" | "error" }
      context.ui.toast.show({
        title: "Yandex AI Studio",
        message: data.text,
        variant: data.variant,
        duration: 10_000,
      })
    })

    // Persistent status in the footer: waiting for the browser login, or the
    // usage snapshot once known (primary window % / weekly window %).
    // Two claims: the home screen footer and the in-session prompt footer.
    const renderStatus = () => {
      if (waiting()) return <text fg="yellow">YC[AUTH…]</text>
      const u = usage()
      if (!u) return null
      const fg = u.primaryPercent >= QUOTA_WARN_PERCENT || u.secondaryPercent >= QUOTA_WARN_PERCENT ? "red" : "green"
      return (
        <text fg={fg}>
          YC[{u.primaryPercent}%/{u.secondaryPercent}%]
        </text>
      )
    }
    context.ui.slot({ append: "home.footer.status", render: renderStatus })
    context.ui.slot({ append: "prompt.footer.status", render: renderStatus })

    return () => {
      stop()
      stopSucceeded()
      stopFailed()
      stopUsage()
      stopReport()
      setWaiting(false)
    }
  },
})
