import { useLayoutEffect, type RefObject } from "react"

import { composerLayout } from "@/composer"

/**
 * Sizes a composer textarea to its current value. Every composer in the product
 * shares this hook: a second implementation inherits the send-reset defect this
 * one is written to prevent.
 */
export function useComposerAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const textarea = ref.current
    if (textarea === null) return
    // `scrollHeight` never reports less than the box itself, so the height must
    // collapse before it is read: measuring first pins a shrinking draft — a sent
    // one above all — at the size it used to need.
    const previous = textarea.style.height
    textarea.style.height = "auto"
    const layout = composerLayout(textarea.scrollHeight)
    // `auto` cannot be interpolated, so the measurement would end the animation
    // before it starts. The box returns to the height it had and is flushed, which
    // makes that height the value the transition grows or shrinks from.
    if (previous !== "") {
      textarea.style.height = previous
      textarea.getBoundingClientRect()
    }
    textarea.style.height = `${layout.height}px`
    textarea.style.overflowY = layout.overflowY
  }, [ref, value])
}
