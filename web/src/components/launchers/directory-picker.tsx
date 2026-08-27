import { useState } from "react"
import { ChevronLeft, ChevronRight, Folder, FolderOpen, RefreshCw, X } from "lucide-react"

import { apiCall } from "@/api/runtime"
import type { DirectoryList, MsgrApi } from "@/api/types"
import { Button } from "@/components/ui/button"
import { KeyboardOverlay } from "@/components/ui/keyboard-overlay"
import { directoryPickerSelectionPath } from "@/components/launchers/directory-picker-logic"

type DirectoryPickerState =
  | { status: "closed" }
  | { status: "loading"; path: string | undefined }
  | { status: "ready"; listing: DirectoryList }
  | { status: "error"; message: string; path: string | undefined }

export interface DirectoryPickerProps {
  api: MsgrApi
  disabled?: boolean
  onSelect: (absolutePath: string) => void
}

export function DirectoryPicker({ api, disabled = false, onSelect }: DirectoryPickerProps) {
  const [state, setState] = useState<DirectoryPickerState>({ status: "closed" })

  function browse(path?: string): void {
    setState({ path, status: "loading" })
    void apiCall(api, undefined, (client) => client.listDirectories(path)).then((result) => {
      if (result.isErr()) {
        setState({ message: result.error.message, path, status: "error" })
        return
      }
      setState({ listing: result.value, status: "ready" })
    })
  }

  function chooseCurrentFolder(): void {
    if (state.status !== "ready") return
    onSelect(directoryPickerSelectionPath(state.listing))
    setState({ status: "closed" })
  }

  return (
    <div className="space-y-2">
      <Button
        aria-expanded={state.status !== "closed"}
        disabled={disabled}
        onClick={() => browse()}
        size="lg"
        type="button"
        variant="outline"
      >
        <FolderOpen aria-hidden="true" />
        Browse folder
      </Button>
      {state.status !== "closed" && (
        <KeyboardOverlay className="max-w-xl" dataDialog="launcher-directory-picker" labelledBy="launcher-directory-picker-title" onClose={() => setState({ status: "closed" })} scope="dialog">
          <section aria-labelledby="launcher-directory-picker-title" data-launcher-directory-picker="true">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" id="launcher-directory-picker-title">Choose folder</h4>
              {state.status === "ready" && <code className="mt-1 block truncate text-xs" title={state.listing.currentPath}>{state.listing.currentPath}</code>}
            </div>
            <Button aria-label="Close folder browser" onClick={() => setState({ status: "closed" })} size="icon-lg" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
          {state.status === "loading" && <p className="mt-3 text-sm text-muted-foreground" role="status">Loading folders…</p>}
          {state.status === "error" && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3" role="alert">
              <p className="text-sm text-destructive">{state.message}</p>
              <Button onClick={() => browse(state.path)} size="lg" type="button" variant="outline"><RefreshCw aria-hidden="true" /> Retry</Button>
            </div>
          )}
          {state.status === "ready" && (
            <>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Button disabled={state.listing.parentPath === null} onClick={() => browse(state.listing.parentPath ?? undefined)} size="lg" type="button" variant="ghost"><ChevronLeft aria-hidden="true" /> Up</Button>
                <Button onClick={chooseCurrentFolder} size="lg" type="button">Use this folder</Button>
              </div>
              <div className="mt-2 overflow-hidden rounded-md border" data-launcher-directory-list="true">
                <div className="max-h-56 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                  {state.listing.directories.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">No child folders.</p>}
                  {state.listing.directories.length > 0 && (
                    <ul aria-label="Child folders" className="divide-y">
                      {state.listing.directories.map((directory) => (
                        <li key={directory.path}>
                          <button className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" onClick={() => browse(directory.path)} type="button">
                            <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {state.listing.truncated && <p className="mt-2 text-xs text-muted-foreground">Only the first 500 folders are shown. Use manual entry for a deeper location.</p>}
            </>
          )}
          </section>
        </KeyboardOverlay>
      )}
    </div>
  )
}
