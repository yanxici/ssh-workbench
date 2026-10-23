# SSH Workbench

English | [简体中文](./README.zh-CN.md)

A lightweight desktop SSH client with a built-in workbench for embedded-device technical support. Built with Electron, React and TypeScript.

## Features

**Connections & terminal**
- Connection manager with groups, tags and colors; password, private key (PEM / OpenSSH / PuTTY `.ppk`), SSH agent and keyboard-interactive auth
- ProxyJump chains, SOCKS5 / HTTP CONNECT proxies
- Paste an `ssh user@host -p 22` command from the clipboard to create a connection
- Multi-tab terminal (xterm.js) with search, custom shortcuts and ZMODEM (`rz` / `sz`; `sz` downloads stream in chunks to a folder you pick)
- Encrypted connection export / import between machines

**Command panel**
- One-click saved commands with `{{variables}}`, dangerous-command confirmation, groups, drag-and-drop, search, favorites and history
- JSON import / export
- Always-on command rail on the right (fixed 3-column button wall, `Ctrl+Alt+B` to toggle)
- Command Center (`Ctrl+K`): fuzzy search, Chinese/English synonyms, usage-based ranking, full keyboard control

**Files & tunnels**
- SFTP file tree beside the terminal, dual-pane transfer mode, remote edit with automatic `.bak` backup
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
| `npm run build:win` | Build the Windows installer (NSIS) and portable exe |
| `npm run build:win:portable` | Build only the portable exe (no install, no registry writes) |
| `npm run icon` | Regenerate the multi-size app icon |
| `npm run build:mac` / `build:linux` | Build for macOS / Linux |
| `node scripts/verify-*.cjs` | Standalone test scripts for individual modules |

## Data location

`%APPDATA%/ssh-workbench/data/` on Windows (the exact path is shown in Settings).

## Docs

Architecture, directory layout and roadmap (Chinese): [DESIGN.md](./DESIGN.md)
