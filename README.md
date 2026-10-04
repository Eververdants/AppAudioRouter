<p align="center">
  <img src="src/assets/app-icon.png" width="96" alt="App Audio Router icon: an audio waveform splitting into two arrows">
</p>

# App Audio Router

**Per-app audio routing for Windows: send one program's sound to several playback devices at once, each with its own delay compensation and its own volume.**

<p align="center">
  <a href="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Version 2.1.1" src="https://img.shields.io/badge/version-2.1.1-0891b2">
  <img alt="Platform: Windows 10 and Windows 11, 64-bit" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <img alt="Built with Tauri 2, Rust and React 19" src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React%2019-24C8DB">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

> **App Audio Router is a free, open-source desktop application for Windows 10 and Windows 11 that routes the audio of individual programs to the playback devices you choose.** It can send one application to several devices at the same time, and it lets you tune each device separately — a delay compensation to line a Bluetooth headset up with wired speakers, and a volume to balance how loud each device is. Everything is done with the Windows Core Audio API from a single native binary: there is no virtual audio driver to install and no third-party executable to bundle.

---

## What is App Audio Router?

App Audio Router (**AAR**) is a per-application audio router for Windows. Windows itself only lets an application play to one output at a time; App Audio Router lifts that restriction. Pick a program, pick one or more playback devices, and the program's audio goes to all of them at once — live, without restarting the program.

It is aimed at ordinary users rather than audio engineers. There is no mixer graph, no virtual cable and no driver installation: the whole app is one window — the programmes making sound in a sidebar on the left, and beside it a ring with the programme you picked at its centre and every playback device as a disc around it. A spoke from the centre to a lit disc *is* that part of the route, so "where is this sound going?" is answered by which discs are lit. A change becomes real only when you click the circle in the middle, and a small "Straight talk" pill in the corner will tell you where things stand in plain words. The activity log sits one tab away.

