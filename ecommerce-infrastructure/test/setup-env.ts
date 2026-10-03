/**
 * Test environment setup, loaded by Jest before any test file (see `setupFiles` in jest.config.js).
 *
 * Every environment requires a delegated domain from Phase 4 on: `assertValidEnvironmentConfig`
 * refuses an authentication-enabled environment without a `dns` block, because the BFF's session
 * cookie is `Secure` and only works over HTTPS. (Production already required one from Phase 3.5.)
 * `lib/config` reads its environment variables once, when it is first imported - before any test
 * body runs - so the values have to exist before that import. Setting them here is what makes
 * `getEnvironmentConfig('dev' | 'uat' | 'prod')` valid for the suites that only care about sizing,
 * removal policies or tags.
 *
 * Tests that need to prove the missing-domain failure build their own configuration with `dns`
 * removed rather than depending on these variables, so the requirement is still exercised.
 */
process.env.ECOMMERCE_DEV_DOMAIN ??= 'dev.example.com';
process.env.ECOMMERCE_UAT_DOMAIN ??= 'uat.example.com';
process.env.ECOMMERCE_PROD_DOMAIN ??= 'prod.example.com';
