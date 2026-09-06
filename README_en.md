# App Audio Router

## Introduction

App Audio Router is a Windows per-application audio routing tool that allows users to route a specific application's audio output to a designated audio device. It is built with Tauri v2: the frontend uses React 19 + TypeScript + TailwindCSS, while the backend is Rust calling the Windows Core Audio APIs directly — **no third-party exe dependencies**.

## Features

- Enumerate processes that have active audio sessions
- Enumerate audio rendering devices
- Route a specific process's audio output to a designated device
- Automatically remember routing rules (persisted across restarts)
- Concentric-circle UI with ripple animation on routing actions
- Light / Dark theme toggle

## System Requirements

- Windows 10/11
- For building from source: Node.js LTS, pnpm, Rust stable

## Development and Build

```bash
# Install dependencies
pnpm install

# Development mode (hot reload)
pnpm tauri dev

# Build (produces an MSI installer)
pnpm tauri build
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | Tauri v2 |
| Frontend | React 19 + TypeScript (strict) |
| Styling | TailwindCSS v4 |
| Animation | Motion (`framer-motion`) |
| Build | Vite v6 |
| Backend | Rust (`windows` crate, official Core Audio API bindings) |

## How It Works

1. The Rust backend enumerates rendering devices via `IMMDeviceEnumerator`
2. Enumerates processes with active audio sessions via `IAudioSessionEnumerator`
3. Routes a process session to the target device via `IPolicyConfig`
4. Routing rules (executable name → device ID mapping) are persisted by the Rust side to the app data directory

## Project Structure

```
AppAudioRouter/
├── src/            # React frontend
│   ├── components/ # Concentric router, process list, device list, log panel, etc.
│   ├── hooks/      # Custom hooks for device/process polling, theme, etc.
│   ├── stores/     # Frontend state management
│   └── lib/        # Tauri invoke wrappers and shared types
└── src-tauri/      # Rust backend
    └── src/
        ├── commands.rs    # Tauri commands
        ├── config.rs      # Config persistence
        └── audio/         # Device enumeration, session enumeration, routing
```

## Notes

- A target app must be running and producing sound to appear in the process list
- The auto-memory feature is based on the process executable name, not the PID
- Audio routing is not supported for system critical processes
