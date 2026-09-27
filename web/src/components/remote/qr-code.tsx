import { useMemo } from "react"
import { encode } from "uqr"

/** Quiet zone around the code, in modules. The QR standard asks for four. */
const QUIET_ZONE_MODULES = 4
/** Rendered size of the square in CSS pixels. */
const QR_DISPLAY_PIXELS = 208

/** One SVG path with a unit square per dark module. */
function darkModulesPath(modules: readonly (readonly boolean[])[]): string {
  const parts: string[] = []
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x} ${y}h1v1h-1z`)
    })
  })
  return parts.join("")
}

/**
 * A QR code as inline SVG. It is always dark on white, whatever the theme,
 * because phone cameras read that contrast most reliably.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const code = useMemo(() => encode(value, { ecc: "M", border: QUIET_ZONE_MODULES }), [value])
  const path = useMemo(() => darkModulesPath(code.data), [code])
  return (
    <svg
      aria-label={label}
      className="rounded-lg"
      data-qr-code
      height={QR_DISPLAY_PIXELS}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${code.size} ${code.size}`}
      width={QR_DISPLAY_PIXELS}
    >
      <rect fill="#ffffff" height={code.size} width={code.size} />
      <path d={path} fill="#000000" />
    </svg>
  )
}
