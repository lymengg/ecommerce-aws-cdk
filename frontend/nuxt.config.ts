// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({

  modules: ['@nuxt/ui', '@pinia/nuxt', '@nuxt/eslint'],

  // The Backend for Frontend pattern: the Spring API is the OAuth client and holds the tokens, and
  // the browser only ever gets an httpOnly session cookie. That only works if this app runs in the
  // browser - a Nuxt SSR server would never receive the API-scoped session cookie - so the app is a
  // client-only SPA, generated to static assets and served from CloudFront.
  ssr: false,

  devtools: { enabled: false },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Ecommerce',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Ecommerce storefront' },
        { name: 'referrer', content: 'strict-origin-when-cross-origin' },
      ],
    },
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      // Base URL of the Spring API, used only where the api.<apex> convention cannot apply: local
      // development. Served deployments derive it from the host instead (see useApi), which is what
      // keeps the built image environment-agnostic.
      apiBaseUrl: 'http://localhost:8080',
      // Where the API starts the authorization code flow. A top-level navigation, not a fetch: the
      // browser has to visit Cognito's hosted UI.
      oauthAuthorizationPath: '/oauth2/authorization/cognito',
    },
  },
  compatibilityDate: '2026-10-01',

  // Strict TypeScript everywhere; the API contract is typed by hand in app/types/api.ts.
  typescript: {
    strict: true,
    typeCheck: false,
  },

  eslint: {
    config: {
      stylistic: {
        indent: 2,
        quotes: 'single',
        semi: false,
      },
    },
  },
})
