# netBeat

A TypeScript library for observing DJ hardware over the network — in read-only
mode — so that other software (lighting, visuals, DMX, show-control) can
synchronize itself to what a DJ is doing live without needing to analyze the
audio stream.

> **Status:** pre-alpha. Observer mode works end-to-end with live beat
> sync, CDJ status, mixer status, channels-on-air, CDJ-3000 absolute
> position, and track metadata (phrases, beat grid, cues) via NFS or
> local USB export. Verified against real XDJ-XZ hardware.

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
| Pioneer Pro DJ Link (CDJs, XDJs, DJM mixers, rekordbox) | **active** | Beat sync, status, phase tracking, track metadata (phrases, beat grid, cues via NFS/filesystem). |
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

## Quick start

```bash
bun install
bun run packages/cli/src/index.ts observe --interface 10.255.0.77
```

This announces as a virtual CDJ on the specified interface and streams
discovered devices, beats, CDJ status changes, mixer status, and
channels-on-air to the terminal.

### Live beat pulse display

```bash
# Minimal — pulsing beat indicator per deck, track IDs on load
bun run packages/cli/src/index.ts pulse --interface 10.255.0.77

# With metadata — track names, BPM, key, and current phrase section
bun run packages/cli/src/index.ts pulse --interface 10.255.0.77 --media /path/to/usb
```

Shows a 4-dot beat bar per deck that flashes in sync with the music
(cyan on downbeat, white on beats 2–4, smooth 24-bit color fade).
Track loads print as permanent log lines; with `--media` pointed at a
rekordbox USB export, you also get artist/title/key and live phrase
labels (intro, chorus, outro, etc.).

### Capturing data for offline analysis

```bash
# JSONL output — one JSON object per parsed event
bun run packages/cli/src/index.ts observe --interface 10.255.0.77 --json > session.jsonl

# Also capture raw packets for debugging
bun run packages/cli/src/index.ts observe --interface 10.255.0.77 --json --dump raw.jsonl > session.jsonl

# Passive mode (no announce — misses unicast CDJ status)
bun run packages/cli/src/index.ts observe --interface 10.255.0.77 --passive --json > passive.jsonl
```

### What data is available

| Event | Source | Notes |
|-------|--------|-------|
| `device` | keep-alive (port 50000) | Device appear/disappear, type, IP |
| `beat` | port 50001, kind 0x28 | BPM, pitch, beat-in-bar (1-4). Requires rekordbox-analyzed tracks. |
| `status` | port 50002, kind 0x0a | Play state, master/sync/on-air flags, track ID, BPM, pitch |
| `mixerStatus` | port 50002, kind 0x29 | Standalone DJM master authority, BPM |
| `onAir` | port 50001, kind 0x03 | Per-channel on-air state from DJM mixers |
| `position` | port 50001, kind 0x0b | CDJ-3000 only: playhead ms, track length, pitch, BPM |
| `phase` | computed | Sub-beat/bar phase interpolated between beats |
| `trackAnalysis` | NFS or filesystem | Phrases (PSSI), beat grid, cue points, track metadata (title, artist, key, BPM) |

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
