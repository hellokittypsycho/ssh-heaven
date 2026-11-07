# Signed releases and update notifications

SSH Heaven only checks whether a newer version exists. It never downloads an installer, installs an update, or restarts the app automatically. An available-update notice opens a fixed download page in the user's browser; the user chooses when to download and install.

Development builds have no release URLs and make no update requests. Their Updates tab explains that notifications are unconfigured. `npm run dist:win` continues to make an unsigned local preview installer.

## Preparing a signed Windows release

1. Set `SSH_HEAVEN_PUBLISHER` to the exact publisher name in your signing certificate.
2. Provide the certificate through the standard electron-builder `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` environment variables (or `CSC_LINK` / `CSC_KEY_PASSWORD`). For a certificate in the Windows certificate store, set `SSH_HEAVEN_CERTIFICATE_SUBJECT` instead. Keep credentials in the build environment; never commit them.
3. Optionally set both `SSH_HEAVEN_UPDATE_URL` (the direct URL of a JSON version manifest, e.g. `https://downloads.example.com/ssh-heaven/version.json`) and `SSH_HEAVEN_DOWNLOAD_URL` (a human-readable releases/download page). Both must use HTTPS without credentials, query parameters, or fragments. Leave both unset to build without update checks.
4. Run `npm run typecheck`, `npm test`, then `npm run dist:win:signed` on Windows. Signing is required to succeed. The script temporarily embeds the fixed URLs, restores the development configuration afterward, and writes `release/version.json`. It does not upload or publish anything.
5. Verify the executable and installer signatures and run `npm run test:packaged`. Publish the installer on the download page, then upload `version.json` to the configured manifest URL.

The manifest contains only a stable semantic version:

```json
{ "version": "0.5.0" }
```

Configured builds check once shortly after startup and when the user chooses **Check for updates**. No host inventory, credentials, or personal settings are sent. Requests have an eight-second timeout, a 16 KiB size limit, and do not follow redirects. Download links are fixed in the application build, not accepted from the remote manifest.

Keep the app ID and product name stable across releases so the manually launched NSIS installer recognizes the existing app. Test an installed-version upgrade on a separate machine before public rollout. This project currently has no signing certificate or hosted release, so live notification and signed installer verification remains a release setup step. macOS and Linux require their own distribution validation.

Reference: [electron-builder Windows signing](https://www.electron.build/code-signing-win.html). Consult documentation matching the pinned builder version before upgrading release tooling.
