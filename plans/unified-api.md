# Unified Observer API — implementation plan

Working plan for making `@netbeat/prolink`, `@netbeat/stagelinq`, and a new
`@netbeat/core` package share an interchangeable Observer interface.

## Goal

A consumer writes code against **one interface** and it works regardless of
which DJ hardware is on the network — Pioneer, Denon, or both simultaneously.
The three packages' Observer classes are entirely interchangeable:

```typescript
import { Observer } from '@netbeat/core';      // auto-detects both
import { Observer } from '@netbeat/prolink';    // prolink only, same shape
import { Observer } from '@netbeat/stagelinq';  // stagelinq only, same shape
```

The primary use case is: `observer.phase` — poll it in a render loop to get
the current beat phase. Everything else (device events, deck state, track
info) is secondary but should also be unified.

## Environment / context

- **Monorepo:** `C:\Users\camer\git\Personal Projects\netBeat`
- **Runtime:** Bun 1.3.0 / Node >=20, TypeScript 6.0.3, strict mode
- **Style:** Biome (2-space, single quotes, 100-col, LF)
- **Test framework:** `bun:test`
- **Breaking changes OK** — packages have never been published

## Decisions already made (don't re-ask)

1. **Common types live in `@netbeat/core`.** Both protocol packages depend on
   core for the interface. Core does NOT depend on prolink or stagelinq —
   the UnifiedObserver accepts any `Observer[]` via constructor injection.
2. **Structural subtyping.** Protocol-specific types extend the common types
   (e.g., prolink Device has extra `playerId`, `mac`, `rawType` fields).
   Thanks to TS structural typing, they satisfy the common interface.
3. **String deck IDs.** `Device.id` and `DeckState.id` are opaque strings.
   Format: prolink uses `"prolink:{playerId}"`, stagelinq uses
   `"stagelinq:{shortUuid}:{deckNum}"`.
4. **Phase tracking for stagelinq.** StageLinQ's BeatInfo gives continuous
   sub-beat position; a new PhaseTracker interpolates between updates to
   produce the same PhaseState shape as prolink.
5. **`onDeckUpdate` fires on meaningful state changes** (play/pause, BPM,
   track, master, on-air) — NOT on every BeatInfo tick.
6. **DeviceCategory standardized:** `'player' | 'controller' | 'mixer' | 'unknown'`.
   StageLinQ's `'other'` becomes `'unknown'`.

## Common types (in @netbeat/core)

```typescript
type Protocol = 'prolink' | 'stagelinq';
type DeviceCategory = 'player' | 'controller' | 'mixer' | 'unknown';
type DeviceEvent = 'added' | 'updated' | 'removed';

interface Device {
  readonly id: string;
  readonly name: string;
  readonly category: DeviceCategory;
  readonly address: string;
  readonly deckCount: number;
  readonly protocol: Protocol;
}

interface TrackInfo {
  readonly title: string | null;
  readonly artist: string | null;
}

interface PhaseState {
  readonly beat: number;           // [0, 1) within current beat
  readonly bar: number;            // [0, 1) within current bar
  readonly beatInBar: number;      // 1-4
  readonly bpm: number;
  readonly beatElapsed: number;    // seconds since last beat
  readonly beatRemaining: number;  // seconds until next beat
  readonly barElapsed: number;     // seconds since last downbeat
  readonly barRemaining: number;   // seconds until next downbeat
}

interface DeckState {
  readonly id: string;
  readonly device: Device;
  readonly deckNumber: number;     // 1-based
  readonly isPlaying: boolean;
  readonly bpm: number;
  readonly phase: PhaseState | null;
  readonly isMaster: boolean;
  readonly isOnAir: boolean;
  readonly track: TrackInfo | null;
}

interface Observer {
  start(): Promise<void>;
  stop(): Promise<void>;

  onDevice(listener: (event: DeviceEvent, device: Device) => void): () => void;
  onDeckUpdate(listener: (deck: DeckState) => void): () => void;

  devices(): Device[];
  decks(): DeckState[];
  getDeck(deckId: string): DeckState | null;

  readonly phase: PhaseState | null;
  getPhase(deckId: string): PhaseState | null;
  phases(): PhaseState[];
}
```

## Package dependency graph

```
@netbeat/core (types + UnifiedObserver)
    ↑               ↑
    |               |
@netbeat/prolink   @netbeat/stagelinq
    ↑               ↑
    └───────┬───────┘
        @netbeat/cli
```

Core has zero dependencies on protocol packages. The UnifiedObserver accepts
`Observer[]` — CLI (or any consumer) creates the protocol observers and
passes them in.

## Mapping: prolink → common

| Prolink internal | Common field |
|---|---|
| `Device.id` (number) | kept as `playerId`; `Device.id` = `"prolink:${playerId}"` |
| `Device.ip` | `Device.address` |
| `Device.type` ('cdj') | `Device.category` = 'player' |
| `Device.type` ('mixer') | `Device.category` = 'mixer' |
| N/A | `Device.deckCount` = 1 (CDJ) or 0 (mixer) |
| `CdjStatus.isPlaying` | `DeckState.isPlaying` |
| `CdjStatus.effectiveBpm` | `DeckState.bpm` |
| `CdjStatus.isMaster` | `DeckState.isMaster` |
| `CdjStatus.isOnAir` | `DeckState.isOnAir` |
| `PhaseState` (existing - `playerId`) | `DeckState.phase` (common PhaseState) |
| `TrackAnalysis.metadata.title/artist` | `DeckState.track` |

