# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - Unreleased

### Added

- Desktop app in a native window (system webview: WebKit, WebView2, WebKitGTK), with a browser fallback.
- First-run setup: Hue bridge discovery (mDNS and Philips service) and pairing, lights picker with blink, power or heart rate, FTP or max HR, sensor search.
- Power / heart rate switch on the main screen; power is the default.
- Settings sheet: FTP, max HR, lights, brightness, fade duration, restore on pause, sensors, bridge, language.
- Status messages with automatic retries: Bluetooth off or not allowed, sensor not found, connection lost, no data, no skin contact, Hue bridge unreachable or pairing revoked.
- Light color test through every zone.
- English and French interface, following the system language.
- Demo mode (simulated sensor) and sandbox mode (no hardware at all).
- Portable bundles with an embedded Node.js runtime for macOS (arm64, x64), Windows (x64) and Linux (x64, arm64).
- Linux Bluetooth through BlueZ over D-Bus: no root needed.
- Single instance: launching the app again brings the existing window to the front.

### Changed

- Rewritten in TypeScript.
- Settings are saved atomically, in `%APPDATA%\wattlight` on Windows.
- The terminal setup is replaced by the in-app setup; `run` and `scan` remain.

## [0.1.0] - 2026-11-08

### Added

- Command-line tool: Hue light color following the power or heart rate training zone, terminal setup, demo mode.
