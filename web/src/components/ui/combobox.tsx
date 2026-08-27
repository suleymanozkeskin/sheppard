import { useEffect, useId, useMemo, useState, type ReactNode } from "react"
import { Check, ChevronsUpDown, X } from "lucide-react"
import { Combobox as BaseCombobox } from "@base-ui/react/combobox"

import { cn } from "@/lib/utils"
import { filterComboboxOptions, shouldKeepComboboxSelection, shouldStopComboboxEscape } from "./combobox-logic"

export interface ComboboxOption {
  value: string
  label: string
  sublabel?: string
  keywords?: readonly string[]
  disabled?: boolean
  leading?: ReactNode
}

export interface ComboboxProps {
  autoComplete?: string
  id?: string
  label?: string
  name?: string
  options: readonly ComboboxOption[]
  value: string | null
  onValueChange: (value: string | null, option?: ComboboxOption) => void
  placeholder?: string
  emptyMessage?: string
  allOptionLabel?: string
  allOptionValue?: string
  showAllOption?: boolean
  disabled?: boolean
  required?: boolean
  className?: string
  contentClassName?: string
  renderOption?: (option: ComboboxOption) => ReactNode
  renderValue?: (option: ComboboxOption) => ReactNode
  loading?: boolean
  loadingMessage?: string
  spellCheck?: boolean
  errorMessage?: string | null
  onRetry?: () => void
  onEscapeWhenClosed?: () => void
  retryLabel?: string
  clearable?: boolean
  clearAriaLabel?: string
  startAdornment?: ReactNode
  maxVisibleOptions?: number
  description?: ReactNode
  error?: ReactNode
  status?: ReactNode
}

/** Standard row with an optional leading icon and secondary text. */
export function ComboboxOptionRow({
  icon,
  label,
  sublabel,
  end,
}: {
  icon?: ReactNode
  label: ReactNode
  sublabel?: ReactNode
  end?: ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sublabel !== undefined && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{sublabel}</span>}
      </span>
      {end}
    </span>
  )
}

