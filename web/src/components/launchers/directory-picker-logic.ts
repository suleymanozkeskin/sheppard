import type { DirectoryList } from "@/api/types"

export function directoryPickerSelectionPath(listing: DirectoryList): string {
  return listing.currentPath
}
