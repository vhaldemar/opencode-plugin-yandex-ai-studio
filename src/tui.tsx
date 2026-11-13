import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { YandexAuth } from "./rpc.js"

/**
 * TUI part: surfaces the plugin auth lifecycle.
 *
 * - OS notification when `yc` opens the browser (you might be in another window)
 * - toast on waiting / success / failure
 * - persistent footer indicator while the interactive login is pending
 */
export default Plugin.define({
  id: "yandex-ai-studio.tui",
  setup(context) {
    const auth = context.client.rpc(YandexAuth)
    const [waiting, setWaiting] = createSignal(false)

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

    // Persistent status in the footer while waiting for the browser login.
    context.ui.slot({
      append: "home.footer.status",
      render: () => (waiting() ? <text fg="yellow">YC[AUTH…]</text> : null),
    })

    return () => {
      stop()
      stopSucceeded()
      stopFailed()
      setWaiting(false)
    }
  },
})