/** A searchable, keyboard-accessible single-value combobox. */
export function Combobox({
  allOptionLabel,
  allOptionValue = "",
  autoComplete,
  clearAriaLabel = "Clear selection",
  clearable = false,
  className,
  contentClassName,
  description,
  disabled = false,
  emptyMessage = "No options found.",
  error,
  errorMessage = null,
  id,
  label,
  loading = false,
  loadingMessage = "Loading…",
  maxVisibleOptions,
  name,
  onRetry,
  onEscapeWhenClosed,
  onValueChange,
  options,
  placeholder = "Search or choose…",
  renderOption,
  renderValue,
  required = false,
  retryLabel = "Retry",
  showAllOption = true,
  spellCheck,
  startAdornment,
  status,
  value,
}: ComboboxProps) {
  const generatedId = useId()
  const resolvedId = id ?? `combobox-${generatedId.replaceAll(":", "")}`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [inputValue, setInputValue] = useState("")
  const allOptions = useMemo(
    () => showAllOption
      ? [{ label: allOptionLabel ?? "All", value: allOptionValue }, ...options]
      : [...options],
    [allOptionLabel, allOptionValue, options, showAllOption],
  )
  const selected = allOptions.find((option) => option.value === value) ?? null
  useEffect(() => {
    if (!open) {
      setInputValue("")
      setQuery("")
    }
  }, [open])
  const filteredOptions = useMemo(() => filterComboboxOptions(allOptions, query, maxVisibleOptions), [allOptions, maxVisibleOptions, query])
  const describedBy = [
    description === undefined ? undefined : `${resolvedId}-description`,
    error === undefined ? undefined : `${resolvedId}-error`,
    `${resolvedId}-status`,
  ].filter((entry): entry is string => entry !== undefined).join(" ") || undefined

  function close(): void {
    setOpen(false)
    setQuery("")
  }

  function selectOption(option: ComboboxOption): void {
    onValueChange(option.value, option)
    close()
  }

  const showClear = clearable && value !== null && value !== allOptionValue

  return (
    <BaseCombobox.Root<ComboboxOption>
      autoHighlight
      disabled={disabled}
      filter={null}
      filteredItems={filteredOptions}
      id={resolvedId}
      inputValue={inputValue}
      isItemEqualToValue={(left, right) => left.value === right.value}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      items={allOptions}
      onInputValueChange={(next) => { setInputValue(next); setQuery(next) }}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setQuery("")
      }}
      onValueChange={(next) => {
        if (next === null) {
          // Base UI can emit null when the selected row is picked again. A
          // required picker, or a picker without an explicit all option, must
          // keep its current selection in that case.
          if (shouldKeepComboboxSelection(required, showAllOption)) {
            close()
            return
          }
          onValueChange(null)
          close()
          return
        }
        selectOption(next)
      }}
      required={required}
      value={selected}
    >
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)} data-combobox={resolvedId} data-combobox-open={open ? "true" : "false"}>
        {label !== undefined && <label className="text-sm font-medium" htmlFor={resolvedId}>{label}</label>}
        <BaseCombobox.InputGroup className="relative flex min-h-11 items-center rounded-xl border bg-background pl-4 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            {startAdornment ?? (selected === null ? undefined : selected.leading)}
          </span>
          {!open && selected !== null && (
            <span className={cn("pointer-events-none absolute inset-y-0 left-12 flex min-w-0 items-center overflow-hidden text-sm", showClear ? "right-24" : "right-12")} data-combobox-value>
              <span className="truncate"><BaseCombobox.Value>{renderValue?.(selected) ?? selected.label}</BaseCombobox.Value></span>
            </span>
          )}
          <BaseCombobox.Input
            autoComplete={autoComplete}
            aria-describedby={describedBy}
            aria-invalid={error !== undefined || errorMessage !== null ? true : undefined}
            aria-label={label}
            className={cn("min-w-0 flex-1 bg-transparent py-2.5 pl-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60", showClear ? "pr-24" : "pr-12", !open && selected !== null && "text-transparent caret-transparent")}
            data-combobox-input={resolvedId}
            id={resolvedId}
            name={name}
            placeholder={selected === null || selected.value === allOptionValue ? placeholder : undefined}
            spellCheck={spellCheck}
            onKeyDown={(event) => {
              // Let the page close only after the popup has already closed.
              if (event.key !== "Escape") return
              if (shouldStopComboboxEscape(open)) {
                event.stopPropagation()
                return
              }
              if (onEscapeWhenClosed === undefined) return
              event.preventDefault()
              event.stopPropagation()
              onEscapeWhenClosed()
            }}
          />
          {showClear && (
            <button
              aria-label={clearAriaLabel}
              className="absolute right-11 flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              disabled={disabled}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); onValueChange(null); close() }}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
          <BaseCombobox.Trigger aria-label={label === undefined ? "Open options" : `Open ${label} options`} className="absolute right-0 flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronsUpDown aria-hidden="true" className="size-4" />
          </BaseCombobox.Trigger>
        </BaseCombobox.InputGroup>
        {description !== undefined && <p className="text-xs text-muted-foreground" id={`${resolvedId}-description`}>{description}</p>}
        {error !== undefined && <p className="text-sm text-destructive" id={`${resolvedId}-error`} role="alert">{error}</p>}
        <BaseCombobox.Status aria-live="polite" className="sr-only" id={`${resolvedId}-status`}>{status}</BaseCombobox.Status>
      </div>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner align="start" className="z-50 outline-none" sideOffset={6}>
          <BaseCombobox.Popup
            aria-label={label === undefined ? "Options" : `${label} options`}
            className={cn("w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl", contentClassName)}
            onKeyDown={(event) => { if (event.key === "Escape" && shouldStopComboboxEscape(open)) event.stopPropagation() }}
          >
            {loading && <p className="px-3 py-4 text-sm text-muted-foreground" role="status">{loadingMessage}</p>}
            {!loading && errorMessage !== null && (
              <div className="flex flex-col gap-3 px-3 py-4 text-sm" role="alert">
                <span className="text-destructive">{errorMessage}</span>
                {onRetry !== undefined && <button className="min-h-11 self-start rounded-lg border px-3 py-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={onRetry} type="button">{retryLabel}</button>}
              </div>
            )}
            {!loading && errorMessage === null && (
              <>
                <BaseCombobox.Empty className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</BaseCombobox.Empty>
                <BaseCombobox.List className="max-h-[min(22rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 outline-none">
                  {(option: ComboboxOption) => (
                    <BaseCombobox.Item
                      className="relative flex min-h-11 cursor-default items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
                      data-combobox-option={option.value}
                      disabled={option.disabled}
                      key={option.value}
                      value={option}
                    >
                      {renderOption === undefined
                        ? <ComboboxOptionRow icon={option.leading} label={option.label} sublabel={option.sublabel} />
                        : renderOption(option)}
                      <BaseCombobox.ItemIndicator className="flex size-5 shrink-0 items-center justify-center text-primary">
                        <Check aria-hidden="true" className="size-4" />
                      </BaseCombobox.ItemIndicator>
                    </BaseCombobox.Item>
                  )}
                </BaseCombobox.List>
              </>
            )}
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  )
}
