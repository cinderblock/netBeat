# Pioneer Pro DJ Link — implementation plan

> Working plan for the Pioneer side of netBeat. Denon StageLinQ will get
> its own file (`plans/denon-stagelinq.md`) when that work begins.
>
> **Read this first** at the start of any session on netBeat. Update it
> after any non-trivial finding, before long-running steps, and at the end
> of a session. A stale plan is worse than no plan.

## Goal

Build a TypeScript library that lets show-control / lighting / visual
software synchronize to what a DJ is doing live, by reading data directly
from the DJ network rather than analyzing audio. Concretely we want:

- **Live beat sync**: sub-beat phase + BPM that tracks the pitch fader in
  real time. The headline use case — a lighting rig that follows the DJ's
  tempo cleanly, not a beat-detector guessing at an audio stream.
- **Per-deck state**: track ID, play/pause, which deck the mixer treats as
  master, channels-on-air.
- **Pre-labeled track structure**: intro / buildup / drop / outro / hot
  cues / memory cues / phrases (melody vs. vocals). These exist because
  the DJ already analyzed the track in rekordbox; we want to surface them
  in a stable typed API so light cues can fire on known boundaries.
- **Multi-deck awareness**: 2–4 decks layered, with master selection.

Pioneer Pro DJ Link is the first target (most prior art, most user
hardware). Denon StageLinQ is planned as a second protocol once the
Pioneer surface stabilizes.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\netBeat\`
  (GitHub `cinderblock/netBeat`).
- Bun workspaces monorepo. `packages/prolink` (`@netbeat/prolink`,
  protocol library) + `packages/cli` (`@netbeat/cli`, diagnostic tool
  that dogfoods the public API).
- Node ≥ 20, TypeScript strict, NodeNext ESM, `composite` project refs,
  `exactOptionalPropertyTypes` on. Biome for lint + format (2-space,
  single quotes, 100-col, LF). `bun test` for tests.
- Platform: Windows (CRLF warnings are expected; ignore).
- Target hardware: Pioneer XDJ + CDJ-3000 + (future) DJM mixer. User has
  an XDJ on hand but wants to minimize its power-on time, so fixture-
  first development is mandatory.
- Nothing committed yet. Working tree is clean of staged changes; the
  scaffold + observer mode are sitting as untracked.
- Global rules in `~/.claude/CLAUDE.md` apply: shared working tree, never
  run `git checkout -- <file>` / `git restore` / `git reset --hard`, only
  stage own changes, take a safety stash before any destructive git op.

## Decisions already made (don't re-ask)

1. **Monorepo split stays.** `prolink` = protocol library, `cli` =
   diagnostic tool that depends on it via `workspace:*`. Keeps the library
   publishable with zero CLI deps; leaves room for a sibling
   `packages/stagelinq` when Denon work starts; forces us to dogfood the
   public API through the CLI.
2. **"Read-only" = never mutate deck state.** Two distinct modes sit
   under that umbrella:
   - **Passive mode** (`passive: true`) — binds receive sockets, sends
     *nothing*. Gets keep-alives, beats, mixer channels-on-air, CDJ-3000
     absolute-position. Misses unicast-gated CDJ status + all metadata.
   - **Observer mode** (default) — announces as a virtual CDJ every
     1.5 s so peers unicast their status to us. Can later issue
     remotedb/NFS metadata queries. Never sends sync, master-handoff,
     tempo, load-track, or fader-start packets.
3. **Observer defaults.** Device `id = 7` (outside 1–4, which real CDJs
   claim). Device `name = 'netbeat'` (≤ 20 ASCII chars). Network
   interface passed explicitly by the caller — no auto-pick in v1 (multi-
   NIC hosts exist and guessing wrong is silent).
4. **Claim-protocol shortcut.** Skip the 3-phase handshake (kinds
   `0x0a` / `0x00` / `0x02` / `0x04`). Keep-alive (kind `0x06`) only.
   prolink-connect does the same and it works in the field. Documented
   in `observer/announcer.ts`. Revisit only if real hardware rejects us.
5. **API shape.** Event-driven + pollable snapshot. `on('device', ...)`
   exists now; `on('beat', ...)`, `on('status', ...)`, `on('deck', ...)`
   land as parsers do. `getState()` returns a decks-and-master snapshot.
   `onPacket(...)` stays as an escape hatch for prototyping new parsers.
6. **Legal posture: reference-only.**
   - No copied source from prolink-connect (MIT), Dysentery (EPL), or
     beat-link (EPL — observe-only).
   - Cite decisions in code comments where a byte layout or cadence came
     from specific prior art (e.g. `// per dysentery vcdj.adoc §Keep-alive
     packets`).
   - One deferred exception: if/when we build metadata, we may port
     `rekordbox_anlz.ksy` (Kaitai Struct) verbatim with attribution, as
     it's structured-data spec more than code. Add
     `THIRD_PARTY_NOTICES.md` at that point.
7. **Fixture-first testing.** Parsers are built from spec with hand-
   crafted byte-array fixtures, each annotated with the spec citation it
   was synthesized from. A round-trip helper (builder → bytes → parser)
   catches symmetric bugs. CI has no hardware dependency. A `netbeat
   record` CLI subcommand (not yet built) will harvest real fixtures
   once the XDJ powers on; a `netbeat replay` subcommand will re-emit a
   captured pcap on loopback so the state machine runs end-to-end
   without hardware.
8. **Metadata path is deferred.** Both remotedb TCP (prolink-connect
   primary) and NFS local-DB scrape (Crate Digger style) are large
   undertakings. Re-evaluate once packet parsing is solid and we know
   whether the 4-real-CDJ case (no free ID for us) actually bites the
   user's scenes.
9. **Publishing identity.** `package.json` points at
   `https://github.com/cinderblock/netBeat.git`. Packages are scoped as
   `@netbeat/...`. Flag if either is wrong — both were inferred.

