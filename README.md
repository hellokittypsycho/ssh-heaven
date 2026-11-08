# SSH Heaven

A Windows-first desktop SSH terminal and SFTP workspace built with TypeScript, Electron, React, xterm.js, and ssh2.

[Download the latest Windows release](https://github.com/hellokittypsycho/ssh-heaven/releases/latest). Preview installers are unsigned. Updates offer in-app downloading and installation, each started by the user.

## Run locally

Install Node.js 24 LTS, then run:

```powershell
npm ci
npm run dev
```

Electron's desktop runtime downloads during installation. No running web server or account is needed for the installed application.

To run the production build:

```powershell
npm run build
npm start
```

## Features

- Modern workspace with eight persistent color presets: Graphite, Midnight, Ocean, Forest, Amethyst, Ember, Pink, and Daylight. Open **Appearance** using the palette icon or quick switcher. The UI, terminal, native light/dark appearance, and editor update live.
- Custom image or animated GIF wallpaper, with strength, blur, cover/contain, and animation controls in **Appearance**. Backgrounds are copied to this device's application data so moving the source file keeps your wallpaper. GIFs use a still frame when animation is disabled or the system requests reduced motion.
- Custom themed title bar and window border, with native Windows caption controls, dragging from the title bar and empty workspace header/tab areas, resizing, and maximize behavior.
- Dedicated sidebar navigation for Home, Connect, Scripts, and Vault, with a persistent collapsed mode for more terminal space. SSH sessions have their own scrollable strip and a searchable **All sessions** list.
- Home screen with recently accessed hosts, connection timestamps, and clearable local history.
- Give hosts memorable nicknames, and edit them from Home or the host library.
- Saved host profiles with groups, favorites, color labels, six icon styles, notes, search, editing, and removal.
- Bulk host import with a masked preview, duplicate detection, optional group, encrypted passwords, or one shared SSH key.
- Reviewed commands across a named group, with separate per-server output, exit status, timeouts, and cancellation.
- Keyboard command palette for finding hosts and actions, plus session switching and guarded session closing.
- Password, private key, and system SSH-agent authentication, including encrypted-key passphrases. Agent forwarding stays disabled.
- Remembered server passwords protected by OS encryption, enabled by default with an opt-out and Forget action. New connections use `root` when the username is empty. SSH connections reuse passwords in the main process; explicit password reveals are available only inside the unlocked vault manager.
- Vault manager for server passwords and named SSH keys, available after setting a five-digit PIN. Quick connect remains available while management is locked.
- One-click **Quick connect** for hosts with saved passwords from the host sidebar, recent hosts, or quick switcher. Failed saved passwords reopen the connection form for correction; successful connections preserve your unfinished form draft.
- Multiple SSH terminal sessions with resizing, ANSI colors, scrollback, and copy/paste. Pin, reorder by drag or keyboard-accessible actions, duplicate connections, and reopen recently closed sessions.
- Responsive terminal input with immediate server-driven echo and bounded output batching, plus exactly-once keyboard/native paste handling.
- Stream mode masks recognized IPv4/IPv6 addresses and up to 50 custom literal text rules in terminal output/history, app labels, editors, copies, and exports. Toggle it from the header or with **Ctrl+Shift+S**; the adjacent settings button edits rules.
- Scripts tab with a searchable saved library, shell syntax highlighting, draft preservation, connected-terminal selection, and reviewed one-time execution in the visible terminal. Run results show exit status and duration, with optional completion notifications.
- Tabs, two-pane splits, and four-pane grids with pane reordering, plus named saved workspaces and explicit connection on restore.
- Workspace library for named SSH keys, group defaults, reusable commands with quoted variables, and encrypted portable backups.
- Linux server dashboard for CPU, memory, root filesystem usage, uptime, and OS details over an existing SSH session.
- Saved local/remote SSH forwarding rules and jump-host routes with verification for every hop.
- Optional reconnect with bounded backoff and opt-in `tmux` sessions for persistent remote shells.
- Optional local MCP server for external AI clients, with copyable client configuration and in-app review for commands and file edits.
- GitHub update suggestions at startup, with in-app **Download update**, progress/cancel/retry, SHA-256 verification, and an explicit **Install now** action after the download is ready.
- Search terminal output with match highlighting, case matching, and next/previous results; adjust and remember terminal font size.
- Explicit server fingerprint verification, with remembered fingerprints and a warning when a key changes.
- Resizable SFTP browser with per-host folder bookmarks, remembered last folders, folder history, breadcrumbs, file filtering, sorting, hidden files, and multi-selection. File properties show timestamps, size, owner IDs, and an editable permission matrix/octal mode.
- Upload/download queues with byte progress, speed/ETA, pause/resume, queued-job reordering, a shared bandwidth cap, transfer history, and cancellation; download several selected files to one folder.
- Recursive folder upload/download, file/folder drops from Explorer, and retry actions for failed or canceled transfers.
- Folder creation, renaming, and confirmed deletion of files or empty folders.
- Native file dialogs and overwrite confirmation for transfers.
- Local SSH key generation: Ed25519 or RSA 3072-bit, required encryption password, automatic protected storage, public-key fingerprint/copy, and automatic key-library registration. PIN-gated public/private key viewing also requires the key password each time.
- Built-in remote text editor: retained document tabs across hosts, syntax highlighting, line numbers/folding, language selection, find/replace, Ctrl+S, reviewed before/after diffs, unsaved-change confirmation, and server-change conflict checks. Double-click a file or select it and click Edit.

For individual connections, **Remember password on this device** starts selected when secure storage is available. Uncheck it to opt out; passwords are saved only after successful authentication. Bulk import explicitly saves supplied passwords without connecting. The separate credential vault uses Electron's OS-backed encryption (Windows DPAPI); plaintext passwords are never written to host profiles. Connection APIs expose availability and profile IDs only; the PIN-gated manager can explicitly reveal one selected password. Saved credentials are bound to host, port, username, and authentication type and are invalidated when that identity changes or the profile is deleted. Linux plaintext `basic_text` storage is disabled. Key encryption passwords remain in memory and are not saved. Generated private keys are encrypted in the application's protected key folder; imported keys stay at their selected paths. Verify a new server fingerprint against a trusted source before accepting it.

## Workspace navigation

Use the sidebar for **Home**, **Connect**, **Scripts**, and **Vault**. **Connect** returns to your unfinished connection form; the **+** buttons or **Ctrl+Shift+N** start a fresh connection. The header's sidebar button switches between the host library and a compact icon rail, and remembers your choice on this device.

Use the header's **Back/Forward** buttons or **Alt+Left/Right** to revisit pages and terminals without reconnecting. Closed sessions are removed from navigation history. **Ctrl+1/2/3/4** jump to Home, Connect, Scripts, and Vault. Collapse individual host groups to keep a large library manageable; search temporarily shows matching hosts inside collapsed groups, and clearing search restores your choice.

**Ctrl+K** now searches open SSH sessions, saved hosts, and actions in one place. Open sessions appear first; the **Sessions**, **Hosts**, and **Actions** filters narrow the results. Choosing an open session reuses its terminal and history. The sidebar's **Updates** entry opens release status directly and keeps an indicator while a newer version is available, even after dismissing its banner.

Open SSH sessions appear in a separate strip. Tabs keep their width as more servers open; scroll with the arrow controls or choose **All sessions** to search by nickname, host, user, group, or status. Selecting a session brings its tab into view. **Ctrl+Tab / Ctrl+Shift+Tab** cycle through SSH sessions. With a tab focused, use **Left/Right**, **Home/End**, or **Delete** to navigate or close it. Switching pages keeps terminal history and connection/script drafts available.

## Vault, stream mode, and scripts

Open **Vault** in the sidebar and enable a five-digit PIN before managing passwords or SSH keys. The manager supports revealing, copying, replacing, setting, or forgetting a server password, plus naming, importing, generating, and removing SSH key entries. Removing an entry leaves the private key file in place. Revealed passwords hide after 30 seconds; native password copies clear after 30 seconds if the clipboard still contains that same value. Stream mode disables password reveals. Management locks after five minutes, on minimize, or when leaving Vault; quick connect and existing sessions continue. PIN verifiers and failed-attempt counters are protected by OS encryption, with persistent escalating lockouts. This device's PIN is separate from portable backup passphrases and is not exported.

Choose **View key** on a saved SSH key, then enter that key's encryption password. Both public-key text and decrypted private PEM are read-only, hide after 30 seconds, and clear on close, vault lock, leaving Vault, or enabling Stream mode. Every reveal requires the key password again. Unencrypted imported keys can still connect but cannot use this password-gated viewer until encrypted. The encrypted on-disk file is unchanged by viewing it.

**Stream mode** changes display only. Recognized IPv4 and IPv6 addresses are replaced with equal-width bullets in labels, tooltips, terminal output/scrollback, and code editors. Terminal selections/copies and editor clipboard output are sanitized. Sensitive text fields hide their glyphs, while native form values, connection endpoints, saved scripts, and transmitted commands keep their real contents. The terminal parses ANSI/cursor updates before masking, including wrapped addresses and alternate-screen applications. Custom rules match literal text, optionally case-sensitive; regular expressions are not executed. Rules apply to old scrollback too when edited. Stream mode does not infer arbitrary secrets or mask text inside wallpaper images.

Open **Scripts** to create or edit a shell script, save it, choose a connected terminal, and click **Run script** to review its target and contents. Confirmed scripts run once with `sh` in that terminal; their output and interactive input stay in the same session. Start at an idle shell prompt. Scripts execute in a child shell, so `exit`, shell options, and directory changes stay inside that script. Literal tabs, Unicode, quotes, and trailing newlines are retained; scripts support up to 32,768 characters and share the existing runbook library/backups. Runbook `{{variables}}` remain literal in the Scripts tab. Each managed run is tracked in memory until its shell returns an actual exit code; the results list shows status and duration. One managed script may run in each terminal at a time. A disconnect before a result is reported as disconnected, not success. Notifications are opt-in and omit host names, script names, and output. Start each run at an idle shell prompt.

Use **Back to files** to hide the editor while retaining its open tabs and drafts, then reopen it from the terminal’s **Editor** button or another file. **Save** / **Ctrl+S** opens a change review; only **Confirm save to server** writes. Changes made on the server preserve the local draft and require reloading. File contents and script run results are not persisted as history. Folder bookmarks and last folders store paths locally per host; they are not portable backup preferences yet. Permissions changes use the open file handle and reject a stale properties view, symlinks, and special permission bits; SFTP does not expose an atomic filesystem identity check.

The terminal’s **Export** button saves its selection, or available scrollback if nothing is selected, through a save dialog (up to 16 MiB). Stream mode redacts the exported text. Export is explicit; automatic session recording is not enabled.

## Bulk import and group commands

Open **Bulk import hosts** from the sidebar or quick switcher. Paste one host per line:

```text
192.0.2.10:user:password
198.51.100.20:password
```

The two-field format uses `root`. Set the SSH port once for the batch and optionally choose a group. Passwords containing colons require an explicit username, for example `192.0.2.10:root:pass:with:colons`. Blank lines and lines beginning with `#` are ignored. Hostnames and bracketed IPv6 addresses are supported. Preview shows validation errors without displaying passwords; existing host/port/username combinations and repeated rows are skipped. Each import supports up to 200 hosts and does not replace existing credentials.

Choose **One SSH key for all** to select a local private key for the whole batch. In this mode, use `host` (default user `root`) or `host:username`; any passwords in three-field rows are discarded. The app stores the key's path, not a copy of the private key.

Click the play button beside a named group, or open **Run group command** from the quick switcher. Review the command and target list, then start the run. The runner uses the saved credentials or key for each host and asks for any new server fingerprints. It opens separate SSH execution channels, runs up to four hosts concurrently, and leaves interactive terminal sessions available. Each host has its own output and result; the default timeout is five minutes per host. The reviewed target list stays fixed for that run. Cancellation closes SSH channels and skips queued hosts, but remote processes that already started may continue.

The editor accepts regular UTF-8 text files up to 2 MiB. It preserves a UTF-8 BOM and uniform line endings; mixed line endings normalize to LF with a footer indication. Saves use a temporary sibling and check content hashes before and after writing it. A detected remote change preserves the draft and requires reloading before saving. SFTP does not provide an atomic compare-and-swap operation, so edits made by another writer in the final rename interval cannot be locked out.

Editor version tokens also bind to the SSH connection that read the file. Reusing a disconnected session for another server cannot apply an old draft, even when both files have identical bytes; the draft stays local until you explicitly reload from the current connection. Reopening only the SFTP subsystem on the same live SSH connection keeps the draft's version valid.

Recent history records successful connections, including connections you do not add to the host library. It contains host metadata and timestamps only and can be cleared from Home.

New keys are generated into unique files under the app's `ssh-keys` user-data folder; there is no destination picker. A matching password of at least 12 characters is required. Private keys use OpenSSH AES-256-CTR encryption with bcrypt PBKDF (64 rounds); the folder and private files receive owner-only permissions (`0700`/`0600` on Unix and current-account ACLs on Windows). Existing keys are never overwritten. Generation and password verification run in workers so SSH stays responsive. Only an explicit, PIN- and password-verified View key request returns decrypted private material to the interface. Keep an encrypted backup; forgotten key passwords cannot be recovered.

File transfers use **SFTP over SSH**. FTP/FTPS and cloud sync are outside this preview. For agent authentication on Windows, enable the OpenSSH Authentication Agent service and load a key with `ssh-add`; the app uses its fixed named pipe. macOS/Linux use an absolute `SSH_AUTH_SOCK` when available. The app never enables agent forwarding or saves a key passphrase; viewing a private key still requires its encryption password each time.

## Workspaces, library, and server tools

Use the terminal toolbar to switch between tabs, a two-pane split, and a four-pane grid. Click a pane to activate it and use its arrow controls to change its position. Terminal contents and connections stay mounted when changing layouts. **Workspaces** saves a named selection of up to 20 saved hosts and the layout. **Restore layout** creates disconnected placeholders; **Connect workspace** starts the selected hosts using saved passwords or key files. Hosts that need credentials open the connection form. Workspaces do not store terminal contents or passwords.

Open **Manage workspace** for runbooks, named SSH keys, group defaults, backups, and update status. Runbook variables use `{{name}}` outside shell quotes and are inserted as quoted POSIX shell arguments. Heredoc substitutions are unsupported. Using a runbook opens the existing command-and-target review before any command runs. Group defaults provide a username, port, and optional named key for new connections; bulk import has an explicit **Apply group defaults** action. Password-list import still uses `root` for the documented two-field format.

The **Server dashboard** reads Linux `/proc`, OS-release information, and `df` through a bounded SSH execution channel. It refreshes every five seconds while visible and requires no additional remote service. Unsupported operating systems or missing tools show a clear error without disconnecting the shell.

**SSH tunnels** starts local or remote forwarding on a connected host, with saved rules and a Stop action. The app requests loopback listeners (`127.0.0.1`); remote forwarding also depends on the SSH server's forwarding policy. Listeners and forwarded connections close when their SSH session disconnects. Jump hosts are selected from saved profiles, support chains of up to four hops, and verify each hop's fingerprint. Password-based hops need a remembered password. Key-based hops can use an unencrypted private key, or the same key file and runtime passphrase as the destination; separate encrypted hop-key passphrases are not yet prompted for by this preview.

Automatic reconnect is opt-in per host. After a previously connected session drops, it tries saved credentials with delays of 2, 4, 8, 16, and 30 seconds. Manual disconnect, close, missing credentials, and authentication or host-verification failures stop retries. Input and previous commands are never replayed. Enable a named `tmux` session in host options to attach or create it on the remote server; `tmux` must already be installed. A plain SSH shell does not preserve remote process state across reconnection.

## Folder transfers and portable backups

Upload a folder using the folder button, or drop files/folders from Explorer onto the remote browser. Select remote folders and choose Download to copy them recursively, including empty folders. Each folder is one queue job with aggregate byte progress. Transfers support up to 10,000 entries and 32 nested directory levels per folder. Symbolic links and special files are rejected during preflight rather than followed. Unsafe Windows filenames and colliding names are rejected for downloads. Files are still committed individually through temporary siblings: canceling a folder preserves files already completed and removes the active file's temporary sibling where cleanup succeeds. Retry starts the selected job again and asks before replacing existing files; pausing an active job keeps its existing streams and temporary file open, applying backpressure until resumed. Pausing a queued job lets other queued jobs proceed. Active pauses keep that connection’s queue waiting; cancellation still removes the active temporary file. Pause/resume applies while the connection remains open; retries after cancellation, failure, disconnection, or restart begin again. The bandwidth limit is shared across this window’s sessions and is saved on this device.

Backup exports encrypt profiles, library items, workspaces, and selected UI preferences using AES-256-GCM with a scrypt-derived key. Remembered passwords and private key contents are optional. Use a passphrase of at least 12 characters; it is never saved. Restoring first decrypts and validates a preview, then merges new hosts/library items while preserving existing hosts and credentials. Included private keys are restored to new managed paths with restricted file permissions. Metadata-only backups keep key paths, so missing keys must be relinked on another machine. Restore previews expire after ten minutes. Backups are limited to 32 MiB and cannot recover a forgotten backup passphrase.

Installed builds check the latest stable GitHub Release after startup or through **Updates → Check for updates**. Checks download metadata only. On Windows x64, **Download update** streams a validated release installer inside the app, with progress, cancellation, retry, and size/SHA-256 verification. When ready, **Install now** asks you to save work, closes connections/transfers, rechecks the file, and starts the installer. Each step requires a separate click. Versions 0.8.1–0.9.0 still open the release page, so install the current release manually once to gain in-app downloading. Local development makes no update requests. Installers remain unsigned; see [RELEASE.md](RELEASE.md).

Open **MCP server** in the sidebar to connect an external AI assistant to SSH Heaven. Read tools use existing SSH sessions; command and file-edit tools require an explicit in-app review. MCP starts disabled and runs only on loopback. See [MCP.md](MCP.md) for setup and access details.

Uploads and downloads stream to temporary files and replace the destination only after successful completion. Cancellation preserves an existing destination and keeps the SSH connection available. Servers that cannot safely rename an upload over an existing file report a replacement error. If a connection is lost before cleanup can reach the server, a hidden `.ssh-heaven-*.part` file may remain remotely.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+K | Find hosts and actions |
| Ctrl+Shift+N | New connection |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous session |
| Alt+Left / Alt+Right | Back / forward through visited pages and sessions |
| Ctrl+1 / Ctrl+2 / Ctrl+3 / Ctrl+4 | Home / Connect / Scripts / Vault |
| Ctrl+W | Close session (confirms an active connection) |
| Ctrl+Shift+F | Find in active terminal |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy terminal selection / paste |
| F2 / Delete in the file list | Rename / request deletion |

Use file checkboxes or Ctrl-click to select multiple files. Drag the divider between the terminal and file browser to resize the panels.

## Validation

Background sessions keep their SSH state and terminal parsing, while hidden Stream-mode mirrors pause visual work and catch up before becoming visible. File browsers defer initial reads and editor-save refreshes until visible. Saving one document refreshes its own session, and transfer progress updates only the relevant session's transfer panel. Editor typing uses incremental UTF-8 byte accounting and immutable document trees; file serialization happens for explicit save review.

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:workspace
npm run test:themes
npm run test:productivity
npm run test:chrome
npm run test:fleet
npm run test:tools
npm run test:management
npm run test:folders
npm run test:mcp
npm run test:terminal
npm run test:wallpaper
npm run test:quick-connect
npm run test:input
npm run test:stream
npm run test:scripts
npm run test:vault
npm run test:navigation
```

The tests start an isolated SSH/SFTP server on localhost with a temporary filesystem. They verify authentication and host trust, real binary transfers, queue ordering, overwrite protection, and cancellation with delayed remote handles. The Electron end-to-end test uses a temporary settings directory, never a saved personal connection. Build before running the end-to-end test.

On Windows, the Scripts end-to-end fixture also uses Git for Windows' Bash to execute reviewed scripts locally. This is a development-test dependency; the installed client runs scripts with `sh` on the connected SSH server.

## Windows installer

```powershell
npm run dist:win
```

The NSIS installer and unpacked application are generated in `release/`. Preview installers are unsigned and include GitHub update checks and user-triggered downloading/installation. Signing and custom release hosting have a separate prepared setup; see [RELEASE.md](RELEASE.md).

Run `npm run test:packaged` after packaging to run all twenty-five automated end-to-end suites against the Windows executable, including SSH/SFTP, encrypted key generation/viewing, vault, scripts, themes, privacy, input timing, navigation, connection defaults, and in-app update downloading. The performance regressions include twelve simultaneous SSH sessions and six large editor tabs with undo/redo, selection and format preservation. `npm run test:updates` requires a current packaged build; its process-launch interceptor prevents any installer from running. Actual installer execution and native physical window movement require separate manual validation. The separate `npm run test:drag` harness requires real native window drags; renderer events do not prove OS window movement.

For background-only testing, set `$env:SSH_HEAVEN_BACKGROUND_TEST = '1'` before running a suite. The test app renders offscreen without showing or focusing a window; keyboard/pointer events stay inside its isolated renderer. In this mode native maximize, focus, caption-overlay, and physical-drag checks are skipped, and large layout tests use a resized offscreen viewport.

## Structure and portability

```text
electron/    Main process: SSH sessions, SFTP, local dialogs, settings, IPC
shared/      Typed renderer-to-main API
src/         React interface and terminal rendering
tests/       Local SSH/SFTP fixture, integration and end-to-end checks
scripts/     Development launcher
```

The renderer has no Node.js access. A sandboxed preload exposes a small typed API; the main process validates IPC requests and owns connections and local file access. Remote output goes to the terminal emulator as bytes, preserving UTF-8 across network chunks.

macOS and Linux build targets are configured as a starting point (`npm run dist:mac` and `npm run dist:linux`). Those platforms still need their own build, terminal/clipboard testing, and distribution checks. macOS releases should be built and signed on macOS. Windows x64 is the first supported release target.

The lockfile pins the dependency tree. A version-scoped minimatch override fixes a development packaging dependency advisory without replacing older consumers that require the v3 API.
