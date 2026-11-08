# Signed releases and in-app updates

Startup checks read version metadata only. On Windows x64, the user chooses **Download update**, waits for the in-app transfer and verification, then separately chooses **Install now** and confirms closing the workspace. No installer bytes or installation start from a background version check.

Packaged builds use `https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest`. Stable numeric tags supply the version; draft and prerelease responses are rejected. In-app downloads require exactly one matching Windows installer named `SSH.Heaven.Setup.X.Y.Z.exe` or its spaces variant, a positive asset ID, uploaded state, published size up to 1 GiB, SHA-256 digest, and an exact download URL under the same repository/version. No GitHub token is embedded. Missing or invalid installer metadata falls back to opening the fixed public release page after a click.

Local development skips release initialization and makes no update requests. `npm run dist:win` creates an unsigned installer with the current update workflow. Versions 0.8.1–0.9.0 only open the release page; install the current release manually once to gain in-app downloading. Earlier builds need that manual upgrade too.

## Preparing a signed Windows release

1. Set `SSH_HEAVEN_PUBLISHER` to the exact publisher name in your signing certificate.
2. Provide the certificate through the standard electron-builder `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` environment variables (or `CSC_LINK` / `CSC_KEY_PASSWORD`). For a certificate in the Windows certificate store, set `SSH_HEAVEN_CERTIFICATE_SUBJECT` instead. Keep credentials in the build environment; never commit them.
3. Leave `SSH_HEAVEN_UPDATE_URL` and `SSH_HEAVEN_DOWNLOAD_URL` unset to retain the tracked GitHub provider. To use custom hosting instead, set both: a direct JSON version manifest URL and a human-readable download page. Both must use HTTPS without credentials, query parameters, or fragments. The custom provider uses the manifest format below.
4. Run `npm run typecheck`, `npm test`, then `npm run dist:win:signed` on Windows. Signing is required to succeed. Custom URLs temporarily override the tracked configuration, which is restored afterward. Custom hosting also writes `release/version.json`. The script does not upload or publish anything.
5. Verify the executable and installer signatures and run `npm run test:packaged`. Publish a stable `vX.Y.Z` GitHub Release with the installer and checksum file and mark it latest. The API supplies version metadata automatically; no separate GitHub version manifest is needed. With custom hosting, publish the installer on its download page and upload `version.json` to the configured manifest URL.

For custom hosting, set `provider` to `manifest` in the build configuration. The JSON manifest contains only a stable semantic version:

```json
{ "version": "0.11.0" }
```

Version checks run about five seconds after startup and through **Check for updates**, without host inventory, credentials, or personal settings. Metadata requests have an eight-second timeout and 64 KiB cap and do not follow redirects. Installer transfers allow at most five HTTPS redirects to the exact approved GitHub release CDN hosts, use a 30-second connection inactivity timeout and ten-minute overall limit, and never send credentials. Bytes stream into exclusive cache files under application user data; expected size and SHA-256 must match before the atomic ready rename. Cancellation removes only files created by that transfer. Cache identity and the complete file hash are checked again before and after workspace shutdown, immediately before execution.

**Install now** confirms that connections/transfers will close and unsaved drafts will be lost, then launches the verified NSIS file with `/S --updated --force-run`. The existing app ID/product name preserve normal installer upgrades and app data; the installer relaunches the updated app. Installer failures keep a retryable state. The UI tests intercept process launch and do not change the machine's installed application; validate a real installed-version upgrade separately. Custom manifest hosting retains the release-page fallback because it does not supply validated GitHub asset metadata.

Offline/rate-limit/download failures can be retried. A dismissed version remains hidden for the current run; a later version can show a notice. To disable update checks in a custom distribution, set `enabled` to `false` before packaging.

Keep app ID/product name stable and test an installed-version upgrade on a separate machine. Unsigned preview installers and checksum files are published on [GitHub Releases](https://github.com/hellokittypsycho/ssh-heaven/releases/latest). A signing certificate remains unconfigured; SHA-256 integrity checks do not replace publisher signing. macOS/Linux require separate distribution validation and currently use the release-page fallback.

## Verify suggestions in the previous release

Preserve the entire packaged `win-unpacked` directory from 0.8.1 before building over it. After publishing the new stable release and marking it latest, run:

```powershell
$env:SSH_HEAVEN_BASELINE_EXECUTABLE = 'C:\QA\ssh-heaven-0.8.1\SSH Heaven.exe'
npm run test:release-suggestion
```

This separate check starts the real 0.8.1 app with isolated temporary settings and a hidden offscreen window. Its startup request reads the live GitHub response and must offer the version in the current repository's `package.json`. The test records the browser-open request after a click; it does not open the user's browser, download an installer, or install anything. Keep it separate from `test:packaged`, which runs before publishing and uses controlled update responses.

For the live in-app download check, preserve the previous packaged runtime before building, then run the separate test after publishing. For the 0.11.1 release, use the published **0.11.0** runtime:

```powershell
$env:SSH_HEAVEN_BASELINE_VERSION = '0.11.0'
$env:SSH_HEAVEN_BASELINE_EXECUTABLE = 'C:\QA\ssh-heaven-0.11.0\SSH Heaven.exe'
npm run test:release-download
```

It uses the actual previous updater, public GitHub metadata and CDN, and an isolated temporary cache. It verifies that startup checks metadata only, then clicks **Download update** and compares the completed installer with the local release build. The test stops at **Install now** and prohibits process launch/browser opening; it never installs the update.

References: [GitHub latest release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release), [electron-builder Windows signing](https://www.electron.build/code-signing-win.html). Consult documentation matching the pinned builder version before upgrading release tooling.