## Live session notes (2026-04-22)

User powered on the XDJ-XZ on the main 10.255.0.0/20 subnet and asked
me to try to talk to it. This is a fixture-harvest opportunity; get
the XDJ's presence confirmed and capture what we can, then let the
user power it back off. Host NICs on that subnet:

- `vEthernet (VLAN-vSwitch)` 10.255.0.77/20 (wired via Hyper-V vSwitch)
- `Wi-Fi 2` 10.255.6.146/20

**First contact (vSwitch interface, 15 s observe run):**

- XDJ-XZ IP: **10.255.4.69**, on the same /20 broadcast domain.
- Announces as three virtual devices, confirming the XZ's combo nature:
  | ID | Type  | Name   | Role |
  |----|-------|--------|------|
  | 1  | cdj   | XDJ-XZ | Deck 1 |
  | 2  | cdj   | XDJ-XZ | Deck 2 |
  | 33 | mixer | XDJ-XZ | Built-in mixer (0x21 = standard mixer slot) |
- Kind `0x06` keep-alives on port 50000: 54 bytes each, ~1.5 s cadence.
- Kind `0x0a` CDJ status on port 50002: **292 bytes**, ~10 packets/sec,
  unicast to our observer port. The claim shortcut (decision #4 — no
  3-phase handshake, just emit kind-`0x06`) **works in the field on
  real hardware**. Passive mode would have gotten nothing at 50002.
- No kind `0x28` beats on 50001 — see capture session below.
- XZ's keep-alive source port is **ephemeral** (33708, 38741, …) not
  50000. Unusual vs. the textbook protocol, but protocol identifies
  peers by source IP + announced id, so it's cosmetic. Worth noting
  if any future code assumes peers always talk from 50000.
- Our own announcements echo back from 10.255.0.77:50000 (observer
  `isSelf` filter suppresses them from device events; they still show
  in `--raw`).
- Host firewall did not prompt; incoming UDP was allowed through.
- Bun 1.3.0, Node 20, TS compile clean, CLI runs directly via
  `bun run packages/cli/src/index.ts observe --interface <ip> --raw`.