## Mapping: stagelinq → common

| StageLinQ internal | Common field |
|---|---|
| `StageLinqDevice.deviceId` (UUID) | `Device.id` = `"stagelinq:${shortUuid}"` |
| `StageLinqDevice.model.name` | `Device.name` |
| `StageLinqDevice.model.category` | `Device.category` (with 'other'→'unknown') |
| `StageLinqDevice.address` | `Device.address` |
| StateMap `/Engine/Deck{N}/Play` | `DeckState.isPlaying` |
| StateMap/BeatInfo BPM | `DeckState.bpm` |
| NEW PhaseTracker from BeatInfo | `DeckState.phase` |
| N/A (no master concept) | `DeckState.isMaster` = false |
| Channel fader > 0 (heuristic) | `DeckState.isOnAir` |
| StateMap SongName/ArtistName | `DeckState.track` |

## StageLinQ phase tracking

BeatInfo gives `beat: number` (continuous, e.g., 5.75 = beat 5, 75% through).
Between updates, interpolate using `performance.now()`:

```
currentBeat = lastBeat + (elapsedMs / (60000 / bpm))
phase.beat = currentBeat % 1
phase.beatInBar = (floor(currentBeat) % 4) + 1
phase.bar = (currentBeat % 4) / 4
```

## Plan / steps

### Step 1 — Create @netbeat/core
- [x] `packages/core/package.json`, `tsconfig.json`
- [x] `src/types.ts` — all common types + Observer interface
- [x] `src/unified.ts` — UnifiedObserver (composite, delegates to Observer[])
- [x] `src/index.ts` — public exports
- [x] Unit tests for UnifiedObserver

### Step 2 — Refactor @netbeat/prolink
- [x] Add `@netbeat/core` dependency
- [x] Prolink Device: add `id: string`, `address`, `category`, `deckCount`, `protocol`, rename numeric id → `playerId`
- [x] Prolink PhaseState: drop `playerId`, add to core interface
- [x] Observer: implement `core.Observer` — add `decks()`, `getDeck(string)`, `onDeckUpdate()`, `phase`, `getPhase(string)`, `phases()` returning common types
- [x] Update all internal references (`device.id` → `device.playerId`)
- [x] Update tests

### Step 3 — Refactor @netbeat/stagelinq
- [x] Add `@netbeat/core` dependency
- [x] Change DeviceCategory `'other'` → `'unknown'`
- [x] Add PhaseTracker (`src/observer/phase-tracker.ts`)
- [x] StageLinqDevice: add common Device fields (`id`, `category`, `address`, `deckCount`, `protocol`)
- [x] Observer: implement `core.Observer` — add `decks()`, `getDeck(string)`, `onDeckUpdate()`, `phase`, `getPhase(string)`, `phases()` returning common types
- [x] Update tests

### Step 4 — Update CLI
- [x] Add `@netbeat/core` dependency + tsconfig reference
- [x] Fix prolink `getPhase(number)` → `getPhase("prolink:{id}")`
- [x] Fix stagelinq `onDevice` callbacks — cast `Device` to `StageLinqDevice`
- [ ] *(Future)* Default mode (no --protocol): use `UnifiedObserver([prolink, stagelinq])`
- [ ] *(Future)* Simplify observe/pulse using common API

### Step 5 — Verify + docs
- [x] Root tsconfig references (all 4 packages)
- [x] `bun install`, typecheck, lint, test — all green (463 tests)
- [x] Update this plan
- [ ] Update README

## Findings / gotchas

- **Stale `dist/` dirs** can cause test failures — compiled test files persist
  from previous builds and Bun picks them up alongside source tests. `rm -rf dist`
  in the affected package fixes it.
- **`DeviceCategory 'other'` → `'unknown'`** required updating both the model map
  entries AND the fallback in `classifyDevice`, plus the test expectation.
- **`onDevice` signature change**: when an Observer `implements CoreObserver`, its
  `onDevice` accepts `CoreDeviceListener` (takes `Device`). Stagelinq-specific
  CLI code that needs `StageLinqDevice` fields must cast — this is intentional,
  since the common interface doesn't expose protocol-specific details.
- **PhaseTracker staleness**: the tracker returns `null` after 5 seconds of no
  BeatInfo updates. This prevents stale phase data from lingering after a device
  disconnects or stops playing.
- **Channel-to-deck mapping** for `isOnAir`: heuristic is deck N → channel N.
  This may not be correct for all setups (e.g., PRIME 4 with 4 decks on 2 channels).
  Defaults to `true` when fader data is unavailable.

## Progress log

- [x] Step 1 — Create @netbeat/core
- [x] Step 2 — Refactor prolink
- [x] Step 3 — Refactor stagelinq
- [x] Step 4 — Update CLI (type fixes; unified default mode deferred)
- [x] Step 5 — Verify + docs (typecheck/lint/test all green)

## Things not to do

- Don't break protocol-specific APIs — add common methods alongside, don't remove native ones.
- Don't make core depend on prolink or stagelinq — keep the dependency arrow one-way.
- Don't fire `onDeckUpdate` on every BeatInfo tick — too noisy.
- Don't parse deck IDs — they're opaque strings for lookup only.
