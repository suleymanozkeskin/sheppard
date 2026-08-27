import { useCallback, useEffect, useRef, type RefObject } from "react"

import {
  actionForCombo,
  comboFromKeyEvent,
  keyboardLayerStack,
  shouldDispatchWhileTyping,
  type ActionName,
  type KeyboardBindings,
  type KeyboardLayer,
  type KeyboardLayerHandler,
} from "@/keyboard"

interface KeyboardDispatcherOptions {
  actionHandlers: ReadonlyMap<ActionName, () => void>
  bindings: KeyboardBindings
  composerRef: RefObject<HTMLTextAreaElement | null>
  onUnavailableAction: (action: ActionName) => void
}

export function useKeyboardDispatcher({
  actionHandlers,
  bindings,
  composerRef,
  onUnavailableAction,
}: KeyboardDispatcherOptions): (action: ActionName) => void {
  const bindingsRef = useRef(bindings)
  const actionHandlersRef = useRef(actionHandlers)
  const dispatchActionRef = useRef<(action: ActionName) => void>(() => undefined)
  const onUnavailableActionRef = useRef(onUnavailableAction)

  useEffect(() => {
    bindingsRef.current = bindings
    actionHandlersRef.current = actionHandlers
    onUnavailableActionRef.current = onUnavailableAction
  }, [actionHandlers, bindings, onUnavailableAction])

  const dispatchAction = useCallback((action: ActionName) => {
    const handler = actionHandlersRef.current.get(action)
    if (handler === undefined) {
      onUnavailableActionRef.current(action)
      return
    }
    handler()
  }, [])

  useEffect(() => {
    dispatchActionRef.current = dispatchAction
  }, [dispatchAction])

  useEffect(() => {
    function dispatchKeyboardAction(event: KeyboardEvent): void {
      const combo = comboFromKeyEvent(event)
      if (keyboardLayerStack.hasLayers()) {
        if (event.key === "Escape") {
          event.preventDefault()
          if (!keyboardLayerStack.closeTop()) dispatchActionRef.current("overlay.close")
          return
        } else if (keyboardLayerStack.dispatch(event)) {
          event.preventDefault()
          return
        } else if (keyboardLayerStack.isPageBlocked()) {
          return
        }
      }
      const action = actionForCombo(bindingsRef.current, combo)
      if (action === undefined) return
      const typing = isTypingTarget(event.target)
      const composer = event.target === composerRef.current
      if (!shouldDispatchWhileTyping(action, event, typing, composer)) return
      if (action === "composer.newline" && composer) return
      if (action === "composer.send" && !composer) return
      event.preventDefault()
      dispatchActionRef.current(action)
    }

    window.addEventListener("keydown", dispatchKeyboardAction)
    return () => window.removeEventListener("keydown", dispatchKeyboardAction)
  }, [composerRef])

  return dispatchAction
}

export function useKeyboardLayer(
  scope: KeyboardLayer,
  handler: KeyboardLayerHandler | undefined,
  onClose: (() => void) | undefined,
): void {
  const handlerRef = useRef(handler)
  const closeRef = useRef(onClose)

  useEffect(() => {
    handlerRef.current = handler
    closeRef.current = onClose
  }, [handler, onClose])

  useEffect(() => {
    const release = keyboardLayerStack.push(
      scope,
      (event) => handlerRef.current?.(event) ?? false,
      () => closeRef.current?.(),
    )
    return release
  }, [scope])
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA"
}