**Capture session (same day, second conversation):**

Added `--dump <file>` flag to CLI `observe` command (JSONL: ts, kind,
port, src, len, base64 data). Ran ~20-minute capture session against the
live XDJ-XZ. Results in `captures/xdj-xz-session.jsonl` (12 MB,
32,558 packets, gitignored).

Captured:
- 19,050 CDJ status (kind `0x0a`, 292 bytes, port 50002)
  - 10,723 from Deck 1 (player id=1), 8,456 from Deck 2 (player id=2)
  - 64 unique BPM values from Deck 1 (pitch fader exercise)
  - Play state byte at `0x89` always `0x84` (playing?)
- 13,510 keep-alives (kind `0x06`, 54 bytes, port 50000)
- **Zero** beat packets on port 50001 (confirmed socket works via
  localhost test packet)

Key findings:
- **XDJ-XZ sends zero traffic on port 50001** — no beat packets
  (`0x28`), no channels-on-air (`0x03`), nothing. Confirmed the
  socket is bound and functional (localhost test packet received).
  Hypothesis: beats only fire when the track has rekordbox analysis
  data (beat grid). The test tracks were **not** rekordbox-analyzed.
- **BPM is in CDJ status** at offsets `0x92-0x93` (u16 BE, ×100).
  Changes in real time as the pitch fader moves.
- **Beat counter (`0x5C-0x5F`) and beat-within-bar (`0x55`) are
  always zero** — no phase info without rekordbox analysis.
- **Pitch values** at `0x8E-0x8F`, `0x9A-0x9B`, `0xC2-0xC7` — two
  distinct settings captured (0xFE5C and 0xA43F).
- Player id at offset `0x21`.

Operational issues encountered:
- **Bun had no Windows Firewall rule.** Ports 50001/50002 received
  nothing until `New-NetFirewallRule -DisplayName "Bun" -Direction
  Inbound -Program ... -Action Allow -Profile Any` was added. Port
  50000 worked anyway because outbound broadcasts create temporary
  holes for return traffic.
- **Zombie process from killed monitor** held duplicate `reuseAddr`
  sockets on 50001/50002, stealing packets from the live capture.
  Fix: `taskkill /F /PID <zombie>`.

**Second capture (same day, rekordbox-analyzed tracks):**

User installed rekordbox, analyzed tracks, exported to USB. Restarted
capture after closing rekordbox (which was holding ports 50000-50002).

New data appended to `captures/xdj-xz-session.jsonl` (now 12 MB,
35,337 packets total). New kinds captured:

- **412 beat packets (kind `0x28`, port 50001, 96 bytes).** Confirmed:
  beats only fire with rekordbox-analyzed tracks.
  - Player 1: 283 beats, BPM 77.59–97.09 (37 unique), beat-within-bar
    cycles 1–2–3–4, 3 unique pitch values.
  - Player 2: 156 beats, BPM 112.91–164.59 (21 unique), beat-within-bar
    cycles 1–2–3–4, 2 unique pitch values.
  - **96 bytes, not 60** as documented for CDJ-2000nxs. XDJ-XZ uses
    an extended beat packet format.
  - Layout (96-byte XDJ-XZ variant, confirmed from real data):
    `0x21` player id, `0x5A-0x5B` BPM (u16 BE ×100),
    `0x54-0x57` pitch (u32 BE), `0x5C` beat-within-bar (1..4).
    Beat timing intervals at `0x26-0x3D` (next beat, 2nd beat,
    next bar, etc. in ms).
- 20,565 CDJ status (0x0a) total across both sessions.
- Status packets from analyzed tracks now show non-zero beat counters
  and beat-within-bar.

Operational: rekordbox holds ports 50000–50002 while running. Must
close it before starting observer capture.

## Plan / steps

Ordered by what to tackle next. Revise in place when the approach
changes. Current step is marked **→**.

1. **Scaffold + passive/observer discovery** — done. `Observer`,
   `DeviceManager`, `Announcer`, `UdpTransport`, keep-alive parser +
   builder, CLI `observe` subcommand.