| | |
|---|---|
| **What it is** | Per-app audio routing tool for Windows (one app → many devices) |
| **Platform** | Windows 10 / Windows 11, 64-bit |
| **Latest version** | 2.1.1 |
| **Installer** | MSI or NSIS setup from [Releases](https://github.com/Eververdants/AppAudioRouter/releases) |
| **Licence** | MIT |
| **UI languages** | English, Simplified Chinese |
| **External dependencies** | None — no virtual audio driver, no helper executable |
| **Built with** | Tauri 2, Rust, React 19, TypeScript, TailwindCSS, Vite |
| **Source code** | https://github.com/Eververdants/AppAudioRouter |

## Screenshots

The same stage in both themes: `chrome.exe` is the programme being looked at, so it sits at the centre and its route — the digital output — is the one lit disc, joined by a spoke and labelled *Main*. `Music.exe` plays to three devices at once (a Bluetooth headset, USB headphones and an HDMI output); picking it redraws the ring around its own route. The sidebar lists the programmes making sound, with each routed one marked by its ring, and the hub at the centre is the button that applies the plan — while a change is waiting, a badge on it says so. The title bar keeps the count: two routed, two playing.

![App Audio Router with chrome.exe at the centre of the ring playing through the digital output, Music.exe routed to three devices listed in the sidebar, and every playback device as a disc around the centre](docs/images/app-audio-router-light.png)

![The same concentric stage shown in the dark theme](docs/images/app-audio-router-dark.png)

## Features

### Routing

- **One app → many devices.** Pick a programme in the sidebar — and the circular button at the end of any other row adds that programme to the same change — then pick the discs it should play through; the audio is mirrored to all of them at once.
- **Applies immediately.** A running program is re-pointed to the selected devices without a restart or a settings dialog reboot.
- **Ordered targets.** The first device becomes the program's native endpoint, handled by Windows itself; every further device receives a real-time copy of the stream.
- **Stop on demand.** Stop routing and the program is handed back to the system default device — the fixed output device Windows took while the route was live is released again, so switching the default device by hand keeps moving that program.
- **Nothing left behind.** The only trace of a route is an output device Windows fixes for the program while it is routed. Stopping the route, quitting the app and **Settings → Reset per-app output** each give it back, and a program that exited while routed gets its device back the next time it plays.
- **Auto-remember.** Routing rules are stored per executable name and restored when that program plays again.
- **A mirror that fails says so.** If one device of a multi-device route cannot be opened, the engine keeps playing on the others and the log names the device that went silent — a route that is only half alive should not look fully applied.

### Per-device fine-tuning

- **Delay compensation** — a signed millisecond value per device to align a fast device with a slow one, for example wired speakers against a Bluetooth headset whose codec adds inherent latency. Range and step are configurable (±1/2/5/10 s; 1/10/50/100/1000 ms, 10 ms by default).
- **Volume balance** — a 0–100 % value per device that attenuates that device relative to the loudest one in the route, so a quiet headset and a loud speaker rig can be brought in line.
- **Reported latency** — the software-side latency each device is actually playing at, measured from the running stream. It is a reading and not a setting, so it lives in the tooltip of the delay value rather than beside it: the cell holds the value you asked for, and the tooltip holds what you got.
- **Stepped, not scraped** — each value moves with the `−` and `+` beside it: delay by the configured step, level by 5 %, both stopped at the ends of their range. They are buttons rather than drag surfaces because these two change what you are hearing, and resting a finger on a scroll wheel should not be able to move them.
- **Only where they can act** — both values belong to a copy, and appear only under the disc of one. A single-device route has no copy: Windows drives that device itself, so there is nothing of ours to hold back or attenuate, and the control is simply not drawn — a greyed-out control that could never work would promise otherwise.

### Stays out of the way

- **Live lists.** The device list and the process list follow the audio engine on their own — plug in a headset, or start and stop playback in an app, and both lists update without pressing anything. This uses Core Audio's own change notifications, not a polling timer.
- **One copy, one tray icon.** Launching the app again does not start a second process: the copy already running brings its window to the front instead. Two instances would fight over the same configuration files and the same audio devices.
- **System tray.** A tray icon appears while the app runs: left click shows or hides the window, the right-click menu has *Show / hide* and *Quit*.
- **Close to tray.** Optionally, the close button hides the window instead of quitting, so routing keeps running with no window on screen. Off by default; `Quit` is the action that stops the routes.
- **Start with Windows.** Optionally registers the app under your user's startup entries (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`), launching silently into the tray so remembered routes are ready before you open anything. Turn it back off from the same switch, or from Task Manager → Startup apps.

### Interface and overhead

- **A stage, not a form** — the process list is a sidebar, and the routing screen is a ring: the programme you picked sits at the centre with its name inside, every playback device is a glass disc around it, and a spoke from the centre to a lit disc *is* that part of the route. The first device of a route is the one Windows plays itself (accent); the devices after it are copies (teal), and a copy is the only place delay and level exist, because it is the only place there is a stream of ours to hold back or attenuate. Nothing takes effect until you click the circle in the middle, and nothing can leave a programme with nowhere to play — a ring always keeps at least one device lit. Devices no route touches get no spoke and no colour, which is most devices most of the time. A programme playing to several devices carries its own level as a ring under the hub, and the title bar keeps a quiet count — *2 routed · 2 playing*. Glass instead of cards, sentences instead of pills, monospaced figures for every value.
- **Process list search** — filter the list by name as you type, with the programs that are currently routed kept at the top so the one you are working with does not move under the cursor. `Escape` clears the search.
- **Light and dark themes**, English and Simplified Chinese, both switchable from the title bar; the preferred theme and language are applied before the first frame paints, so there is no flash on startup.
- **Low background cost** — the app never polls the audio engine. It registers for change notifications and re-reads the lists when Windows says something actually moved, and each re-read that turns up no visible change is not even logged. The interface has exactly two things that move on their own: the dash running along the spokes of a programme that is sounding, and the pulse on the ring beside a programme that is — only while the window is visible, focused and free of the system's reduced-motion request; hidden, unfocused or silent, everything stands still and nothing repaints. An active route is idle when its program is, too: a routed program that has produced no sound for a second and a half stops being fed to its mirrored devices, rather than having silence written at them a hundred times a second apiece.
- **Fast cold start** — the window is created hidden and is revealed once the first frame is on screen (with a watchdog on the Rust side as a fallback), device enumeration waits for the first paint to be idle, and the release profile is tuned for a small, dense binary (LTO, one codegen unit, symbol stripping, `panic = "abort"`).

## How it compares to other options

| Capability | **App Audio Router** | Windows built-in per-app output | Virtual-cable mixer (Voicemeeter / VB-CABLE class) | Per-app default switcher (EarTrumpet class) |
|---|---|---|---|---|
| One app → several devices at once | **Yes** | No — one output per app | Yes, through mixer buses | No |
| Applies to an already-running app | **Yes** | Yes | Yes | Yes |
| Per-device delay alignment for Bluetooth | **Yes** — signed milliseconds per device | No | Manual, configured per bus | No |
| Per-device loudness balance | **Yes** — 0–100 % per device | No | Yes, via bus gain | No |
| Per-program level balance | **Yes** — 0–400 % per program, dialed on its node, aligned in one click | No | Yes, but every strip is set by hand | No |
| How many programs and devices at once | **No built-in limit** — each routed program is its own engine | — | A fixed number of buses (3/5/8 by edition) | No |
| Remembers the route per application | **Yes**, automatically | Yes (this is the same Windows setting) | Configured in Windows, not in the mixer | Inherits the Windows per-app setting |
| Requires a virtual audio driver | **No** | — | Yes | — |
| Cost | **Free, MIT licensed** | Bundled with Windows | Free or pay-what-you-want | Free, MIT licensed |

*The other columns describe publicly documented behaviour of those approaches; check their own documentation for the current feature set.*

## Requirements

- **Windows 10 or Windows 11, 64-bit.**
- WebView2 runtime — already present on Windows 11 and on any Windows 10 with Microsoft Edge installed.
- That is all for the installed build: no audio driver, no service, no third-party executable.

To build from source you additionally need Node.js 20 or later, pnpm 10, and a stable Rust toolchain with the MSVC target and the WebView2 build tools that Tauri uses.

## Install

1. Open the [Releases](https://github.com/Eververdants/AppAudioRouter/releases) page.
2. Download the `.msi` installer (or the NSIS `.exe` setup) from the newest release.
3. Run it and launch **App Audio Router**.

Prefer building it yourself? See [Build from source](#build-from-source).

## Quick start

1. **Play some sound in the app you want to route.** A program only appears in the process list while it has an active audio session — audio routing is per session, not per shortcut.
2. **Pick it in the sidebar.** One programme at a time is what the ring shows; the circular button at the end of another row adds that programme to the same change.
3. **Click the discs it should play through.** The first one is the device Windows itself drives, and every disc after it receives a copy carrying its own delay and level. One always stays lit: a programme with nowhere to play is not a state this app offers.
4. **Click the circle in the middle of the stage.** While a change is waiting, the hub wears a "click to apply" badge, and its accessible name says exactly what the click will do. Once the route is live, the spokes to those discs stay on the stage, and they flow while the programme is sounding.
5. **Tune a copy if you need to** — its delay and level sit under its own disc.
6. **Turn on Auto-remember** in the settings so the route is restored the next time that program plays.

## Delay compensation explained

Two speakers playing the same audio will not sound in sync if one of them is a Bluetooth headset: the codec and the headset's own buffering add latency that the wired path does not have. Delay compensation makes the audio arrive at both devices at the same moment.

- **Every device carries its own signed value in milliseconds**, measured against the application's audio — not against another device.
- **Positive holds that device back; negative marks it as the earliest device in the route**, which lifts the others instead.
- **Software delay can only be added, never removed.** The earliest device of the group is therefore the reference: it is the one Windows plays directly, and every other device is held back by the difference. The relative difference you configure is reproduced exactly; the absolute value is normalised to the earliest device.
- **The route is applied in delay order**, so the earliest device normally becomes the primary (the one Windows drives). Lowering a delay while a route is running simply shifts the whole group instead of glitching.
- **Range and step are yours to set** in Settings → Delay compensation: ±1/2/5/10 s for the range, 1/10/50/100/1000 ms for the step (10 ms by default). Shrinking the range clamps stored values that no longer fit.
- **A delay needs something to delay.** It is realised by the mirrored copy, so it exists only when at least one further device receives a copy. Route a program to a single device and Windows plays it directly: the value is kept for when you add a second device, and the readout is dimmed with a note saying it is not applied — rather than showing a number that looks like it is doing something.

## Volume balancing explained

Delay fixes *when* the audio arrives; the volume value fixes *how loud* each device is.

- **Each device holds a 0–100 % value.** 100 % leaves the device exactly at the level the application produced; lower values attenuate it. 0 % is silence.
- **The value is relative to the loudest device in the route.** The engine scales each mirrored copy by `own / max`, so software gain only ever attenuates and the loudest device is the reference the others are brought down towards.
- **The primary device's value is not applied to it** — Windows renders that device natively — but it still counts towards the group's reference level, so it determines how much the other devices are attenuated.
- **Like delay, it needs a mirrored copy to act on.** In a single-device route there is no copy and nothing is attenuated; the readout is dimmed and says as much, so a value that does nothing is never displayed as though it were doing something.
- Volumes are stored per device and pushed to any route that is already running, so a change is audible immediately.

## What the reported latency means

The delay value is what you asked for; the reading in that value's tooltip is what the device is doing right now.

- **It is measured per device, from the running stream** — the engine's own pipeline for that device (its base latency plus whatever delay compensation that device is under) plus the latency the endpoint reports for its own stream. It follows the values you set rather than restating them, so changing a delay moves the number.
- **The device Windows plays directly does not report one.** There is no stream of ours on that device to measure, so rather than inventing a figure the tooltip says it cannot be measured.
- **Whatever a codec or a Bluetooth link adds is on top of this, and is not in the number.** That part is not observable from a user-mode program and is not guessed at — treat the figure as a floor for the path, not as the whole of it.

## Level alignment explained

Delay fixes *when* the audio arrives and the device volume fixes *how loud each device* is. Neither of them touches the other problem: one application is simply quieter than another, a game's mix against a voice chat's.

- **Each program carries a 0–400 % level of its own**, applied by the engine to that program's audio on its way to the devices it is duplicated to. 100 % leaves it exactly as the program produced it; below that attenuates, above it amplifies. This is not the application's own volume and never changes it — nothing outside this app sees it, and nothing about it is stored in Windows. Like the device volume and the delay, it acts on the mirrored copies, so the device Windows plays directly is not affected by it.
- **One click aligns all of them.** Every routed program that is currently playing is brought to the loudest one's level, less a small headroom margin.
- **Nothing it measured can clip.** Each gain is bounded by that program's own measured peak — a gain of `1/peak` puts its loudest sample at full scale and cannot put anything past it — and by a ceiling, because past roughly +12 dB a program's noise floor comes up along with its signal. That is why none of this needs a limiter. The bound is against the material that was playing when it was measured, though, and the gain is then stored and reused: a program that was quiet then and is loud later can still be pushed into clipping, so turn it down if you hear it.
- **A program that is not playing is left exactly as it was**, and the log names it. Aligning against silence would be aligning against nothing.
- **Several programs at once still add up at the device**, and that sum happens inside the Windows mixer where this app cannot see it. The headroom margin is a courtesy rather than a guarantee: with many programs playing together, the device volume is still the control that has to move.
- **Only routed programs have a level**, because the level is applied by the engine to the audio it has captured. A program routed to a single device has no engine either — Windows plays it directly — so its node carries no ring. Route it to a second device first and the ring appears.

## How it works

| Step | What happens |
|---|---|
| 1 | `IMMDeviceEnumerator` enumerates the active render (playback) endpoints. |
| 2 | `IAudioSessionEnumerator` enumerates the processes that currently hold an audio session. |
| 3 | `IPolicyConfig` points the selected process's session (for all roles) at the chosen endpoint — the same mechanism Windows' own per-app output setting uses. |
| 4 | For each further device, a **WASAPI process-loopback** capture client for that PID feeds an `IAudioClient` render client on the target device. Delay is implemented as ring-buffer backlog (silence is prepended, never appended, so raising a delay never lets a burst of audio through first); volume is a per-sample gain applied before the samples are written. |
| 5 | Sample formats are parsed from the endpoint's `WAVEFORMATEX` — float32, float64 and PCM 16/24/32 are scaled; anything unrecognised is passed through untouched rather than mangled. A gain of exactly 1.0 short-circuits, so at 100 % the path costs nothing. |
| 6 | Routing rules, delays and levels are persisted as JSON in the application data directory (`route-memory.json`, `device-delays.json`, `device-volumes.json`, `source-volumes.json`). |
| 7 | Each duplication engine reports its end (stopped by the user, the process exited, or an error) through a `duplication-stopped` event, and routes that outlived an app restart are reconciled on boot so the badges match reality. A single device that cannot be opened is reported on its own channel instead (`duplication-mirror-failed`), because the engine carries on for the rest of the route and the UI has to say which device went quiet. |

Routing rules are keyed by **executable name**, not by PID, so a remembered route survives restarts.

## Tech stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | React 19 + TypeScript (strict) |
| Styling | TailwindCSS 3 (utility-first, CSS variables) |
| Animation | Motion (`framer-motion`) |
| Build | Vite 6 |
| State | Zustand |
| i18n | i18next / react-i18next (English, Simplified Chinese) |
| Backend | Rust (edition 2021) with the official `windows` crate — Core Audio, no third-party audio code |

## Project layout

```
AppAudioRouter/
├── src/                          # React frontend
│   ├── components/
│   │   ├── ConcentricStage.tsx   # the ring: the picked programme at the centre, one glass disc per device, one spoke per lit disc; the hub applies the plan
│   │   ├── ProgramRail.tsx       # programmes with an audio session, and whether each one joins the change
│   │   ├── StatusBriefing.tsx    # the "straight talk" pill: where sound is going, in plain words, on demand
│   │   ├── SourceLevelDial.tsx   # a programme's own level, as a ring under the hub
│   │   ├── SettingsPage.tsx      # theme, language, routing, background, delays, about
│   │   ├── LogPanel.tsx          # activity log (the second tab)
│   │   ├── TitleBar.tsx          # custom frameless title bar, with the routed/playing count
│   │   └── ui/                   # Ring, Switch, UnderlineTabs, SegmentedControl, Tooltip, ConfirmButton, …
│   ├── hooks/                    # useTheme, useLanguage, useDelayValue, useBackendEvent, useLiveness
│   ├── stores/routerStore.ts     # Zustand store
│   ├── i18n/locales/             # en.json, zh-CN.json
│   ├── lib/                      # invoke wrapper, stage geometry, delay maths, shared types
│   └── styles/index.css          # Tailwind entry + theme CSS variables
└── src-tauri/                    # Rust backend
    └── src/
        ├── main.rs               # entry point, command registration, close-to-tray
        ├── commands.rs           # Tauri commands (invoke handlers)
        ├── config.rs             # route / delay / volume / shell-settings persistence
        ├── tray.rs               # tray icon, its menu, show and hide
        ├── autostart.rs          # HKCU Run entry for start-with-Windows
        ├── install.rs            # first-run / after-update notice, decided before the window exists
        ├── single_instance.rs    # named mutex + event, so a second launch raises the window
        └── audio/
            ├── devices.rs        # IMMDeviceEnumerator
            ├── sessions.rs       # IAudioSessionEnumerator
            ├── routing.rs        # IPolicyConfig per-process routing
            ├── duplication.rs    # WASAPI process-loopback duplication engine
            └── notifications.rs  # endpoint + session change callbacks
```

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
pnpm exec tsc --noEmit         # type check
pnpm build                     # tsc -b && vite build
cd src-tauri
cargo fmt -- --check
cargo clippy -- -D warnings
cargo check
```

The CI workflow runs the frontend type check and build on Linux, `cargo fmt` / `check` / `clippy` on Windows, and `cargo audit` before a tagged release is built.

## FAQ

### Is App Audio Router free?

Yes. It is open source under the MIT licence, and there is no paid tier or account.

### Can I send one application to two (or more) audio devices at the same time?

Yes — that is the main reason the app exists. Select several devices on the board and confirm; the first device is driven natively by Windows and every additional device gets a mirrored copy of the same stream in real time.

### Does it need a virtual audio driver such as VB-CABLE?

No. All routing, duplication, delay and gain is done by calling the Windows Core Audio API directly from the app's Rust binary. Nothing is installed into the audio stack, and uninstalling the app leaves no driver behind.

### Will it work with a program that is already running?

Yes. Routing is applied to the live audio session, so the program does not need to be restarted — a game or browser tab keeps playing while it moves to the new device.

### After I stop a route, does the program follow the system default again?

Yes, and that is the point of 2.1.1. While a program is routed, Windows has a fixed output device stored for it — that is the mechanism that moves a running program's audio — and that stored device outranks the system default. Stopping the route, quitting the app and **Settings → Reset per-app output** each release it, so the program follows the default device again, including every device you pick afterwards. If Windows refuses to release it, the log says which device the program is still fixed to instead of pretending the route is gone; the volume mixer's own **Reset** for that app clears it too. Versions before 2.1.1 left the device fixed after a stop, which is why a program could keep playing to the old device — or ignore your device switches — until the reset was done.

### What does the app say on the first launch after an update?

One thing, once. Windows stores a program's output device per executable and keeps that stored device after the program exits, so a version that stopped a route without handing it back (2.1.1 and earlier) can leave a program fixed to one device — it stops following the devices you switch to in Windows, and no reboot helps. Nothing in the app can tell such a leftover from an assignment you made by hand in the volume mixer, so rather than clearing anything on its own, the app says so on the first launch after the update and offers **Reset per-app output** right there. Ignore it if no program is misbehaving. A fresh install gets a two-line welcome instead, which points at the reset as well. Each notice appears once per version — the version that last ran is recorded in `install-state.json` — and both are written to the log.

### Can it fix the delay between a Bluetooth headset and wired speakers?

Yes, that is what delay compensation is for. Measure or estimate how far behind the Bluetooth device is, then give the faster device that value as a positive delay (for example `+180 ms`). Positive values hold a device back; a negative value marks it as the earliest device in the route.

### Why is my application not in the process list?

A program only shows up while it holds an active audio session, so start playback in it — the list notices on its own, or press **Refresh**. Programs that use ASIO or WASAPI exclusive mode never create a session with the system audio engine and will not appear, and system-critical processes are deliberately excluded from routing.

### Where are the settings stored?

In plain JSON files in the application data directory: `route-memory.json` (executable → device list), `device-delays.json` (device → milliseconds and the configured range), `device-volumes.json` (device → percent), `source-volumes.json` (executable → level percent, which may be above 100), `app-settings.json` (whether the close button hides the window to the tray) and `install-state.json` (the version that last ran, which is how the app tells an update from a fresh install). Theme and language are browser-side preferences of the window itself, kept in its local storage. The one thing outside those files is the optional startup entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which is also what the "Start with Windows" switch reads back. Remembered routes are keyed by executable name, so they apply to the program wherever it is launched from.

### Can the delay calibrate itself automatically?

Not the part that matters, and it is worth saying exactly why. Everything this app controls is already measured and shown: for each device you can see the pipeline the engine is holding for it plus the latency that endpoint reports for its own stream, live, as you change the delay. That is the half that used to be guesswork.

The other half is what a codec or a Bluetooth link adds after the audio leaves Windows, and a program cannot observe that from user mode — the only way to measure it is to play a tone out of each device and record the room with a **microphone**, then line the recordings up. This app does not ask for your microphone and does not guess at what it cannot hear, so the delay you set stays yours to place by ear. The numbers on screen are what make that quick rather than blind.

### Can it give me more channels than a virtual-cable mixer?

There is no channel count to raise, because this is not a bus mixer. Each routed program gets its own engine instead of a strip on a shared bus, so the programs are independent of one another and nothing caps how many of them — or how many devices — you route at once. That also means there is no bus count to run out of, which is the limit people hit with Voicemeeter's three, five or eight buses.

### Why is a program missing from the level list?

Because it is not being routed. The level is applied by the duplication engine to the audio it has already captured, so a program with no engine has no such path and nothing to set. Route it first, then set or align its level.

### Does the level change my application's own volume?

No, and that distinction is deliberate. The level is a gain this app applies to the audio it captured from that program, on its way to the devices it was duplicated to; the program itself, and anything Windows stores about it, is untouched. Take a program's level down to silence and its own volume slider has not moved — though note that, like the device volume and the delay, it does not reach the one device Windows plays directly.

### Does it run in the background or poll the audio devices?

It never polls, and there is no service. The app registers for the audio engine's own change notifications and re-reads a list when Windows reports that something moved — that is how the device and process lists stay current on their own. Otherwise it talks to the audio engine only when you refresh a list, change a device value or apply a route. While a route is active, the duplication engine for that process runs; when you stop routing, the engine is torn down.

While a route is active, the engine is only as busy as the sound it carries. An audio device has to be fed every few milliseconds for as long as a stream is open, so an engine that kept writing silence at a program that was not playing would hold the CPU out of its low-power states indefinitely — a cost that shows up as fan noise rather than in any CPU figure. So when a routed program has produced nothing for a second and a half, the engine stops feeding its mirrored devices and parks until the program plays again. The first sound after a pause comes out at the same latency as any other, because the pipeline depth is rebuilt before the device is fed again.

The interface is not left redrawing anything either: there is no decorative animation to leave running — no drifting backdrop, nothing that moves because it looked nice. Exactly two things move, because each reports something true: the dash running along the spokes of a programme that is sounding, and the pulse beside one that is. Both stop existing the moment nobody is watching — window hidden, focus elsewhere, or the system asking for less motion — so a resting window repaints nothing at all.

### Can I run two copies of the app at once?

No, and deliberately so. Starting the app again when it is already running brings the existing window to the front instead of starting a second process: two instances would fight over the same configuration files and the same audio devices, and a second tray icon for one routing engine is nothing but a way to lose track of which copy is doing what. A second launch during a silent start-with-Windows start raises the window too, so you are never left clicking a shortcut that appears to do nothing. (A separate Windows logon session, such as a second RDP session, gets its own instance — the audio engine is per session, so there is nothing for them to fight over.)

### One device in my route is silent — how do I find out which?

The log tells you. A device that could not be opened for mirrored playback drops out of the route's device count and produces an entry naming that device and the error, while the remaining devices keep playing. Nothing is retried behind your back; re-apply the route (or re-plug the device) once it is available again.

### Does the app keep routing after I close the window?

By default, closing the window quits the app, and a route that needed a mirrored copy stops with it — every program the app had fixed to a device is handed back to the system default on the way out. Turn on **Settings → Background → Minimize to tray when closed** and the close button hides the window instead: routing keeps running and the tray icon brings the window back. **Quit** in the tray menu always stops everything, switch on or off.

### Can it start automatically with Windows?

Yes. **Settings → Background → Start with Windows** adds a single value for your own user under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`; nothing is written to `HKLM`, no administrator rights are needed, and no window opens — it launches into the tray so remembered routes are ready first. The app reads that registry value back rather than a copy of its own, so if you toggle startup off in Task Manager, the switch shows that.

### Is macOS or Linux supported?

No. The routing mechanism is built on Windows Core Audio, so the app is Windows-only (Windows 10 and 11, 64-bit).

## Limitations and notes

- A program must be running and producing sound to appear in the process list — routing works on live audio sessions, so a program that never plays any has nothing to move.
- Remembered routes are matched on executable name, not on a path or a PID.
- Delay compensation can only *add* latency. The earliest device of the group is the alignment reference and cannot be pulled earlier — that is why routing is applied in delay order.
- A mirrored copy is buffered for stability (about 100 ms of pipeline latency) so that all mirrors play the same sample at the same moment. Alignment between mirrored devices is exact; the offset to the primary device, which Windows plays natively, is inherent to capturing and re-rendering the stream.
- Volume can only attenuate, so the loudest device in the group is the reference and cannot be pushed below the level the application produced on it.
- Delay and volume act on mirrored copies only, so neither does anything in a single-device route; the values are kept for when you add a second device.
- Routes for system-critical processes are refused rather than half-applied.
- A routed program carries a **fixed output device** while its route is live, and Windows keeps that device stored per executable — even after the program exits. It is given back when the route stops, when the app quits, when the program is next seen playing after having exited while routed, or by **Settings → Reset per-app output**. A program that an earlier version left fixed keeps ignoring the system default until one of those happens (the volume mixer's own **Reset** for that app works too).
- Releasing a fixed output device needs the program to be running, because the audio service is addressed by process; a program that is closed keeps its device until it plays again.

## Contributing

Issues and pull requests are welcome at [Eververdants/AppAudioRouter](https://github.com/Eververdants/AppAudioRouter). Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are kept small and focused, one concern per commit; the conventions used across the codebase are documented in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © 2026 Eververdants
