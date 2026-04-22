# netBeat

A TypeScript library for observing DJ hardware over the network — in read-only
mode — so that other software (lighting, visuals, DMX, show-control) can
synchronize itself to what a DJ is doing live without needing to analyze the
audio stream.

> **Status:** pre-alpha. Observer mode (device discovery via keep-alive
> packets) works end-to-end; beat and status parsing are in progress.

## Goals

- **Observe, don't control.** This library listens to device announcements and
  status packets. It never sends commands that change player state.
- **Expose the data DJs have already labeled.** Modern Pioneer / rekordbox
  workflows let a DJ pre-analyze a track and mark sections (intro, buildup,
  drop, outro, hot cues, memory cues). These labels are broadcast over the
  network — we want to surface them in a stable, typed API.
- **Real-time beat phase.** Decks broadcast beat packets with sub-beat phase
  information and live BPM that tracks the DJ's pitch fader. Light shows that
  sync on phase (not just tempo) look dramatically tighter.
- **Multi-deck awareness.** A DJ usually has 2–4 decks layered. The library
  reports per-deck state plus which deck the mixer considers "master" for
  tempo.
- **Reusable.** Published as a normal npm package with typed exports, usable
  from any Node.js / Bun / show-control tooling.

## Scope

| Protocol | Status | Notes |
|----------|--------|-------|
| Pioneer Pro DJ Link (CDJs, XDJs, DJM mixers, rekordbox) | planned, first focus | Most prior art exists here |
| Denon StageLinQ (Prime series) | future | Will slot in after the Pioneer surface is stable |

## Repository layout

This is a [Bun workspaces](https://bun.sh/docs/install/workspaces) monorepo.

```
netBeat/
├── packages/
│   ├── prolink/   # Pioneer Pro DJ Link protocol implementation
│   └── cli/       # Diagnostic CLI (sniff / dump state from real hardware)
├── docs/
│   └── research.md  # Prior art, protocol references, notes
├── tsconfig.base.json
├── biome.json
└── package.json
```

## Prior art

We stand on the shoulders of a lot of reverse-engineering work. See
[`docs/research.md`](docs/research.md) for the full reading list and credits.

## Development

```bash
bun install           # install workspace dependencies
bun run typecheck     # type-check all packages
bun test              # run tests
bun run lint          # biome check
bun run format        # biome format --write
```

## License

[MIT](LICENSE) © Cameron Tacklind