2. **Beat packet parser** (port 50001, kind `0x28`, 96 bytes) — done.
   `parseBeat()`, `buildBeat()`, `decodePitch()`, `encodePitch()` in
   `packets/beat.ts`. `Observer.onBeat()` dispatches parsed beats with
   per-player dedup (XDJ-XZ sends each beat twice). 30 tests including
   two real XDJ-XZ captures. Verified live: 4.5 ms avg timing error,
   perfect 1-2-3-4 cycling, 56 ms jitter at ~87 BPM.
3. **CDJ status parser** (port 50002, kind `0x0a`, 292 bytes) — done.
   `parseStatus()`, `buildStatus()` in `packets/status.ts`. Exposes
   `playState`, `isMaster`, `isSync`, `isOnAir`, `trackBpm`, `pitch`,
   `effectiveBpm`, `trackId`, `beatCounter`, `beatInBar`. Plus
   `PlayState`, `TrackSlot`, `TrackType` enum constants. Observer
   gains `onStatus()`, `getMasterPhase()`, `getMasterId()`,
   `getOnAirPhases()`. Tested with two real XDJ-XZ captures
   (analyzed + unanalyzed).
   Finding: XDJ-XZ combo unit never sets the on-air flag for its own
   decks — on-air requires an external DJM mixer.
4. **Mixer status parser** (port 50002, kind `0x29`, 56 bytes) — done.
   Gives master-tempo authority from standalone DJM mixers. Paired with
   channels-on-air parser (port 50001, kind `0x03`) which provides
   authoritative per-channel fader state. Note: channels-on-air is a
   separate packet, not embedded in mixer status as originally assumed.
5. **CDJ-3000 absolute-position parser** (port 50001, kind `0x0b`,
   30 ms cadence) — done. Direct Playhead ms + TrackLength sec + Pitch ×100
   + BPM ×10 (estimated offset). Uses different encoding scales than
   beat/status packets — does not share decoders. Older CDJs don't emit
   this; surfaced as optional per-device data via `getPosition()` and
   `getPositions()`.
6. **Deck state aggregator** — done. `DeckState` interface composes
   `Device` + `CdjStatus` + `PhaseState` + `AbsolutePosition` per
   player. Observer gains `getDeck(id)` and `decks()` methods. Phase
   is computed on-demand (always current). Deck events (`on('deck')`)
   deferred — existing fine-grained events (onBeat, onStatus, onDevice)
   cover the event-driven side.
7. **CLI observe: full event surfacing.** — done. `--json` JSONL output
   mode for all parsed events (beats, CDJ status, mixer status, on-air,
   absolute-position, phase). `--dump <file>` captures raw packets.
   Human-readable mode logs status changes only (not every 200ms update).
8. **→ `netbeat replay` CLI subcommand.** Read a pcap (or JSONL), re-emit
   UDP packets on loopback with preserved inter-arrival timing. End-to-
   end test of the state machine without hardware.
9. **Full 3-phase claim choreography.** Only if real hardware rejects
   the shortcut. Not expected to be needed.
10. **Track metadata — deferred**. Pick remotedb TCP vs. NFS-scrape once
    we know the real-world constraints. Likely NFS-scrape (works with 4
    CDJs, also unlocks phrase analysis / PSSI).
11. **Phrase analysis (PSSI).** Beat-indexed mood/phrase intervals from
    rekordbox `.EXT` files on the USB. XOR-obfuscated body with a known
    19-byte mask. Requires NFS-scrape path from step 10.
12. **Hot cues, memory cues, beat grid, waveforms.** Same NFS-scrape
    path. Layered onto the deck state.
13. **Denon StageLinQ** — separate plan file, separate package.

## Findings / gotchas

(Surprises, negative results, and spec facts worth not re-deriving.
Expand as we learn.)

- **Every Pro DJ Link packet** starts with the 10-byte magic
  `51 73 70 74 31 57 6d 4a 4f 4c`, with the kind byte at offset `0x0a`.
  That single check cleanly filters non-Pioneer traffic.
