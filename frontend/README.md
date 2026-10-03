# E-commerce Storefront

The browser frontend for the e-commerce platform: a **Nuxt 4 single-page application** that talks to
the Spring Boot API, and nothing else. It is built to static assets and served by **nginx as a
second Fargate service behind the platform's load balancer** (`ecommerce-frontend-<env>`), on the
apex of the delegated subdomain - so the storefront and the API are two hosts under one registrable
domain, which is what makes the BFF's session cookie work.

---

## Why a client-only SPA, and why no tokens

The platform uses the **Backend for Frontend** pattern: the Spring API is the OAuth client, and the
browser only ever holds an `httpOnly` session cookie.

That is exactly why this app runs with **`ssr: false`**. A Nuxt SSR server would render pages on the
server, but the session cookie is scoped to `api.<env-domain>` and `httpOnly`, so that server would
never receive it and could not make authenticated calls. Making SSR work would mean turning Nuxt into
the BFF itself - re-architecting what Phase 4 deliberately built. So the app is a plain client-side
SPA: the browser calls the API directly, with the session cookie, exactly as the BFF expects.

There is **no token in the browser**, in memory, in `localStorage` or anywhere else. The only state
the client keeps is the cart, which holds product ids, names and prices - nothing sensitive.

## Authentication and CSRF, in one picture

```
  browser (this app)                     Spring API (the BFF)               Cognito
  ──────────────────                     ────────────────────               ───────
  Sign in ── top-level navigation ──▶  /oauth2/authorization/cognito ──▶  hosted UI (PKCE, S256)
                                       exchange code, create session
       ◀──────────────── 302 to the SPA (FRONTEND_URL) + httpOnly cookie ──
  GET /me ──────────────────────────▶   reads the session cookie ──▶ { name, authorities }
  GET /csrf ────────────────────────▶   { headerName, parameterName, token }
  POST /api/products ───────────────▶   session cookie + X-XSRF-TOKEN header
       (credentials: 'include')          CSRF ok, ROLE_admin ok ──▶ 201
  Sign out ── form POST (CSRF field) ──▶ /logout ──▶ Cognito /logout?client_id&logout_uri ──▶ SPA
```

Three details make the cross-origin case work, and they are all in `app/composables/`:

- **`credentials: 'include'`** on every call, or the browser would not attach the session cookie.
- **`GET /csrf`** returns the token, because the double-submit cookie Spring writes is scoped to the
  API host and is unreadable from the SPA's origin. One token, two places to put it: the header on a
  `fetch` write, the form field on the logout navigation. The server decodes either.
- **Login and logout are navigations, not `fetch`**, because both end in a redirect to Cognito. Login
  remembers the page you were on and returns you there.

The token is fetched once per page load and cached (`app/composables/useApi.ts`). That is safe
because Spring rotates it only when the session changes - on login and on logout - and both of those
are full navigations that reload the app.

## Structure

```
frontend/
├── app/
│   ├── app.vue                 # UApp root
│   ├── assets/css/main.css     # Tailwind + Nuxt UI
│   ├── components/             # AppHeader, ProductCard
│   ├── composables/
│   │   ├── useApi.ts           # the only place that talks to the API (credentials + CSRF)
│   │   └── useAuth.ts          # session, login, logout, isAdmin
│   ├── layouts/default.vue
│   ├── pages/
│   │   ├── index.vue           # catalog: search + sort
│   │   ├── products/[id].vue   # product detail
│   │   ├── cart.vue            # cart (client-side)
│   │   ├── checkout.vue        # UI-only until Phase 5 wires orders
│   │   ├── account.vue         # /me: name + authorities
│   │   └── admin/products.vue  # admin create (surfaced only for ROLE_admin; the API enforces it)
│   ├── stores/cart.ts          # Pinia, persisted to localStorage
│   ├── types/api.ts            # the API contract, typed by hand
│   └── utils/                  # money + error formatting
├── test/                       # Vitest: cart store, helpers, redirect guard
├── Dockerfile                  # node build stage -> nginx-unprivileged runtime stage
├── nginx.conf.template         # SPA fallback, cache rules, security headers (envsubst at start)
├── scripts/csp-hashes.mjs      # build-time script-src hashes for the app shell's inline scripts
├── nuxt.config.ts
└── scripts/deploy.sh           # docker build -> ECR push -> roll the ECS service
```

