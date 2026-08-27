export function isPageLevelFocus<T>(
  activeElement: T | null | undefined,
  body: T | null | undefined,
  documentElement: T | null | undefined,
): boolean {
  return activeElement === null
    || activeElement === undefined
    || activeElement === body
    || activeElement === documentElement
}
