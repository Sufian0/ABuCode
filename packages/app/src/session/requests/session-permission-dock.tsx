import { createMemo, createSignal, For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"

const HIDDEN_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u2D7F\u3164\uFE00-\uFE0F\uFFA0\uFFFC\u{E0100}-\u{E01EF}]/gu
const MANY_COMBINING_MARKS = /\p{M}{4,}/gu

function showHiddenCharacters(text: string): string {
  return text
    .replace(MANY_COMBINING_MARKS, (run) => `⟦${Array.from(run).length} combining marks⟧`)
    .replace(HIDDEN_CHARACTERS, (ch) => {
      if (ch === " " || ch === "\t" || ch === "\n") return ch
      const code = ch.codePointAt(0) ?? 0
      return `⟦U+${code.toString(16).toUpperCase().padStart(4, "0")}⟧`
    })
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const combinedText = createMemo(() => props.request.resources.join("\n"))
  const needsScrollUnlock = createMemo(
    () => combinedText().length > 360 || combinedText().split("\n").length > 7,
  )
  const [scrolledToEnd, setScrolledToEnd] = createSignal(false)
  const allowLocked = createMemo(() => needsScrollUnlock() && !scrolledToEnd())

  const onScrollPatterns = (el: HTMLDivElement) => {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) {
      setScrolledToEnd(true)
    }
  }

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])

    if (value === key) return ""

    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">
            {language.t("notification.permission.title")}
            <Show when={combinedText().length > 0}>
              <span class="ml-2 text-[11px] font-normal opacity-75">
                · {combinedText().split("\n").length} line{combinedText().split("\n").length === 1 ? "" : "s"} ·{" "}
                {combinedText().length} chars
              </span>
            </Show>
          </div>
        </div>
      }
      footer={
        <>
          <div class="text-[11px] opacity-80">
            <Show when={allowLocked()}>Scroll to the end of the command above to unlock Allow</Show>
          </div>
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="neutral"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding || allowLocked()}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button
              variant="submit"
              size="normal"
              onClick={() => props.onDecide("once")}
              disabled={props.responding || allowLocked()}
            >
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div
            data-slot="permission-patterns"
            class="max-h-[180px] overflow-y-auto"
            onScroll={(e) => onScrollPatterns(e.currentTarget)}
          >
            <For each={props.request.resources}>
              {(pattern) => (
                <pre class="text-text-base whitespace-pre-wrap break-all font-mono text-[12px]">
                  {showHiddenCharacters(pattern)}
                </pre>
              )}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
