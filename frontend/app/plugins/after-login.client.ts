/**
 * Completes the login round trip: if the user asked for a page before signing in, send them there.
 *
 * Runs once, when the app mounts. On a fresh visit there is nothing remembered and this does
 * nothing; after a login the SPA has just been reloaded, the session is in place, and the remembered
 * path (if any) is where the user actually wanted to go.
 */
export default defineNuxtPlugin(() => {
  const path = takeRedirect()
  if (path === null) {
    return
  }

  const route = useRoute()
  if (route.fullPath !== path) {
    void navigateTo(path, { replace: true })
  }
})
