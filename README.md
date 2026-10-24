<p align="center">
  <img src="src/assets/app-icon.png" width="96" alt="App Audio Router icon: an audio waveform splitting into two arrows">
</p>

# App Audio Router

**Per-app audio routing for Windows: send one program's sound to several playback devices at once — each with its own delay compensation and its own volume — or into another program's input.**

<p align="center">
  <a href="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Version 2.3.0" src="https://img.shields.io/badge/version-2.3.0-0891b2">
  <img alt="Platform: Windows 10 and Windows 11, 64-bit" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <img alt="Built with Tauri 2, Rust and React 19" src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React%2019-24C8DB">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

Windows itself lets a program play to one output at a time. App Audio Router lifts that: pick a program, pick one or more playback devices, and its audio goes to all of them at once — live, without restarting it — or into another program's input, so Discord can hear Spotify the way a microphone would. Everything is done with the Windows Core Audio API from a single native binary: no helper executable, and no driver bundled or installed for routing (feeding another program runs through a loopback endpoint pair you install and pick once in Settings).

| | |
|---|---|
| **Platform** | Windows 10 / Windows 11, 64-bit |
| **Latest version** | 2.3.0 |
| **Installer** | MSI or NSIS setup from [Releases](https://github.com/Eververdants/AppAudioRouter/releases) |
| **Licence** | MIT |
| **UI languages** | English, Simplified Chinese |
| **External dependencies** | None for routing. Feeds run through a loopback endpoint pair you install and pick yourself |
| **Built with** | Tauri 2, Rust, React 19, TypeScript, TailwindCSS, Vite |

## Screenshots

![App Audio Router's node board: Music.exe's card wired to numbered destination rows in two dashed panels (main device above, copies below), with one copy's delay and share open in the tuning strip and the app list on the left](docs/images/app-audio-router-light.png)

![The same node board shown in the dark theme](docs/images/app-audio-router-dark.png)

The board is the whole app: the programme making sound in a sidebar on the left, its destinations as numbered rows on the right — 01 is the device Windows plays itself, the rest are copies this app duplicates to — and a wire that *is* the route. Clicking a row's number opens its delay and volume in the strip below.

## Features

- **One app → many devices, applied immediately.** A running program is re-pointed to the selected devices without a restart; the first device is driven natively by Windows, every further one receives a real-time copy.
- **One app → another app's input (2.3.0).** The same destination picker lists every program that can take sound in. It is one more destination, not a move — the program keeps playing where it did — and it runs through the loopback endpoint pair you pick in Settings; until then the rule is kept and the board says so.
- **Per-device delay compensation.** A signed millisecond value per device to align a Bluetooth headset with wired speakers. **Settings → Delay compensation → Calibrate** measures it for you: each device plays short tones in turn, you tap when you hear one, and the differences are written as the compensation.
- **Per-device volume balance.** A 0–100 % value per copy, relative to the loudest one. The device Windows plays directly gets its own volume through the program's session volume, restored when the route stops.
- **Per-program level alignment.** Every routed program carries a 0–400 % level of its own, and one click brings all playing programs to the loudest one's level.
- **Auto-remember.** Routing rules are stored per executable name and restored when that program plays again.
- **A mirror that fails says so.** If one device of a route cannot be opened, the rest keep playing and the log names the one that went silent.
- **Live lists, no polling.** The device and process lists follow Core Audio's own change notifications. Nothing polls the audio engine, and an idle route parks instead of writing silence at the devices.
- **Stays out of the way.** Tray icon with the whole job in its menu, optional close-to-tray, optional start-with-Windows (`HKCU` only, no administrator rights), single instance, light and dark themes, English and Simplified Chinese — all in one window.

## How it compares

| Capability | **App Audio Router** | Windows per-app output | Virtual-cable mixer (Voicemeeter / VB-CABLE class) | Per-app default switcher (EarTrumpet class) |
|---|---|---|---|---|
| One app → several devices at once | **Yes** | No — one output per app | Yes, through mixer buses | No |
| Applies to an already-running app | **Yes** | Yes | Yes | Yes |
| Per-device delay alignment for Bluetooth | **Yes** — signed ms per device | No | Manual, per bus | No |
| Per-device loudness balance | **Yes** — 0–100 % per device | No | Yes, via bus gain | No |
| One app → another app's input | **Yes** (2.3.0, through a loopback pair) | No | No | Yes (virtual channels) |
| Requires a virtual audio driver | **Routing: no. Feeds: a loopback pair you install** | — | Yes | — |
| Remembers the route per application | **Yes**, automatically | Yes (the same Windows setting) | Configured in Windows | Inherits the Windows setting |
| Cost | **Free, MIT licensed** | Bundled with Windows | Free or pay-what-you-want | Free, MIT licensed |

*The other columns describe publicly documented behaviour of those approaches; check their own documentation for the current feature set.*

## Install

1. Open the [Releases](https://github.com/Eververdants/AppAudioRouter/releases) page.
2. Download the `.msi` installer (or the NSIS `.exe` setup) from the newest release.
3. Run it and launch **App Audio Router**.

## Quick start

1. **Play some sound in the program you want to route.** A program only appears in the list while it has an active audio session.
2. **Pick it in the sidebar** — the circular button at the end of another row adds that program to the same change.
3. **Add the devices it should play through.** The first one is Windows' own; every one after it receives a copy with its own delay and volume.
4. **Click the program's card.** The route lands, and the wires to the destinations flow while the program sounds.
5. **Tune a copy if you need to** — its number badge opens its delay and volume in the strip below. To feed another program's input instead, the same picker lists them; picking one connects on the spot, with undo in the toast.

## Requirements

- **Windows 10 or Windows 11, 64-bit.**
- WebView2 runtime — already present on Windows 11 and on any Windows 10 with Microsoft Edge installed.
- That is all for the installed build: no audio driver, no service, no third-party executable.

## Good to know

- Remembered routes are matched on executable name, not on a path or a PID.
- Delay compensation can only *add* latency; the earliest device of a route is the reference. A mirrored copy carries about 100 ms of pipeline latency, and a feed arrives at its target about 100–140 ms after the source's own output.
- While a program is routed, Windows keeps a fixed output device stored for it (that is the mechanism that moves a running program's audio). It is handed back when the route stops, when the app quits, and by **Settings → Reset per-app output** — which, since Windows keeps no author on those records, also releases assignments you made by hand in the volume mixer.
- Routes for system-critical processes are refused rather than half-applied.
- The first launch after an update walks a short full-screen tour — an upgrade answers one question first, what to do with the previous version's settings — and never returns once acknowledged.

## Build from source

```bash
git clone https://github.com/Eververdants/AppAudioRouter.git
cd AppAudioRouter
pnpm install

pnpm tauri dev        # dev build with hot reload
pnpm tauri build      # installers in src-tauri/target/release/bundle
```

Useful checks, all of which also run in CI:

```bash
pnpm fmt:check                   # prettier, including Tailwind class order
pnpm typecheck                   # tsc --noEmit
pnpm build                       # tsc -b && vite build
pnpm test                        # unit tests (Vitest, against a fake Tauri IPC)
pnpm test:e2e                    # end-to-end (Playwright; it starts the dev server itself)
cd src-tauri
cargo fmt -- --check
cargo clippy -- -D warnings
cargo check
cargo test
```

Building from source additionally needs Node.js 20 or later, pnpm 10, and a stable Rust toolchain with the MSVC target and the WebView2 build tools that Tauri uses. The module-level conventions the codebase follows are documented in [AGENTS.md](AGENTS.md).

## Contributing

Issues and pull requests are welcome at [Eververdants/AppAudioRouter](https://github.com/Eververdants/AppAudioRouter). Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are kept small and focused, one concern per commit.

## License

[MIT](LICENSE) © 2026 Eververdants
