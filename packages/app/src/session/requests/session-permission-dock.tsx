import { Option, Schema } from "effect"
import { createMemo, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { PermissionRequest } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"

const decodeToolInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

const isString = Schema.is(Schema.String)

const HIDDEN_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u2D7F\u3164\uFE00-\uFE0F\uFFA0\uFFFC\u{E0100}-\u{E01EF}]/gu

const MANY_COMBINING_MARKS = /\p{M}{4,}/gu

// Scroll offsets are fractional and box heights are rounded, so a box at its end can read a pixel short.
const END_SLACK = 2

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

  const input = createMemo(() =>
    Option.match(decodeToolInput(props.request.metadata?.input), {
      onNone: () => [],
      onSome: (value) =>
        Object.entries(value).map(([key, item]) => `${key}: ${isString(item) ? item : JSON.stringify(item)}`),
    }),
  )

  // ABuCode: everything the user approves as the dock shows it, the tool input and then the resources. Each has its
  // own scroll box, and Allow stays locked until every box that overflows has been scrolled to its end.
  const approvalText = createMemo(() => [...input(), ...props.request.resources].map(showHiddenCharacters).join("\n"))

  // `fits` follows the layout, so text that rewraps past its box locks Allow again. `seen` only turns on: the user
  // scrolled that box to its end. Both start false, which keeps Allow locked until a box has been measured.
  const [boxes, setBoxes] = createStore({
    input: { fits: false, seen: false },
    patterns: { fits: false, seen: false },
  })

  const allowLocked = createMemo(
    () =>
      (input().length > 0 && !boxes.input.fits && !boxes.input.seen) ||
      (props.request.resources.length > 0 && !boxes.patterns.fits && !boxes.patterns.seen),
  )

  let inputBox: HTMLDivElement | undefined
  let patternsBox: HTMLDivElement | undefined

  // A box with no height is not laid out, so nothing is known about it yet.
  const measure = (box: "input" | "patterns", el: HTMLDivElement | undefined) => {
    if (!el || el.clientHeight === 0) return

    setBoxes(box, "fits", el.scrollHeight - el.clientHeight <= END_SLACK)
  }

  const scrolled = (box: "input" | "patterns", el: HTMLDivElement) => {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - END_SLACK) setBoxes(box, "seen", true)
  }

  // Text that fits never scrolls, so no scroll event can clear it: measure both boxes whenever one changes size.
  onMount(() =>
    createResizeObserver([inputBox, patternsBox], () => {
      measure("input", inputBox)
      measure("patterns", patternsBox)
    }),
  )

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    // SAFETY: an action without a curated description returns the key itself, which the check below detects.
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
            <Show when={approvalText().length > 0}>
              <span class="ml-2 text-[11px] font-normal opacity-75">
                · {approvalText().split("\n").length} line{approvalText().split("\n").length === 1 ? "" : "s"} ·{" "}
                {approvalText().length} chars
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
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <Show
          when={toolDescription()}
          fallback={<code data-slot="permission-action">{showHiddenCharacters(props.request.action)}</code>}
        >
          <div data-slot="permission-hint">{toolDescription()}</div>
        </Show>
      </div>

      <Show when={props.request.message}>
        {(message) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">{showHiddenCharacters(message())}</div>
          </div>
        )}
      </Show>

      <Show when={input().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          {/* Scrolls rather than truncates: the user approves these arguments, so all of them must be reachable */}
          <div
            data-slot="permission-input"
            data-scrollable
            ref={(el) => (inputBox = el)}
            onScroll={(event) => scrolled("input", event.currentTarget)}
          >
            <For each={input()}>
              {(line) => <code class="text-text-weak break-all">{showHiddenCharacters(line)}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div
            data-slot="permission-patterns"
            data-scrollable
            class="max-h-[180px] overflow-y-auto"
            ref={(el) => (patternsBox = el)}
            onScroll={(event) => scrolled("patterns", event.currentTarget)}
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
