# Packaging & Distribution

The app ships as a **one-click NSIS installer** for Windows built with
`electron-builder`. Config lives in [`electron-builder.yml`](../electron-builder.yml).

## Build (run on Windows)

The installer must be built on a **Windows** machine (NSIS + native-module rebuild
target Windows). From a clean checkout:

```powershell
npm install
npm run dist:win
```

`dist:win` does three things:

1. `bundle:chromium` — installs Playwright's Chromium **into the package** via
   `PLAYWRIGHT_BROWSERS_PATH=0` (browser lands in
   `node_modules/playwright-core/.local-browsers`), so the installer is
   self-contained and the client never runs `playwright install`.
2. `build` — `electron-vite build` → `out/` (main + preload + renderer).
3. `electron-builder --win` → `dist/FB Auto-Post-Setup-<version>.exe`.

Output: `dist/FB Auto-Post-Setup-<version>.exe` (~150–200 MB, bundled Chromium).

## What gets unpacked from asar

Native/binary deps can't run from inside the asar archive, so `asarUnpack` ships
them unpacked:

- `better-sqlite3` — native `.node` addon (the DB).
- `playwright` / `playwright-core` — spawns the bundled Chromium (incl.
  `.local-browsers`).

If the packaged app crashes on launch with a "cannot find module" / native-bind
error, the unpack globs in `electron-builder.yml` are the first place to check.

## Native rebuild

`better-sqlite3` is compiled for the bundled Electron ABI. `electron-builder`
runs `install-app-deps` automatically during packaging. For local dev,
`predev`/`prestart` run `electron-rebuild` against the dev Electron.

## Updates — NO auto-updater (decision)

`electron-updater` is **deliberately not included** (Red Team C1: unsigned
auto-update is an unauthenticated code-execution channel with no rollback on a
machine holding plaintext credentials, and is unjustified for a single-client
install). **To update: build a newer installer and run it** — NSIS upgrades in
place. `deleteAppDataOnUninstall: false` preserves the DB, browser profiles, and
content folder across reinstalls.

## Code-signing — unsigned for v1 (decision)

The build is unsigned, so Windows SmartScreen shows a one-time **"Unknown
publisher → More info → Run anyway"** prompt on first launch. This is a single
click on the client's own machine.

To sign later (removes the prompt; ~a few hundred $/yr for an OV/EV cert): add to
the `win:` block in `electron-builder.yml`:

```yaml
win:
  certificateFile: path/to/cert.pfx
  certificatePassword: ${env.CSC_KEY_PASSWORD}
```

## Optional: app icon

Drop `build/icon.ico` (256×256) to brand the installer and the app. Without it,
electron-builder uses a default Electron icon.

## First-run notes for the client

- The machine must **stay on** for scheduled posts (auto-posting is opt-in in
  Settings → Auto-posting; off by default).
- All data is local: SQLite DB, per-account browser profiles, and the content
  folder live under the app's `userData` directory.
- Validate the anti-ban approach on **one throwaway account for a few days**
  before onboarding all 10 (Red Team C4).
