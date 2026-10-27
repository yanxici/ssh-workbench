# SSH Workbench

English | [简体中文](./README.zh-CN.md)

A lightweight desktop SSH client with a built-in workbench for embedded-device technical support. Built with Electron, React and TypeScript.

## Features

**Connections & terminal**
- Connection manager with groups (create, rename, delete, drag-to-reorder), tags and colors; password, private key (PEM / OpenSSH / PuTTY `.ppk`), SSH agent and keyboard-interactive auth
- ProxyJump chains, SOCKS5 / HTTP CONNECT proxies
- Paste an `ssh user@host -p 22` command from the clipboard to create a connection
- Multi-tab terminal (xterm.js) with search, custom shortcuts and ZMODEM (`rz` / `sz`; `sz` downloads stream in chunks to a folder you pick)
- Encrypted connection export / import between machines
- Auto-reconnect on connection drop with visible error logs
- In-app auto update: a badge in the title bar advertises new versions, with a version diff, the release notes and a one-click install (differential download, usually a few MB)

**Command panel**
- One-click saved commands with `{{variables}}`, dangerous-command confirmation, groups, drag-and-drop, search, favorites and history
- JSON import / export
- Always-on command rail on the right (fixed 3-column button wall, `Ctrl+Alt+B` to toggle)
- Command Center (`Ctrl+K`): fuzzy search with Chinese/English synonyms, usage-based ranking, full keyboard control, scope filtering (all / recent / most used / favorites)
- Group fields are searchable comboboxes: the full list shows up on open, typing filters it, and a brand-new group name can be created on the spot

**Files & tunnels**
- SFTP file tree beside the terminal, dual-pane transfer mode, remote edit with automatic `.bak` backup
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
- 7 color themes (VS Code Light, Workbench, Dracula, Nord, Solarized, One Dark, Gruvbox), each with light and dark variants; UI and terminal colors switch together
- Optimized for large connection lists (2900+ tested): pagination, fold long groups by default, indexed session lookup
- Long command names and command text truncate with an ellipsis instead of overflowing the card; all 12 views audited for text overflow

**Security**
- Credentials encrypted with the OS keystore (Electron `safeStorage`)
- Host key fingerprint verification

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
| `npm run smoke` | Build, launch, take a screenshot, exit |
| `npm run build:win` | Build the Windows installer (NSIS) and portable exe; runs the integrity-label check first |
| `npm run build:win:portable` | Build only the portable exe (no install, no registry writes) |
| `npm run check:integrity` / `fix:integrity` | Inspect / repair the directory integrity label (`Low` makes a double-clicked exe silently do nothing) |
| `npm run guard:integrity` / `unguard:integrity` | Install / remove a `WRITE_OWNER` deny guard so sandbox tools can no longer re-stamp the tree as `Low` (see `RELEASE_CHECKLIST.md` §0.1) |
| `npm run test:cwdfollow` | Regressions for terminal-cwd following (`shellCwd` parser + `cwdStore` session isolation) |
| `npm run test:stress` / `test:stress:e2e` | Scale stress test / real-Electron directory-read stress test |
| `npm run icon` | Regenerate the multi-size app icon |
| `npm run build:mac` / `build:linux` | Build for macOS / Linux |
| `node scripts/verify-*.cjs` | Standalone test scripts for individual modules |

## Data location

`%APPDATA%/ssh-workbench/data/` on Windows (the exact path is shown in Settings).

## Docs

Architecture, directory layout and roadmap (Chinese): [DESIGN.md](./DESIGN.md)

## Version

Current: **v1.5.1**

Recent updates:
- Sidebar file panel: opening a remote directory no longer stalls — batched `readdir` over a single IPC round trip (`SFTP_LIST_MANY` / `SFTP_BOOTSTRAP`), per-frame request coalescing and a TTL cache. 256 directories now cost 1 IPC call instead of 256
- The file panel follows the terminal: type `cd /var/log` and the sidebar jumps there (input tracking plus OSC 7, toggleable)
- In-app auto update: the title bar advertises new versions and installs them in one click
- Command group selection fixed: the group field no longer locks to the default group (replaced native `datalist` with a proper combobox)
- Command name and command text now truncate instead of overflowing the card
- Sidebar file panel right-click menu, including download file / download directory
- Auto-reconnect on connection drop
- Performance optimization for large connection lists (2900+ connections tested)
- Connection group management (create, rename, delete, drag-to-reorder)