- **Ports (confirmed + extended):** 50000 (discovery UDP), 50001 (beat
  UDP), 50002 (status UDP), 50004 (Touch Audio — ignore), 12523/TCP
  (RemoteDBServer bootstrap; returns the real dbserver port — commonly
  1051 on CDJs but **different** on rekordbox laptops, always query
  12523 first).
- **Passive listening is meaningfully limited.** We get keep-alives,
  beats, mixer on-air, CDJ-3000 abs-position. We do *not* get CDJ status
  (trackId, play state, master/sync flags) or any metadata. CDJs only
  unicast status to endpoints that announced.
- **CDJ-3000 abs-position is a gift.** `0x0b` on port 50001 every
  ~30 ms, direct Playhead(ms) + TrackLength(sec) + BPM(×10). No
  computing time-remaining from beat count + beat grid. Older CDJs
  don't emit it; library must treat this as per-device-capability data.
- **prolink-connect has swapped pitch field names.** `sliderPitch` and
  `effectivePitch` are labeled opposite to what dysentery says. Trust
  dysentery and don't replicate the bug.
- **4 real CDJs + us = no remotedb.** IDs 1–4 are all taken. Metadata
  API must not pretend it's always available. Shape the API so metadata
  returns `{ available: false, reason: 'all-slots-occupied' }` rather
  than silently hanging.
- **Phrase analysis (PSSI)** is not exposed via remotedb — only via
  NFS-scrape of the USB/SD card. Body is XOR-obfuscated with a known
  19-byte mask. Beat-indexed (not time-indexed). Three "mood" variants
  determine phrase-name vocabulary.
- **Claim shortcut works.** Skipping the 3-phase handshake and only
  emitting kind-`0x06` keep-alives is enough for real CDJs to begin
  unicasting to us. prolink-connect does the same. Code path lives in
  `observer/announcer.ts`.
- **XDJ-XZ sends nothing on port 50001 without rekordbox analysis.**
  With unanalyzed tracks: BPM appears in CDJ status (`0x92-0x93`) via
  real-time detection, but beat counter (`0x5C-0x5F`) and beat-within-
  bar (`0x55`) are zero, and no beat packets (`0x28`) are emitted on
  50001 at all. With analyzed tracks: beats flow at beat rate, status
  packets gain beat counter/phase. Confirmed in second capture session.
- **XDJ-XZ beat packets are 96 bytes, not 60.** Extended format vs.
  CDJ-2000nxs. BPM at `0x5A`, beat-within-bar at `0x5C`, pitch at
  `0x54`. Parser must handle both sizes.
- **XDJ-XZ sends every beat packet twice.** Identical payload,
  ~40–110 ms apart, same source port. Observer deduplicates by
  comparing the 24-byte timing region (`0x24..0x3b`) per player.
  After dedup: 4.5 ms avg timing error, perfect 1-2-3-4 cycling,
  56 ms jitter (stddev) for player 1 at ~87 BPM.
- **Rekordbox holds ports 50000–50002 while running.** Must close it
  before starting observer capture on the same host.
- **Bun needs an explicit Windows Firewall rule.** Unlike Node.js,
  Bun has no auto-created inbound rule. Ports receiving unsolicited
  unicast (50001, 50002) will silently drop packets without one.
  Port 50000 appears to work because outbound broadcasts create
  temporary return-traffic holes.
- **Zombie `reuseAddr` sockets steal packets.** If a prior capture
  process dies without closing its sockets, `reuseAddr: true` lets a
  new process bind the same port — but the OS may deliver packets to
  the zombie instead. Always verify with `netstat -ano` that only one
  PID owns each port.
- **Metadata queries stress older CDJs.** Whenever metadata lands,
  rate-limit regardless of path.
