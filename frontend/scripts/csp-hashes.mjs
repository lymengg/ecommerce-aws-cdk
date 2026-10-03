#!/usr/bin/env node
//
// Emits the `script-src` hash sources for every inline script in the built app shell.
//
// A strict `script-src 'self'` blocks the three inline scripts Nuxt writes into index.html: the
// import map, the colour-mode bootstrap and the runtime config. A hash is the right allowance for a
// static file: unlike `'unsafe-inline'` it keeps the policy meaningful, and unlike a nonce it does
// not require the response to be uncached.
//
// The hashes have to be computed here, at build time, because two of the scripts change on every
// build - the import map names the hashed entry chunk, and the runtime config carries the build id
// and the API base URL. Every prerendered shell in the output is scanned, since nginx may serve any
// of them.
//
// Usage: node scripts/csp-hashes.mjs <output-directory>
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Script types the browser never executes, so CSP does not apply to them.
 *
 * The important one is `application/json`: Nuxt's `__NUXT_DATA__` payload is a data block, and it is
 * per-shell (it carries a prerender timestamp), so hashing it would add a different hash for every
 * route. Skipping it is what makes one policy cover every shell - and it is correct, because a data
 * block is never prepared for execution, which is the point at which `script-src` is consulted.
 */
const NON_EXECUTABLE_TYPES = new Set(['application/json', 'application/ld+json', 'text/template'])

const [root = '.output/public'] = process.argv.slice(2)

function htmlFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      return htmlFiles(path)
    }
    return path.endsWith('.html') ? [path] : []
  })
}

const hashes = new Set()

for (const file of htmlFiles(root)) {
  const html = readFileSync(file, 'utf8')

  for (const [, attributes, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    // An external script is allowed by 'self'; it needs no hash.
    if (/\ssrc=/.test(attributes)) {
      continue
    }

    const type = /type="([^"]*)"/.exec(attributes)?.[1]
    if (type !== undefined && NON_EXECUTABLE_TYPES.has(type)) {
      continue
    }

    // The browser hashes the script element's exact text content, so no normalisation happens here.
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
}

if (hashes.size === 0) {
  // Silence here would mean the policy allows nothing and the app cannot boot, so fail the build
  // rather than ship a broken site.
  throw new Error(`No inline scripts found under ${root}; refusing to emit an empty script-src allowlist.`)
}

// An nginx `set` directive, included by the server block. The value is wrapped in double quotes so
// the spaces between hashes do not split it into extra arguments - `set` takes exactly two, and nginx
// refuses to start otherwise. Nothing here is an environment variable name, so envsubst leaves it
// alone when the config template is rendered.
process.stdout.write(`set $csp_script_hashes "${[...hashes].sort().join(' ')}";\n`)
