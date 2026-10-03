import type { CurrentUser } from '~/types/api'

/**
 * The storefront's view of the BFF session.
 *
 * There is no token to manage: the browser holds a session cookie it cannot read, and `GET /me` is
 * the only way to learn who is signed in and what the API says they may do. `authorities` comes
 * straight from the server's `cognito:groups` mapping, so the UI and the API agree on what `admin`
 * means - and the API is the one that enforces it.
 */
export function useAuth() {
  const user = useState<CurrentUser | null>('auth:user', () => null)
  const loaded = useState<boolean>('auth:loaded', () => false)

  const { baseURL, get, csrfToken } = useApi()
  const config = useRuntimeConfig()
  const route = useRoute()

  /** Re-reads the session from the API. A 401 simply means "not signed in". */
  async function refresh(): Promise<void> {
    try {
      user.value = await get<CurrentUser>('/me')
    }
    catch {
      user.value = null
    }
    finally {
      loaded.value = true
    }
  }

  /** Loads the session once per page load. */
  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) {
      await refresh()
    }
  }

  /**
   * Starts the authorization code + PKCE flow. This has to be a top-level navigation - the API
   * answers with a redirect to Cognito's hosted UI - so `fetch` cannot be used. The page the user
   * was on is remembered so the round trip can return them to it.
   */
  function login(redirectTo?: string): void {
    rememberRedirect(redirectTo ?? route.fullPath)
    window.location.assign(`${baseURL}${config.public.oauthAuthorizationPath}`)
  }

  /**
   * Logout. A form POST rather than a `fetch`, for the same reason as login: the API answers with a
   * redirect to Cognito's end-session endpoint, and a navigation cannot set a header - so the CSRF
   * token travels as the form field the API named. The API ends the session locally and at Cognito,
   * which returns the browser to this app.
   */
  async function logout(): Promise<void> {
    const csrf = await csrfToken()

    const form = document.createElement('form')
    form.method = 'POST'
    form.action = `${baseURL}/logout`

    const field = document.createElement('input')
    field.type = 'hidden'
    field.name = csrf.parameterName
    field.value = csrf.token
    form.appendChild(field)

    document.body.appendChild(form)
    form.submit()
  }

  const isAuthenticated = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value?.authorities.includes('ROLE_admin') ?? false)

  return { user, loaded, refresh, ensureLoaded, login, logout, isAuthenticated, isAdmin }
}
