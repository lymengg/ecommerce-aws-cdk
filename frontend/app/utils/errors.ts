/**
 * Turns an API failure into something a shopper can read.
 *
 * The status codes are the ones the security rules produce: `401` when the request had no session,
 * `403` when the session exists but the account is not in the `admin` group, `400` when Bean
 * Validation rejected the body. The message never echoes the response body, so nothing internal is
 * surfaced.
 */
export function describeApiError(error: unknown): string {
  const status
    = (error as { statusCode?: number })?.statusCode ?? (error as { status?: number })?.status

  switch (status) {
    case 400:
      return 'The server rejected that input.'
    case 401:
      return 'You are not signed in.'
    case 403:
      return 'Your account is not in the admin group.'
    case 404:
      return 'Not found.'
    default:
      return 'Something went wrong. Please try again.'
  }
}
