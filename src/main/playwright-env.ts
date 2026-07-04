import { app } from 'electron'

// MUST run before any `import ... from 'playwright'`. Playwright-core resolves its
// browsers-registry directory at MODULE IMPORT time (not at launch), so this env
// has to be set before the first playwright import is evaluated — hence this is a
// side-effect module imported on the very first line of the main entrypoint.
//
// In a packaged build Chromium is bundled under playwright-core/.local-browsers
// (installed with PLAYWRIGHT_BROWSERS_PATH=0 at build time). Without this, runtime
// falls back to the empty %LOCALAPPDATA%\ms-playwright cache and every launch fails
// with "Executable doesn't exist". Dev keeps the normal cache.
if (app.isPackaged && !process.env['PLAYWRIGHT_BROWSERS_PATH']) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = '0'
}
