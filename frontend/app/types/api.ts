/**
 * The Spring API's contract, typed by hand.
 *
 * These mirror the server DTOs exactly. They are deliberately the only place the wire shape is
 * written down, so a change on the server is a change here and the compiler points at every use.
 */

/** A product as returned by `GET /api/products` and `GET /api/products/{id}`. */
export interface Product {
  readonly id: number
  readonly name: string
  readonly description: string | null
  readonly price: number
  readonly quantity: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** The body of `POST /api/products`. */
export interface ProductInput {
  name: string
  description?: string | null
  price: number
  quantity?: number
}

/** The body of `GET /me`: who the session belongs to, and what the API says they may do. */
export interface CurrentUser {
  readonly name: string
  readonly authorities: readonly string[]
}

/**
 * The body of `GET /csrf`.
 *
 * One token, two places to put it: the header named `headerName` on a `fetch` write, or a form field
 * named `parameterName` on the logout navigation (a navigation cannot set a header). The server
 * decodes either back to the same value, so the SPA never has to know how it is stored.
 */
export interface CsrfToken {
  readonly headerName: string
  readonly parameterName: string
  readonly token: string
}
