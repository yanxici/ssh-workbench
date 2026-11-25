# SSH Workbench

English | [简体中文](./README.zh-CN.md)

A lightweight desktop SSH client with a built-in workbench for embedded-device technical support. Built with Electron, React and TypeScript.

![SSH Workbench overview](docs/ui/overview.png)

## Download & install

Windows 10/11 (x64) only. Pick one of the three packages — **use the [Gitee mirror](https://gitee.com/w3554334905/ssh-workbench/releases) from mainland China**, [GitHub Releases](https://github.com/yanxici/ssh-workbench/releases) everywhere else. Same files, same version:

| Package | File name | Best for |
| --- | --- | --- |
| Installer (recommended) | `ssh-workbench-Setup-2.4.2.exe` | Installs into the system, supports in-app auto-update |
| Portable | `ssh-workbench-2.4.2-portable.exe` | Run from a USB stick / jump host, writes no registry keys |
| Zip bundle | `ssh-workbench-2.4.2-win.zip` | Unzip and run; easiest to mirror onto an internal share |

- Always latest: <https://github.com/yanxici/ssh-workbench/releases/latest>
- Pinned: <https://github.com/yanxici/ssh-workbench/releases/tag/v2.4.2>
- Integrity: `latest.yml` in the same release carries the sha512 of each artifact.

**Mainland China**

1. Primary: <https://gitee.com/w3554334905/ssh-workbench/releases> — mirrored in sync with GitHub, no proxy needed.
2. Pinned: `https://gitee.com/w3554334905/ssh-workbench/releases/download/v2.4.2/` + the file name above.
3. GitHub + proxy prefix (third-party relay, availability not guaranteed): `https://gh-proxy.com/https://github.com/yanxici/ssh-workbench/releases/download/v2.4.2/` + file name.
4. Internal mirror (most reliable): copy `ssh-workbench-2.4.2-win.zip` to a company share or artifact store and link it here — `<internal mirror URL>`.

> In-app auto-update now uses an automatic multi-channel feed: without a proxy it tries the official Gitee mirror first and falls back to GitHub Releases and built-in mirrors (verifying the first-party sha512 before downloading from any third-party relay); with an update proxy configured it prefers GitHub first for differential updates. You can also pick a specific channel or custom feed URL under Settings → Updates.

> UI language: Simplified Chinese by default, with an English option in Settings for the settings shell.

## Features

**Connections & terminal**
- Connection manager with groups (create, rename, delete, drag-to-reorder), tags and colors; password, private key (PEM / OpenSSH / PuTTY `.ppk`), SSH agent and keyboard-interactive auth
- ProxyJump chains, SOCKS5 / HTTP CONNECT proxies
- Paste an `ssh user@host -p 22` command from the clipboard to create a connection
- Multi-tab terminal (xterm.js) with search, custom shortcuts and ZMODEM (`rz` / `sz`; `sz` downloads stream in chunks to a folder you pick)
- Encrypted connection export / import between machines
- Auto-reconnect on connection drop with visible error logs
- In-app auto update: a badge in the title bar advertises new versions, with a version diff, the release notes and a one-click install (differential download, usually a few MB)
  > Only the NSIS installer supports auto-update. The portable exe and zip builds ship no update metadata — upgrade them by downloading the new version and overwriting.

**Serial console** (v2.0.0)
- Connect a device over USB-to-serial and type commands in the same tabbed terminal — no second tool needed for a field visit
- Baud rate, data bits, parity, stop bits and flow control; line ending (CR / LF / CRLF, default CR) and encoding (UTF-8 / GBK / GB18030)
- Optional per-character and post-newline send delays: pasting a long command into U-Boot or a 9600-baud device no longer has bytes swallowed
- Switch baud rate without reconnecting: `port.update()` changes the UART divider only, so the port object and its event subscriptions survive — the boot log you were reading does not vanish mid-line, and a board with an auto-download circuit is not reset by a reopen (115200 at power-up, 9600 once the system is up; or jump to 57600 to catch a U-Boot prompt)
- Send BREAK (`port.set({ brk })`, 50–2000 ms): the only way to interrupt a board that is already auto-booting into a maintenance prompt, with the release always executed so TX never stays pinned low
- Every recording is written twice: the asciinema `.cast` for playback, plus a plain-text `.log` with ANSI stripped, `[HH:MM:SS.mmm]` timestamps and a `> ` prefix on what you typed — grep-able, paste-able into a chat, ready to line up against device logs and captures; both are optional and each has its own 50 MB cap
- Port list refreshes itself (2 s poll): unplugging a cable shows "waiting for device", plugging it back reconnects automatically without burning a retry backoff
- Devices are matched by USB identity (`serialNumber` → `pnpId` → COM number), so a device that comes back on a different COM port is still the same device — and a different device on the old COM port is never mistaken for it
- DTR auto-reset is off by default (pulling DTR reboots ESP32 / STM32 boards with an auto-download circuit)
- Serial sessions deliberately expose only the terminal: metrics, diagnostics, firmware, batch, SFTP and tunnels all run remote commands and stay SSH-only
- Serial connections export / import like SSH ones; the USB identity travels with them, and a port that does not exist on the target machine is flagged "needs confirmation" instead of failing at connect time
- A "7628 U-Boot console" preset in the connection editor (57600 8N1, no flow control, CR) so flashing needs no memorised parameters
- A flashing guide bar above every serial session: U-Boot's 2-second window no longer needs luck — one click counts down 6 s, then bursts `2` every 250 ms for 16 shots to cover the whole window, with one button each for `Y`, Enter and the firmware name
- A built-in TFTP server (RFC 1350, read-only, `blksize` / `tsize` negotiation): pick the firmware, start it, and the pane shows the local NIC address plus transfer progress — no external tftp tool

**Command panel**
- One-click saved commands with `{{variables}}`, dangerous-command confirmation, groups, drag-and-drop, search, favorites and history
- JSON import / export
- Always-on command rail on the right (`Ctrl+Alt+B` to toggle): column count follows the pane width — 3 columns below 360 px, 4 below 480 px, 5 above — with two-line labels, no per-card icon or command line, and a 2 px accent strip (needs confirmation > pinned > has variables > plain). Arrow keys step by the real column count; hover shows the full command in a self-drawn tooltip
- Command Center (`Ctrl+K`): fuzzy search with Chinese/English synonyms, usage-based ranking, full keyboard control, scope filtering (all / recent / most used / favorites)
- Group fields are searchable comboboxes: the full list shows up on open, typing filters it, and a brand-new group name can be created on the spot

**Files & tunnels**
- SFTP file tree beside the terminal, dual-pane transfer mode, remote edit with automatic `.bak` backup
- **Upload folders** (files panel, session file tree, dual-pane remote pane): the remote side keeps the local directory name (`target/<folder>/...`), empty folders included. Dragging a folder still flattens its contents into the target — the two are now separate code paths
- The file tree follows the terminal: type `cd /var/log` and the sidebar jumps there, expanding parents as it goes (input tracking plus OSC 7; toggle from the chain icon in the panel header)
- Directories load through one batched IPC call plus a TTL cache, so expanding a deep tree no longer pays one serial round trip per level
- Right-click menu on the sidebar file tree: edit, download file / download directory (expanded recursively), download straight to the local Downloads folder, upload here, new folder, rename, delete
- Transfer queue with live progress and speed; pause / resume (continues from the transferred offset) / cancel (partial files are cleaned up)
- Port forwarding: local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`)

**Support workbench**
- Session recording in asciinema `.cast` format, with a player (speed control, export)
- One-click diagnostics: 31 built-in BusyBox-friendly checks plus custom items, exported as Markdown / self-contained HTML
- Batch execution across multiple sessions, with card and side-by-side compare views
- Customer / device profiles and a live resource dashboard (CPU, memory, disk, temperature, network)
- Firmware upgrade helper: upload, SHA-256 verification on both ends, upgrade, wait for reboot
- Device discovery: subnet TCP scan, ARP vendor lookup, reverse DNS, mDNS
- Config backup with line-level diff and restore
- Pack reports, logs, history and backups into a single zip

**Interface**
- Title bar + activity bar + resizable sidebar and command rail (drag to resize, double-click to reset)
- 4 curated high-contrast color themes (Precision Default, Gruvbox, Solarized, Dracula), each with light and dark variants (all 8 WCAG >= 4.5:1); UI and terminal colors switch together
- Optimized for large connection lists (2900+ tested): pagination, fold long groups by default, indexed session lookup
- Long command names and command text truncate with an ellipsis instead of overflowing the card; all 12 views audited for text overflow

**Security**
- Credentials encrypted with the OS keystore (Electron `safeStorage`)
- Host key fingerprint verification (OpenSSH-compatible `SHA256:base64`), with **in-place fingerprint update**: probe what the device presents now, review the old → new diff, confirm, done. Reachable from Settings, from the connection editor ("update and retest"), and from the terminal error overlay ("update and reconnect"). Legacy `SHA256:<hex>` records are still recognised and migrated automatically

## Getting started

Requires Node.js 18+.

```bash
npm install --omit=optional   # skip ssh2's optional native addon (no C++ toolchain needed)
npm run dev                   # dev mode with hot reload
```

`.npmrc` points the Electron binary download at the npmmirror mirror. Remove that line if you have direct access to GitHub.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Development mode (F12 opens DevTools) |
| `npm run typecheck` | Type-check main and renderer processes |
| `npm run lint` / `lint:all` | ESLint (type-aware for main/preload/shared, React Hooks for the renderer) |
| `npm run check` | `typecheck` + `lint` — run this before committing |
| `npm run smoke` | Build, launch, take a screenshot, exit |
| `npm run build:win` | Build the Windows installer (NSIS) and portable exe; runs the integrity-label check first |
| `npm run build:win:portable` | Build only the portable exe (no install, no registry writes) |
| `npm run check:integrity` / `fix:integrity` | Inspect / repair the directory integrity label (`Low` makes a double-clicked exe silently do nothing) |
| `npm run guard:integrity` / `unguard:integrity` | Install / remove a `WRITE_OWNER` deny guard so sandbox tools can no longer re-stamp the tree as `Low` (see `RELEASE_CHECKLIST.md` §0.1) |
| `npm run test:cwdfollow` | Regressions for terminal-cwd following (`shellCwd` parser + `cwdStore` session isolation) |
| `npm run test:ipc` | IPC integrity: every channel constant has a registered handler, `ipcMain` count matches, failures wrapped as `{ ok: false }` |
| `npm run test:repository` | Persistence behaviour: credential semantics, group defaults, history cap, settings merge, timeout clamping |
| `npm run test:features` | Host-key fingerprint format/legacy compatibility + folder-upload semantics |
| `npm run test:stress` / `test:stress:e2e` | Scale stress test / real-Electron directory-read stress test |
| `npm run icon` | Regenerate the multi-size app icon |
| `npm run build:mac` / `build:linux` | Build for macOS / Linux |
| `node scripts/verify-*.cjs` | Standalone test scripts for individual modules |

## Data location

`%APPDATA%/ssh-workbench/data/` on Windows (the exact path is shown in Settings).

## Docs

Architecture, directory layout and roadmap (Chinese): [DESIGN.md](./DESIGN.md)

## Version

Current: **v2.4.2**

Recent updates:
- **v2.4.2** — Fixed multi-file ZMODEM `sz` batch downloads (e.g. `sz robottest*`) aborting after the first file or corrupting per-file state: unified the receive state machine (`primeReceiveSession`) to handle multi-frame `ZDATA` (`ZCRCW`/`ZCRCE`), 0-byte empty files (`ZEOF(0)` without `ZDATA`), `_file_info` cleanup on mismatched `ZEOF`, inter-file retransmits, and deferred `ZRINIT` until disk flush/finish completes, plus added batch index display (`i/N`) in the transfer overlay.
- **v2.4.1** — Fixed the built-in remote editor `<textarea>` collapsing to ~3 rows with blank space below (and collapsing short files) due to `modal-body` (`flex: 1`) + `h-full` blocking flex stretch; exempted xterm DOM `.xterm-cursor-blink` from `.motion-off *` so terminal cursor blinking keeps working when Windows reduced motion or UI motion-off is active; fixed blank white taskbar icons on Windows unpacked/portable builds by binding `AppUserModelID` only when a matching Start Menu shortcut exists.
- **v2.4.0** — Embedded SSH resilience, terminal workflow & precision instrument shell: per-connection legacy SSH algorithms (SHA-1/CBC/DSS) with one-click reconnect recovery; automatic BusyBox/POSIX Shell file-channel fallback when `sftp-server` is absent; tunnel reconnect auto-restore, connection auto-start, remote listening port discovery (`ss` / `netstat` / `/proc/net/tcp(6)`) and one-click ephemeral quick-forwarding; drag-and-drop SFTP upload straight to terminal `cwd`, editable multiline paste guard with Markdown fence stripping, one-click import from `~/.ssh/config`, MobaXterm, Xshell, SecureCRT & FinalShell, split-pane sync input and background tab unread dots; unified 36px monochrome instrument chrome, 4 curated high-contrast themes (7→4 with v3 silent migration), quick-launch welcome view and `Ctrl+Shift+Z` Zen focus mode.
- **v2.3.2** — Added a zero-proxy domestic in-app auto-update channel: Auto mode tries the official Gitee mirror first (resolving the latest tag via public API and disabling differential Range downloads on Gitee CDN) and falls back across `Gitee → GitHub → gh-proxy.com → ghfast.top` with first-party `sha512` verification; Settings → Updates now supports choosing a channel or custom intranet feed and displays the active source; added `scripts/sync-gitee-release.ps1` and an optional Gitee sync step in CI.
- **v2.3.1** — Smart terminal `Ctrl+C` / `Ctrl+V` by default (copy with selection, pass `SIGINT` through without), optional copy-on-select and right-click copy/paste (`Shift+right-click` opens menu), per-terminal `Ctrl+wheel` zoom (`Ctrl+0` reset), export terminal buffer to `.txt`, adaptive 8–32ms output coalescing, upgraded built-in remote editor (line numbers, `Ctrl+F`/`Ctrl+H` find/replace, `Ctrl+S` in-place save, encoding/cursor bar, `Tab` indent, dirty-close prompt), and fixed right-click "Send files…".
- **v2.3.0** — Interaction feedback landed: command cards lift on hover and dip on press, the command wall fades in with a 12ms stagger, connection rows show a brand-colored tick on the left, group arrows rotate instead of swapping icons, and Settings → Experimental → "Motion" turns all of it off (and follows the system reduce-motion preference).
- **v2.2.1** — Transfers stopped lying about being finished: ZMODEM resumes instead of stalling, downloads and uploads land whole, editing a remote file no longer damages it, a transfer history panel was added, and refreshing the file tree no longer costs more the deeper you have expanded.
- **v2.2.0** — Serial line: switch baud rate without reconnecting, send BREAK, and write a plain-text `.log` alongside every recording (ANSI stripped, timestamped); bare-LF output no longer staircases.
- **v2.1.9** — Fixed a finished ZMODEM overlay reappearing after a tab switch, and "save as new device and connect" losing the saved credentials.
- **v2.1.7** — Split panes are now reachable from the terminal context menu, not only the tab strip.
- **v2.1.6** — trzsz file transfer (`trz` / `tsz`) over a text protocol, with directories and a progress bar.
- **v2.1.5** — Nested split panes: one tab holds up to 4 panes, layouts persist per connection.
- **v2.1.4** — Task completion notifications, with a pure decision layer for when and how to notify.
- **v2.1.3** — Keyword highlighting of terminal output, line level, with a live rule tester.
- **v2.1.2** — Fixed the shrunken WebGL glyphs for real: a stray leading space in the canvas font string.
- **v2.1.1** — Temporary workaround for the glyph regression: terminal renderer defaults back to DOM.
- **v2.1.0** — Client-feel pass: design tokens, unified row heights, skeleton panel loading, real virtual scrolling.
- **v2.0.0** — Serial console: USB-to-serial devices open in the same terminal, plus a flashing guide and a built-in TFTP server.
- **v1.9.0** — Command rail columns follow the pane width; cards get a full-width two-line name.
- **v1.8.1** — ZMODEM reliability in both directions (stalled downloads, uploads stuck at 0 bytes).
- **v1.8.0** — IME composition guard across all 13 Enter handlers.
- **v1.6.8** — CI gate split into explicit `typecheck + verify` and `UI e2e` steps.
- **v1.6.7** — Fixed same-name batch download collisions and the dropped `allowLan` flag.
- **v1.6.6** — Fixed two P0s: downloads truncating existing files, and orphaned tunnel runtimes.
- **v1.6.5** — Release pipeline hardening: version-consistency gate, unified artifact policy.
- **v1.6.4** — Fixed three folder-upload bugs.
- **v1.6.3** — Split `repository.ts` and `SettingsPanel.tsx` into domain modules.
- **v1.6.2** — Added type-aware ESLint and fixed what its first run found.
- **v1.6.1** — Moved upload/download logic into the store; split `main/index.ts` by domain.
- **v1.6.0** — Folder upload and host-key fingerprint update.
- **v1.5.2** — Fixed the file panel not following `cd`.
- **v1.5.1** — Batched directory listing: 256 directories now cost one IPC call.
- **v1.5.0** — File panel follows the terminal, in-app auto update, sidebar right-click menu.
- Earlier versions: see the Releases page.

## License

MIT © 2026 yanxici. Full text in [LICENSE](./LICENSE).