- **Channels-on-air is a separate packet from mixer status.** The mixer
  status (kind `0x29`, port 50002) carries master-tempo authority and
  BPM. On-air flags are in a distinct packet (kind `0x03`, port 50001).
  Two variants: 40 bytes for 4-channel DJMs, 42 bytes for DJM-V10
  (6-channel, subtype `0x03`). Neither packet is sent by combo units
  (XDJ-XZ, XDJ-AZ).
- **Our own announcements echo back.** `Observer.isSelf()` filters them
  via MAC + id match. IP alone isn't enough (peers share subnets).
- **Windows Node `os.networkInterfaces()`** returns `mac` as a
  colon-separated string and `family` as `'IPv4' | 'IPv6'`. The
  `buildIdentity` helper already handles that.

## Progress log

- [x] Monorepo scaffold (workspaces, tsconfig base + project refs,
  Biome, bun.lock).
- [x] `README.md`, `docs/research.md` (prior art with notes),
  `docs/protocol-reference.md` (code-ready digest w/ citations,
  sections 1–10).
- [x] `packages/prolink`: `protocol/{header,ports,kinds}`,
  `packets/{types,keepalive}`, `transport/udp`,
  `observer/{device-manager,announcer,identity,index}`, public
  surface in `src/index.ts`.
- [x] `packages/cli`: `netbeat help | interfaces | observe` with
  `--interface / --id / --name / --passive / --raw`.
- [x] 35 tests passing (header magic/kind, keep-alive round-trip,
  malformed-input guards, device-manager lifecycle w/ virtual clock,
  listener-exception isolation). `bun run typecheck`, `bun run lint`,
  `bun run build` all clean.
- [x] Beat packet parser (port 50001, kind `0x28`, 96 bytes). 30 new
  tests (65 total). `parseBeat`, `buildBeat`, `decodePitch`,
  `encodePitch`, `Observer.onBeat()` with per-player dedup. Verified
  live against XDJ-XZ: accurate BPM/pitch/phase, handles both decks
  simultaneously, correct 1-2-3-4 cycling.
- [x] `--dump <file>` JSONL packet capture flag in CLI.
- [x] CDJ status parser (port 50002, kind `0x0a`, 292 bytes). 33 new
  tests (122 total). `parseStatus`, `buildStatus`, `PlayState`,
  `TrackSlot`, `TrackType` enums. Observer gains `onStatus()`,
  `getMasterPhase()`, `getMasterId()`, `getOnAirPhases()`, internal
  master/on-air tracking. Two real XDJ-XZ packets in tests. Phase
  tracker + status = complete master-aware phase API.
- [x] Phase tracker (`PhaseTracker` class). `getPhase(playerId)` returns
  proportional phase (`beat`, `bar` as [0,1) fractions) plus real-time
  seconds (`beatElapsed`, `beatRemaining`, `barElapsed`, `barRemaining`)
  interpolated via `performance.now()`. Observer exposes `getPhase()`,
  `phases()`, `getMasterPhase()`, top-level `phase` getter with
  master→sole→lowest-ID fallback. 136 tests total (14 files).
- [x] Mixer status parser (port 50002, kind `0x29`, 56 bytes).
  `parseMixerStatus`, `buildMixerStatus` in `packets/mixer-status.ts`.
  27 tests. Observer gains `onMixerStatus()` and updates master tracking
  when mixer claims master authority.
- [x] Channels-on-air parser (port 50001, kind `0x03`, 40/42 bytes).
  `parseOnAir`, `buildOnAir` in `packets/on-air.ts`. Handles both
  4-channel (standard DJM) and 6-channel (DJM-V10) variants. 23 tests.
  Observer gains `onOnAir()` and updates `onAirIds` from authoritative
  mixer source. 186 tests total (34 files).
- [x] CDJ-3000 absolute-position parser (port 50001, kind `0x0b`).
  `parseAbsolutePosition`, `buildAbsolutePosition` in
  `packets/absolute-position.ts`. 25 tests. Observer gains
  `onAbsolutePosition()`, `getPosition()`, `getPositions()`. BPM
  field offset (0x30) estimated — needs CDJ-3000 validation.
  211 tests total (36 files).
