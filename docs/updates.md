# Desktop app and auto-update

## How it works

The desktop app has two parts, the way Discord's does.

- **Shell** (`src/shell`). Installed once per computer from the Windows installer or the macOS `.dmg`. It shows the splash
  screen, runs the updater and nothing else. It does not update itself.
- **Payload** (`src/desktop`, `src/server`, `src/ui`). The hub, its UI, the main window and
  the menus, packed into one file of under 100 kB. This is what updates.

On every launch the shell:

1. Shows the splash and fetches `releases/latest/download/latest.json` from GitHub.
2. If that names a newer version, downloads the payload, checks its size and SHA-256, and
   unpacks it into `<user data>/payload/<version>/`.
3. Starts the newest runnable payload and closes the splash when the main window is ready.

The installed app is never modified. On Windows that means no installer re-run and no
administrator prompt on update; on macOS the ad-hoc signature stays valid, so no Apple
Developer ID is needed (the constraint that ruled out Electron's built-in updater in
GooseFluence). Offline, or if GitHub is slow (6 s limit), the app starts with what it has.

**Rollback.** The previous version is kept. If a new payload throws while starting, it is
marked bad, never downloaded again, and the previous version starts instead. Publish a higher
version to move past it.

User data lives in `%APPDATA%\Debug Hub\` on Windows and
`~/Library/Application Support/Debug Hub/` on macOS: `debug-hub.config.json`, `sessions/`,
`payload/` and `shell.log` (the update history). Uninstalling keeps it.

## Releasing

1. Make the repository public (once). Installed apps fetch release assets without a token.
2. Commit, then tag and push:
   ```
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. `.github/workflows/release.yml` sets the version from the tag, runs the tests, and publishes
   a release with `latest.json` and the payload, then adds the Windows and macOS installers.

Every computer picks the new version up the next time the app is opened.

## First install on a computer

- **Windows.** Run `DebugHub-<version>-win-setup.exe` from the releases page. It installs for
  the current user only (under `%LOCALAPPDATA%\Programs`), with no administrator prompt. The
  installer is not code-signed, so SmartScreen shows "Windows protected your PC": choose
  More info, then Run anyway. This happens once per install, not on updates.
- **macOS.** Open the `.dmg`. As with GooseFluence, macOS asks for "Open Anyway" the first
  time because the app is not notarized.

Draft and pre-release releases are ignored, because GitHub's "latest" skips them.

## When the shell has to change

Changes under `src/shell`, or an Electron upgrade, do not reach installed apps. If a payload
needs such a change, raise `debugHub.minShell` in `package.json` and `SHELL_API` in
`src/shell/main.ts` together. Apps with an older shell keep running their current version and
show a prompt linking to the new installer.

## Trust

The payload is code that runs with your user's permissions, fetched over HTTPS from this
repository's releases. The checksum guards against corrupt downloads, not against someone who
can publish a release here: anyone with push access to tags can ship code to every install.

## Trying it locally

```
npm run app                                   # run the desktop app from source (no update check)
DEBUG_HUB_UPDATE_URL=http://127.0.0.1:8000/latest.json npm run app   # against a local feed
```

`npm run release:assets` writes the feed files to `release/`. Set `DEBUG_HUB_USER_DATA` to keep
a test run away from your real settings.
