import { describe, expect, it } from 'vitest'

import { isSafeRedirect } from '../app/utils/redirect'

describe('isSafeRedirect', () => {
  it('accepts same-origin absolute paths', () => {
    expect(isSafeRedirect('/')).toBe(true)
    expect(isSafeRedirect('/cart')).toBe(true)
    expect(isSafeRedirect('/products/12?from=cart#reviews')).toBe(true)
  })

  it('rejects anything that could turn the post-login redirect into an open redirect', () => {
    for (const unsafe of ['https://evil.example', 'http://evil.example/cart', '//evil.example', 'cart', '', 'javascript:alert(1)']) {
      expect(isSafeRedirect(unsafe)).toBe(false)
    }
  })
})
