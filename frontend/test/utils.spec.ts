import { describe, expect, it } from 'vitest'

import { describeApiError } from '../app/utils/errors'
import { formatMoney } from '../app/utils/money'

describe('formatMoney', () => {
  it('formats an amount as US currency', () => {
    expect(formatMoney(1200)).toBe('$1,200.00')
    expect(formatMoney(9.99)).toBe('$9.99')
    expect(formatMoney(0)).toBe('$0.00')
  })
})

describe('describeApiError', () => {
  it('explains the status codes the security rules produce', () => {
    expect(describeApiError({ statusCode: 401 })).toMatch(/not signed in/i)
    expect(describeApiError({ statusCode: 403 })).toMatch(/admin/i)
    expect(describeApiError({ statusCode: 400 })).toMatch(/rejected/i)
    expect(describeApiError({ statusCode: 404 })).toMatch(/not found/i)
  })

  it('falls back to a generic message, never the response body', () => {
    expect(describeApiError({ statusCode: 500, data: { secret: 'leak' } })).toBe(
      'Something went wrong. Please try again.',
    )
    expect(describeApiError(undefined)).toBe('Something went wrong. Please try again.')
  })
})
