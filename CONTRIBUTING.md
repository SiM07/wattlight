# Contributing

Thanks for helping! Bug reports, hardware compatibility notes and pull requests are all welcome.

## Getting started

```bash
npm ci
npm run sandbox   # runs the whole app without any hardware
npm run check     # typecheck, lint and tests: must pass before a pull request
```

Node.js 22.18 or later is required: tests and scripts run TypeScript directly.
No Hue bridge or sensor is needed to work on most of the code: `src/fakes.ts` provides in-memory
stand-ins, used by the tests and by `--sandbox`.

## Conventions

- Code, comments, identifiers and commit messages are in English.
- No user-facing text in the code: the engine publishes status and error codes, and the text lives in
  `src/shared/locales/`. Add every new key to `en.ts` (the reference) and `fr.ts`.
- Keep the UI framework-free and the dependencies few: every dependency ends up in the bundles.
- TypeScript is checked in strict mode with `erasableSyntaxOnly` (no `enum`, no `namespace`, no parameter properties).
- Add or update tests in `test/` for behavior changes, and an entry in `CHANGELOG.md`.

## Testing with real hardware

- `npm run demo` drives your real Hue lights with a simulated sensor.
- `node dist/src/main.js scan` lists the sensors in range.
- `node dist/src/main.js run` runs headless and prints every status change.

When reporting a hardware issue, please include the sensor model, the operating system and the logs
(see the bug report template).
