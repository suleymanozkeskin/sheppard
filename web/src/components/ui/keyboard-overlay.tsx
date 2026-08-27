import { useEffect, useMemo, useRef, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react"

import { useKeyboardLayer } from "@/hooks/use-keyboard-dispatcher"
import type { KeyboardLayer, KeyboardLayerHandler, ModalKeyboardLayerName } from "@/keyboard"
import { cn } from "@/lib/utils"

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])"

interface KeyboardOverlayProps {
  labelledBy: string
  children: ReactNode
  className?: string
  dataDialog?: string
  onClose: () => void
  onLayerKeyDown?: KeyboardLayerHandler
  scope?: ModalKeyboardLayerName
}

export function KeyboardOverlay({
  labelledBy,
  children,
  className,
  dataDialog,
  onClose,
  onLayerKeyDown,
  scope = "dialog",
}: KeyboardOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const layer = useMemo<KeyboardLayer>(() => ({ mode: "modal", scope }), [scope])

  useKeyboardLayer(layer, onLayerKeyDown, onClose)

  useEffect(() => {
    const previousFocus = globalThis.document.activeElement
    const panel = panelRef.current
    if (panel === null) return
    const autofocus = panel.querySelector<HTMLElement>("[data-autofocus]")
    const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    const focusTarget = autofocus ?? firstFocusable ?? panel
    focusTarget.focus()

    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [])

  function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Tab") return
    const panel = panelRef.current
    if (panel === null) return
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    if (focusable.length === 0) {
      event.preventDefault()
      panel.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) return
    const active = globalThis.document.activeElement
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={cn("max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-hidden rounded-2xl border bg-card shadow-xl outline-none", className)}
        data-dialog={dataDialog}
        data-surface-kind="dialog"
        onKeyDown={trapFocus}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="max-h-[calc(100vh-2rem)] overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable] sm:p-6" data-dialog-scroll>
          {children}
          <button aria-label="Close" className="sr-only" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
