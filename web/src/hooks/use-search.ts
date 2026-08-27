import { useCallback, useEffect, useReducer, useRef } from "react"

import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { MsgrApi, SearchResult } from "@/api/types"
import type { SearchLoadState } from "@/components/search-view"
import type { SearchRouteScope, ShellNavigate, ShellRoute } from "@/shell-routing"

export type SearchScope = "all" | "channel"
export const SEARCH_RESULT_LIMIT = 50

type SearchRoute = Extract<ShellRoute, { kind: "search" }>

export interface ParsedSearchQuery {
  effectiveQuery: string
  notice: string | undefined
  sender: string | undefined
}

const SENDER_TERM = /^from:([a-z][a-z0-9_-]{0,31})$/u

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const normalized = raw.trim()
  if (normalized.length === 0) return { effectiveQuery: "", notice: undefined, sender: undefined }

  const terms = normalized.split(/\s+/u)
  const senderIndex = terms[0] !== undefined && SENDER_TERM.test(terms[0]) ? 0 : -1
  const sender = senderIndex < 0 ? undefined : terms[senderIndex]?.slice("from:".length)
  const searchableTerms = terms.filter((_term, index) => index !== senderIndex)
  const effectiveTerms = searchableTerms.slice(0, 8)
  const ignoredTerms = searchableTerms.length - effectiveTerms.length
  const effectiveQuery = effectiveTerms.join(" ")
  return {
    effectiveQuery: effectiveQuery.length === 0 ? normalized : effectiveQuery,
    notice: ignoredTerms > 0
      ? `Searched the first 8 words. ${ignoredTerms} more were ignored.`
      : undefined,
    sender,
  }
}

interface SearchState {
  query: string
  scope: SearchScope
  submitted: string | null
  notice: string | undefined
  loadState: SearchLoadState
  results: SearchResult[]
  truncated: boolean
  contextLoadingId: number | undefined
  contextError: string | undefined
  selectedResultId: number | undefined
}

type SearchAction =
  | { type: "query"; query: string }
  | { type: "scope"; scope: SearchScope }
  | { type: "clear" }
  | { type: "loading"; notice: string | undefined; query: string }
  | { type: "ready"; results: SearchResult[]; truncated: boolean }
  | { type: "error"; message: string }
  | { type: "context.loading"; messageId: number }
  | { type: "context.error"; message: string }
  | { type: "context.ready" }

const initialSearchState: SearchState = {
  contextError: undefined,
  contextLoadingId: undefined,
  selectedResultId: undefined,
  loadState: { status: "idle" },
  notice: undefined,
  query: "",
  results: [],
  scope: "all",
  submitted: null,
  truncated: false,
}

function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "query":
      return { ...state, query: action.query }
    case "scope":
      return { ...state, scope: action.scope }
    case "clear":
      return {
        ...state,
        contextError: undefined,
        contextLoadingId: undefined,
        selectedResultId: undefined,
        loadState: { status: "idle" },
        notice: undefined,
        results: [],
        submitted: null,
        truncated: false,
      }
    case "loading":
      return {
        ...state,
        contextError: undefined,
        contextLoadingId: undefined,
        selectedResultId: undefined,
        loadState: { status: "loading" },
        notice: action.notice,
        results: [],
        submitted: action.query,
        truncated: false,
      }
    case "ready":
      return {
        ...state,
        contextError: undefined,
        loadState: { status: "ready" },
        results: action.results,
        truncated: action.truncated,
      }
    case "error":
      return { ...state, loadState: { message: action.message, status: "error" } }
    case "context.loading":
      return { ...state, contextError: undefined, contextLoadingId: action.messageId, selectedResultId: action.messageId }
    case "context.error":
      return { ...state, contextError: action.message, contextLoadingId: undefined }
    case "context.ready":
      return {
        ...state,
        contextError: undefined,
        contextLoadingId: undefined,
        loadState: { status: "ready" },
      }
  }
}

export interface SearchController {
  contextError: string | undefined
  contextLoadingId: number | undefined
  searchNotice: string | undefined
  query: string
  results: SearchResult[]
  selectedResultId: number | undefined
  searchTruncated: boolean
  runSearch: (query: string, scope?: SearchScope) => void
  retrySearch: () => void
  openSearch: () => void
  searchActive: boolean
  searchScope: SearchScope
  searchState: SearchLoadState
  setSearchQuery: (query: string) => void
  setSearchScope: (scope: SearchScope) => void
  openSearchResult: (result: SearchResult) => void
  clearSearch: () => void
  toggleSearchScope: () => void
  submittedQuery: string | null
}

function channelFromRouteScope(scope: SearchRouteScope): string | undefined {
  return scope.startsWith("channel:") ? scope.slice("channel:".length) : undefined
}

function routeScopeFor(
  scope: SearchScope,
  selectedChannel: string | undefined,
  fallback: SearchRouteScope | undefined,
): SearchRouteScope | undefined {
  if (scope === "all") return "all"
  if (selectedChannel !== undefined) return `channel:${selectedChannel}`
  return fallback?.startsWith("channel:") === true ? fallback : undefined
}

