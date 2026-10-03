import type { CsrfToken } from '~/types/api'

/** Methods that change state, and therefore have to carry a CSRF token. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The token from `GET /csrf`, cached for the life of the page.
 *
 * Spring rotates the token when the session changes - on login and on logout - but both of those
 * are full navigations, so the module is re-evaluated and this cache starts empty again. Within a
 * page load the token is stable, which is what makes caching safe rather than merely faster.
 */
let cachedCsrfToken: CsrfToken | null = null

/**
 * The single place the storefront talks to the Spring API.
 *
 * Two things make it work with the Backend for Frontend:
 *
 * - `credentials: 'include'` - the browser must attach the `httpOnly` session cookie, and it will
 *   only do so on a cross-origin call if this is set.
 * - a CSRF token on every unsafe method - the API enforces double-submit CSRF, and the SPA cannot
 *   read the cookie it is paired with, so it fetches the token from `GET /csrf`.
 *
 * Nothing here ever handles an OAuth token: there is none in the browser.
 */
export function useApi() {
  const config = useRuntimeConfig()
  const baseURL = config.public.apiBaseUrl

  const client = $fetch.create({
    baseURL,
    credentials: 'include',
    // Let callers inspect the status/body of a failed request rather than getting an opaque throw.
    retry: 0,
  })

  async function csrfToken(): Promise<CsrfToken> {
    if (cachedCsrfToken === null) {
      cachedCsrfToken = await client<CsrfToken>('/csrf')
    }
    return cachedCsrfToken
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const options: Parameters<typeof client<T>>[1] = { method }

    if (body !== undefined) {
      options.body = body
    }

    if (UNSAFE_METHODS.has(method)) {
      const csrf = await csrfToken()
      options.headers = { ...options.headers, [csrf.headerName]: csrf.token }
    }

    return await client<T>(path, options)
  }

  return {
    /** The API's base URL, for the OAuth login navigation and the logout form action. */
    baseURL,
    csrfToken,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  }
}