- [x] Deck state aggregator. `DeckState` interface in `observer/index.ts`.
  Observer gains `getDeck(id)`, `decks()`, and stores latest CDJ status
  per player. 211 tests total (no new tests — composition of existing
  tested components).
- [x] CLI `observe --json` JSONL output + full event surfacing (beats,
  status, mixer, on-air, absolute-position, phase). Human-readable mode
  logs status changes only. 211 tests total.
- [ ] Commit all current work (scaffold through CLI event surfacing).
- [ ] `netbeat replay` CLI subcommand (pcap re-emit on loopback).
- [ ] Metadata path (deferred; pick remotedb vs NFS-scrape later).
- [ ] Phrase analysis (PSSI, XOR-obfuscated, NFS-only).
- [ ] Hot cues / memory cues / beat grid / waveforms.

## Open questions for the user

Numbered so you can answer by number. Each has my recommendation.

1. **Commit the scaffold now?** Observer mode is a coherent slice;
   follow-up parsers build on top without churning it. Recommendation:
   **yes, commit now** so history reflects the decision boundary.
2. **Repo URL / package scope sanity check.** `package.json` points at
   `github.com/cinderblock/netBeat.git`; packages are `@netbeat/prolink`
   and `@netbeat/cli`. Flag if either is wrong.
3. **Parser order.** Plan has Beat → CDJ status → Mixer status →
   CDJ-3000 abs-position. Recommendation: **as listed**. Beat is the
   smallest unit of new code and the highest-impact for lighting sync.
   Push back if you'd rather front-load CDJ status (unlocks track IDs)
   or abs-position (trivial if you have a CDJ-3000).
4. **Higher-level API shape.** `Observer.onBeat / onStatus / onDeck` as
   typed events per parsed kind, plus `getState()` snapshot, plus the
   existing `onPacket` escape hatch. Recommendation: **yes**. Matches
   how show-control consumers actually consume data.
5. **Record/replay tooling priority.** Build `netbeat record` before or
   after the next parser? Recommendation: **after beat parser** — beat
   packets are the first thing worth recording, and the parser gives
   the recorder something to annotate the raw bytes with.

## Things not to do

(Traps we've already identified in this project. Do not walk back into.)

- **Never send sync, master-handoff, tempo, load-track, or fader-start
  packets.** Announcing as a virtual CDJ is fine; controlling decks is
  not. The read-only guarantee is the whole reason the library exists.
- **Never copy code from prolink-connect / Dysentery / beat-link.** MIT
  vs. EPL makes the surface line noisy. Stay clean-room: cite in
  comments, implement from the spec. Revisit only for
  `rekordbox_anlz.ksy` when metadata work starts.
- **Do not trust prolink-connect's pitch field names.** `sliderPitch` /
  `effectivePitch` are swapped. Use dysentery's names.
- **Do not auto-pick a network interface in v1.** Multi-NIC hosts exist.
  Explicit `interface` option; auto-detect is a v2 convenience.
- **Do not claim IDs 1–4 by default in observer mode.** Reserve those
  for real CDJs. Only drop into 1–4 when the (deferred) metadata path
  is wired up and the caller explicitly asks.
- **Do not treat metadata as always available.** 4 CDJs already on the
  bus leaves no slot for us. Surface the unavailability instead of
  hanging.
- **Do not test against real hardware on every change.** The XDJ has
  finite lifetime. Fixtures first; real hardware only to harvest new
  fixtures via `netbeat record`.
- **Do not run destructive git commands** (`reset --hard`, `checkout --
  <file>`, `restore`, `clean -f`) to get a clean base — global rule,
  shared working tree. Safety-stash first.

## Pointers

- Public surface: `packages/prolink/src/index.ts`
- Observer entry point: `packages/prolink/src/observer/index.ts`
- Protocol digest w/ byte offsets + citations:
  `docs/protocol-reference.md`
- Prior-art reading list: `docs/research.md`
- CLI: `packages/cli/src/index.ts`
