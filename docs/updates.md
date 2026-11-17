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

## Running from a git checkout (npm run app)

Run from a clone with `npm run app`, the app keeps that clone up to date with `origin/main`
instead of using releases:

- **At start**, the splash fetches `origin/main` (8 s limit; offline, it just starts). If there
  are new commits it opens the update window and offers **Update and restart** or **Not now**.
- **The update window** (`src/shell/updatewindow.ts`, in the app's theme) has two tabs. *What's
  new* lists the commits, newest first, each tagged New, Fix, Improved, Docs or Tests from its
  subject, with its author, age and size; click one for its full message and its files, and a
  file for that commit's diff. *Files changed* lists every file the update touches, by folder,
  beside a diff viewer (line numbers, the changed words within a line marked). It says when
  `npm install` will run, when the check could not reach GitHub, and when the checkout cannot be
  updated automatically. Enter updates, Escape is Later.
- **While it runs**, it checks every 5 minutes and asks the same way. **Later** is remembered
  for those commits: it asks again only once `main` has moved on. **File › Check for Updates…**
  checks now.
- **Updating** quits the app, which stops the hub so the session file is complete, then
  `scripts/update-and-restart.mjs` (on your normal `node`) waits for it to exit, runs
  `git pull --ff-only origin main`, runs `npm install` if `package.json` or `package-lock.json`
  changed, and starts the app again the way `npm run app` does: the build, then Electron. It
  runs those two itself rather than through npm, so no terminal window opens beside the app
  (on Windows, npm goes through `cmd.exe`, which would open a console that stays open as long as
  the app runs). The build's output goes to `git-update.log`. On Windows the wait matters,
  because a running Electron keeps its own files locked.
- **If it fails** (a pull that cannot fast-forward, an `npm install` error, a new version that
  does not build), the version that was there starts again and says why. The full output is in `git-update.log` in the user data
  folder.

It does not update a clone that is on another branch, has commits of its own that `main` does
not, or has uncommitted changes to tracked files (untracked files are fine). It says so once per
new `main` and leaves the pull to you. `git fetch` runs without prompting for a password, so a
remote that needs one in a terminal fails the check (it is logged in `shell.log`); a credential
manager, as Git for Windows sets up, works.

After a restart the app is no longer attached to the terminal you started it from.

Set `DEBUG_HUB_GIT_UPDATES=0` to turn this off for a run, and `DEBUG_HUB_GIT_UPDATE_MINUTES` to
change the interval.

## Trying it locally

```
npm run app                                   # run the desktop app from source (git updates, no release check)
DEBUG_HUB_UPDATE_URL=http://127.0.0.1:8000/latest.json npm run app   # against a local feed
```

`npm run release:assets` writes the feed files to `release/`. Set `DEBUG_HUB_USER_DATA` to keep
a test run away from your real settings.