## Running it locally

```bash
cp .env.example .env      # NUXT_PUBLIC_API_BASE_URL=http://localhost:8080
npm install
npm run dev               # http://localhost:5173
```

The dev server talks to the API on `http://localhost:8080` **cross-origin**, exactly like production
(apex -> `api.<env-domain>`), so the CORS and cookie behaviour being tested locally is the real
thing. `http://localhost:5173` is already on the dev environment's CORS allowlist.

Run the API with `FRONTEND_URL=http://localhost:5173` (and `SESSION_COOKIE_SECURE=false`) so that
login and logout return to the dev server - see the infrastructure README.

## Security posture

- **No tokens in the browser** (OWASP A04): the session cookie is `httpOnly`, `Secure`,
  `SameSite=Lax` and `__Host-`-prefixed, and is not readable by script.
- **CSRF** double-submit on every unsafe request; the token is never put in a URL.
- **No open redirect** after login: the remembered path is honoured only if it is a same-origin
  absolute path (`app/utils/redirect.ts`), which is unit-tested.
- **No `v-html`** anywhere: Vue escapes interpolation, so product text cannot inject markup (A03).
- **Content Security Policy** and the other security headers are set by nginx
  (`nginx.conf.template`): `default-src 'self'`, the API as the only `connect-src`,
  `frame-ancestors 'none'`, plus `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy`. HSTS is set on the load balancer listener, so it also covers the port 80
  redirect nginx never sees.
- **`script-src` is hash-based, never `'unsafe-inline'`.** Nuxt writes three inline scripts into the
  app shell — the import map, the colour-mode bootstrap and the runtime config — and a strict
  `script-src 'self'` blocks all three. `scripts/csp-hashes.mjs` hashes each of them during the
  Docker build and writes the allowlist to `/etc/nginx/script-hashes.conf`, which nginx includes. It
  has to be build-time: the import map names the hashed entry chunk and the runtime config carries
  the build id, so both change on every build. The JSON payload is skipped deliberately — a data
  block is never executed, so `script-src` does not apply to it, and hashing it would add a
  different hash for every prerendered route.
- **The API is the authority.** The UI hides the admin page from non-admins, but every write is
  still checked server side by claim - hiding a button is never the control.

## Deploying

```bash
ECOMMERCE_DEV_DOMAIN=dev.example.com ./scripts/deploy.sh dev
```

The script resolves the repository, cluster and service from the CDK exports, builds the image with
`NUXT_PUBLIC_API_BASE_URL=https://api.<domain>` baked in, pushes it to ECR and rolls the ECS
service. Hashed assets are served with a one-year cache; `index.html` is `no-cache`, so a deploy is
visible immediately.

Equivalent by hand:

```bash
docker build --build-arg NUXT_PUBLIC_API_BASE_URL=https://api.dev.example.com -t ecommerce-frontend:v0.1.0 .
docker tag ecommerce-frontend:v0.1.0 <repository-uri>:v0.1.0
docker push <repository-uri>:v0.1.0
aws ecs update-service --cluster <cluster> --service ecommerce-dev-frontend --force-new-deployment
```

## Testing

```bash
npm run typecheck   # nuxt typecheck (vue-tsc)
npm run lint        # eslint
npm test            # vitest: cart store, formatting/error helpers, redirect guard
npm run generate    # the production build (the SPA output in .output/public)
```

The full OAuth round trip is a **manual** check this phase (sign in, add to cart, create a product
as an admin, sign out) - there is no browser automation yet. That belongs in Phase 8 with the
pipeline, alongside `npm audit` in CI: the current advisories are in the Nuxt build toolchain
(`esbuild`'s dev server, `braces`, `node-forge`), not in anything shipped to the browser.

## Deliberate deferrals

- **Access-token refresh.** The BFF holds the token but never calls a downstream API with it yet, so
  there is nothing to refresh. When Phase 5 has the API act on the user's behalf, it needs an
  `OAuth2AuthorizedClientManager` wired to refresh before expiry.
- **Shared session store.** Sessions are in memory, which is why the CDK validator pins the service
  to a single task. Spring Session + Redis is Phase 6.
- **Local HTTP cookies.** `__Host-SESSION` requires `Secure`; local development over plain HTTP sets
  `SESSION_COOKIE_NAME=SESSION` and `SESSION_COOKIE_SECURE=false` (see the infrastructure README).
