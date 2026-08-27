import type { MouseEvent } from "react"
import { ChevronLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { shellRoutePath, type ShellNavigate, type ShellRoute } from "@/shell-routing"

interface ShellBackLinkProps {
  destination?: ShellRoute
  label: string
  navigate: ShellNavigate
}

export function ShellBackLink({ destination, label, navigate }: ShellBackLinkProps) {
  if (destination === undefined) {
    return (
      <Button aria-label={label} className="-ml-2 shrink-0" data-shell-back disabled size="icon-sm" title={label} type="button" variant="ghost">
        <ChevronLeft aria-hidden="true" />
      </Button>
    )
  }

  const href = shellRoutePath(destination)
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(destination)
  }

  return (
    <Button
      aria-label={label}
      className="-ml-2 shrink-0"
      data-shell-back
      onClick={handleClick}
      render={<a href={href} />}
      size="icon-sm"
      title={label}
      variant="ghost"
    >
      <ChevronLeft aria-hidden="true" />
    </Button>
  )
}
