# Signed releases and update notifications

SSH Heaven only checks whether a newer version exists. It never downloads an installer, installs an update, or restarts the app automatically. An available-update notice opens a fixed download page in the user's browser; the user chooses when to download and install.

Packaged builds use the public GitHub Releases API configured in `build/release-config.json`: `https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest`. A stable `tag_name` such as `v0.8.1` supplies the version; draft and prerelease responses are rejected. Notices open the fixed page `https://github.com/hellokittypsycho/ssh-heaven/releases/latest` only after a click. Release-provided asset URLs and download destinations are ignored. No GitHub token is embedded or required.

Local development runs skip release initialization and make no update requests. `npm run dist:win` makes an unsigned Windows installer with GitHub suggestions enabled. Versions 0.8.0 and earlier need one manual upgrade to 0.8.1 or later to enable suggestions.

## Preparing a signed Windows release

1. Set `SSH_HEAVEN_PUBLISHER` to the exact publisher name in your signing certificate.
2. Provide the certificate through the standard electron-builder `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` environment variables (or `CSC_LINK` / `CSC_KEY_PASSWORD`). For a certificate in the Windows certificate store, set `SSH_HEAVEN_CERTIFICATE_SUBJECT` instead. Keep credentials in the build environment; never commit them.
3. Leave `SSH_HEAVEN_UPDATE_URL` and `SSH_HEAVEN_DOWNLOAD_URL` unset to retain the tracked GitHub provider. To use custom hosting instead, set both: a direct JSON version manifest URL and a human-readable download page. Both must use HTTPS without credentials, query parameters, or fragments. The custom provider uses the manifest format below.
4. Run `npm run typecheck`, `npm test`, then `npm run dist:win:signed` on Windows. Signing is required to succeed. Custom URLs temporarily override the tracked configuration, which is restored afterward. Custom hosting also writes `release/version.json`. The script does not upload or publish anything.
5. Verify the executable and installer signatures and run `npm run test:packaged`. Publish a stable `vX.Y.Z` GitHub Release with the installer and checksum file and mark it latest. The API supplies version metadata automatically; no separate GitHub version manifest is needed. With custom hosting, publish the installer on its download page and upload `version.json` to the configured manifest URL.

For custom hosting, set `provider` to `manifest` in the build configuration. The JSON manifest contains only a stable semantic version:

```json
{ "version": "0.8.1" }
```

Installed builds check once about five seconds after startup and when the user chooses **Check for updates**. No host inventory, credentials, or personal settings are sent. HTTPS requests have an eight-second timeout, a 64 KiB response limit, and do not follow redirects. Download links are fixed in the application build, not accepted from a remote response. Offline and GitHub rate-limit failures appear in Updates and can be retried manually. A dismissed version stays hidden for the current app run; a later version can show a new notice. Local development runs remain unconfigured. To disable notifications in a custom distribution, set `enabled` to `false` in its tracked release configuration before packaging.

Keep the app ID and product name stable across releases so the manually launched NSIS installer recognizes the existing app. Test an installed-version upgrade on a separate machine before public rollout. Unsigned Windows preview installers are published on [GitHub Releases](https://github.com/hellokittypsycho/ssh-heaven/releases/latest), with a SHA-256 checksum file. Update suggestions are enabled; a signing certificate remains unconfigured. macOS and Linux require their own distribution validation.

References: [GitHub latest release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release), [electron-builder Windows signing](https://www.electron.build/code-signing-win.html). Consult documentation matching the pinned builder version before upgrading release tooling.