export function useSearch(
  api: MsgrApi,
  fallback: MsgrApi | undefined,
  selectedChannel: string | undefined,
  navigate: ShellNavigate,
  channelKind: (channel: string) => "chat" | "workspace" | "direct",
  searchRoute?: SearchRoute,
): SearchController {
  const [state, dispatch] = useReducer(searchReducer, initialSearchState)
  const requestIdRef = useRef(0)
  const routeQuery = searchRoute?.query
  const routeScope = searchRoute?.scope

  const executeSearch = useCallback((route: SearchRoute) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const searchScope: SearchScope = route.scope === "all" ? "all" : "channel"
    dispatch({ scope: searchScope, type: "scope" })
    dispatch({ query: route.query, type: "query" })
    const normalized = route.query.trim()
    if (normalized.length === 0) {
      dispatch({ type: "clear" })
      return
    }

    const parsed = parseSearchQuery(normalized)
    dispatch({ notice: parsed.notice, query: parsed.effectiveQuery, type: "loading" })
    void apiCall(api, fallback, (client) =>
      client.search({
        channel: channelFromRouteScope(route.scope),
        limit: SEARCH_RESULT_LIMIT,
        q: parsed.effectiveQuery,
        sender: parsed.sender,
      }),
    ).then((result) => {
      if (requestId !== requestIdRef.current) return
      result.match({
        ok: ({ results, truncated }) => dispatch({ results, truncated, type: "ready" }),
        err: (error) => dispatch({ message: formatApiError(error), type: "error" }),
      })
    })
  }, [api, fallback])

  useEffect(() => {
    requestIdRef.current += 1
    if (routeQuery === undefined || routeScope === undefined) {
      dispatch({ type: "clear" })
      return
    }
    executeSearch({ kind: "search", query: routeQuery, scope: routeScope })
  }, [executeSearch, routeQuery, routeScope])

  const setSearchQuery = useCallback((query: string) => {
    if (routeScope !== undefined) {
      navigate({ kind: "search", query, scope: routeScope }, true)
      return
    }
    dispatch({ query, type: "query" })
  }, [navigate, routeScope])

  const setSearchScope = useCallback((scope: SearchScope) => {
    const nextRouteScope = routeScopeFor(scope, selectedChannel, routeScope)
    if (routeScope !== undefined) {
      if (nextRouteScope === undefined) {
        dispatch({ message: "Select a channel before using this search scope.", type: "error" })
        return
      }
      navigate({ kind: "search", query: routeQuery ?? "", scope: nextRouteScope }, true)
      return
    }
    dispatch({ scope, type: "scope" })
  }, [navigate, routeQuery, routeScope, selectedChannel])

  const runSearch = useCallback(
    (query: string, scope = state.scope) => {
      const nextRouteScope = routeScopeFor(scope, selectedChannel, routeScope)
      if (nextRouteScope === undefined) {
        dispatch({ message: "Select a channel before using this search scope.", type: "error" })
        return
      }
      navigate({ kind: "search", query: query.trim(), scope: nextRouteScope })
    },
    [navigate, routeScope, selectedChannel, state.scope],
  )

  const retrySearch = useCallback(() => {
    if (routeQuery === undefined || routeScope === undefined) return
    executeSearch({ kind: "search", query: routeQuery, scope: routeScope })
  }, [executeSearch, routeQuery, routeScope])

  const openSearch = useCallback(() => {
    const scope = routeScopeFor(state.scope, selectedChannel, undefined) ?? "all"
    navigate({ kind: "search", query: "", scope })
  }, [navigate, selectedChannel, state.scope])

  const clearSearch = useCallback(() => {
    if (routeScope !== undefined) {
      navigate({ kind: "current" }, true)
      return
    }
    requestIdRef.current += 1
    dispatch({ type: "clear" })
  }, [navigate, routeScope])

  const toggleSearchScope = useCallback(() => {
    setSearchScope(state.scope === "all" ? "channel" : "all")
  }, [setSearchScope, state.scope])

  const openSearchResult = useCallback(
    (result: SearchResult) => {
      switch (channelKind(result.channel)) {
        case "direct":
          navigate({ channel: result.channel, kind: "conversation", messageId: result.messageId })
          break
        case "workspace":
          navigate({ channel: result.channel, channelKind: "workspace", kind: "channel", messageId: result.messageId })
          break
        case "chat":
          navigate({ channel: result.channel, kind: "channel", messageId: result.messageId })
          break
      }
    },
    [channelKind, navigate],
  )

  const searchScope: SearchScope = routeScope === undefined
    ? state.scope
    : routeScope === "all" ? "all" : "channel"
  return {
    contextError: state.contextError,
    contextLoadingId: state.contextLoadingId,
    clearSearch,
    openSearch,
    openSearchResult,
    retrySearch,
    searchNotice: state.notice,
    query: routeQuery ?? state.query,
    results: state.results,
    selectedResultId: state.selectedResultId,
    searchActive: routeScope !== undefined,
    searchScope,
    searchState: state.loadState,
    searchTruncated: state.truncated,
    setSearchQuery,
    setSearchScope,
    submittedQuery: routeQuery ?? state.submitted,
    runSearch,
    toggleSearchScope,
  }
}
