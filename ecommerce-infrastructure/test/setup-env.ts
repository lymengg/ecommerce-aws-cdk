/**
 * Test environment setup, loaded by Jest before any test file (see `setupFiles` in jest.config.js).
 *
 * The production configuration requires a delegated domain (Phase 3.5): `assertValidEnvironmentConfig`
 * refuses a production environment without a `dns` block. `lib/config` reads its environment variables
 * once, when it is first imported - before any test body runs - so the value has to exist before that
 * import. Setting it here is what makes `getEnvironmentConfig('prod')` valid for the suites that only
 * care about production sizing, removal policies or tags.
 *
 * Tests that need to prove the missing-domain failure build their own configuration with `dns`
 * removed rather than depending on this variable, so the requirement is still exercised.
 */
process.env.ECOMMERCE_PROD_DOMAIN ??= 'prod.example.com';
