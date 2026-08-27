import { Result } from "better-result"

import type { ApiError } from "./errors"
import { HttpMsgrApi } from "./client"
import type { ApiClientOptions, ApiResult, MsgrApi } from "./types"

const DEV_MOCK_FALLBACK = import.meta.env?.DEV === true

export function createBrowserApi(onUnauthorized?: ApiClientOptions["onUnauthorized"]): HttpMsgrApi {
  return new HttpMsgrApi({ baseUrl: "", onUnauthorized })
}

function shouldUseMockFallback(error: ApiError): boolean {
  return error.match({
    ApiNetworkError: () => true,
    ApiHttpError: (failure) => failure.status === 500 || failure.status === 502 || failure.status === 503 || failure.status === 504,
    ApiDecodeError: () => false,
    ApiNotFoundError: () => false,
    ApiConflictError: () => false,
  })
}

export async function withMockFallback<T>(
  primary: () => ApiResult<T>,
  fallback: (() => ApiResult<T>) | undefined,
  allowMockFallback = DEV_MOCK_FALLBACK,
): Promise<Result<T, ApiError>> {
  const result = await primary()
  if (result.isOk()) return Result.ok(result.value)
  if (!allowMockFallback || fallback === undefined || !shouldUseMockFallback(result.error)) {
    return Result.err(result.error)
  }
  return fallback()
}

export function apiCall<T>(
  api: MsgrApi,
  fallback: MsgrApi | undefined,
  call: (client: MsgrApi) => ApiResult<T>,
): Promise<Result<T, ApiError>> {
  return withMockFallback(
    () => call(api),
    fallback === undefined ? undefined : () => call(fallback),
  )
}
