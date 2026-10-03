import { defineConfig } from 'vitest/config'

/**
 * Unit tests for the storefront's pure logic: the cart store and the formatting/error helpers.
 *
 * These deliberately run in a plain Node environment rather than a Nuxt one. The modules under test
 * import Vue and Pinia explicitly (not through Nuxt auto-imports), so they can be exercised without
 * booting a Nuxt runtime. The components and composables that do depend on Nuxt are covered by the
 * type checker and by the manual browser flow described in the README.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
})
