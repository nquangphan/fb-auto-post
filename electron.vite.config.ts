import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Native + heavy Node modules must stay external (not bundled by Rollup) in the
// main process: better-sqlite3 is a native addon, playwright spawns browsers.
const mainExternals = ['better-sqlite3', 'playwright', 'playwright-core']

// Strict CSP for the PACKAGED app only (file:// load reliably honours a meta tag).
// Dev is left CSP-free so Vite HMR works; the dev renderer only loads localhost.
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"

function injectProdCsp(): Plugin {
  return {
    name: 'inject-prod-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />\n  </head>`
      )
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { external: mainExternals }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    build: {
      rollupOptions: { external: mainExternals }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    plugins: [react(), injectProdCsp()]
  }
})
