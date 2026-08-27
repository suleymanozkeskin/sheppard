import type { ReactNode } from "react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"

export function IdentityHint({ canWrite, children }: { canWrite: boolean; children: ReactNode }) {
  return canWrite ? children : <span title={NOT_CONNECTED_REASON}>{children}</span>
}
