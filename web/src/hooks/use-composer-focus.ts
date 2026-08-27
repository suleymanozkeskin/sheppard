import { useEffect, type RefObject } from "react"

type ComposerTarget = () => HTMLTextAreaElement | null

/**
 * Pages mount their own composer, so the focus action cannot hold one ref. A
 * composer registers itself while mounted and drops out when it unmounts, which
 * is what stops an unmounted composer from winning: its cleanup removes it
 * before the next keypress can reach it.
 */
const mounted: ComposerTarget[] = []

/** Registers a composer as the focus target for as long as it is mounted. */
export function useComposerFocusTarget(ref: RefObject<HTMLTextAreaElement | null>): void {
  useEffect(() => {
    const target: ComposerTarget = () => ref.current
    mounted.push(target)
    return () => {
      const index = mounted.lastIndexOf(target)
      if (index !== -1) mounted.splice(index, 1)
    }
  }, [ref])
}

/**
 * Focuses the composer on screen. A page composer takes the newest registration;
 * the transcript composer is the fallback, because it is the one the shell owns
 * rather than a page.
 */
export function focusActiveComposer(fallback: ComposerTarget): void {
  for (let index = mounted.length - 1; index >= 0; index -= 1) {
    const element = mounted[index]?.()
    if (element !== null && element !== undefined) {
      element.focus()
      return
    }
  }
  fallback()?.focus()
}
