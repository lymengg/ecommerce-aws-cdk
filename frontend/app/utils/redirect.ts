/**
 * Remembers the page the user was heading for when they chose to sign in, so the OAuth round trip
 * can return them there instead of dumping them on the home page.
 *
 * `sessionStorage` is the right store: it survives the navigation to Cognito and back, and it dies
 * with the tab. Nothing sensitive is kept - only a path.
 */
const REDIRECT_KEY = 'ecommerce.redirect'

/**
 * Only same-origin absolute paths are ever honoured. Rejecting anything else (`https://evil.example`,
 * protocol-relative `//evil.example`) is what keeps a tampered storage value from turning the
 * post-login redirect into an open redirect.
 */
export function isSafeRedirect(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//')
}

/** Records where to return after login. Ignored if the path is not a safe, same-origin path. */
export function rememberRedirect(path: string): void {
  if (!import.meta.client || !isSafeRedirect(path)) {
    return
  }
  window.sessionStorage.setItem(REDIRECT_KEY, path)
}

/** Returns the remembered path once, then forgets it. */
export function takeRedirect(): string | null {
  if (!import.meta.client) {
    return null
  }
  const path = window.sessionStorage.getItem(REDIRECT_KEY)
  window.sessionStorage.removeItem(REDIRECT_KEY)
  return path !== null && isSafeRedirect(path) ? path : null
}
