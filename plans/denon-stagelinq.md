# Denon StageLinQ — implementation plan

Working plan for the Denon side of netBeat. Sibling to
`plans/pioneer-prolink.md` (the Pioneer Pro DJ Link plan).

## Goal

Add a `@netbeat/stagelinq` package that observes Denon Prime-series hardware
over the StageLinQ protocol. Same posture as prolink: read-only, never sends
control or sync commands, surfaces beat/phase/status/metadata to consumers for
lighting/visual/DMX sync.

### Why now

Pioneer prolink implementation is stable (steps 1-10 complete, 337 tests
passing). The monorepo was designed from the start to host a sibling
`packages/stagelinq` package. We have:

- A complete StageLinqJS PoC (GPLv3, honusz) in the Empyrean Gate project
  that we've previously integrated — we can use it as a **protocol reference**
  but must do a **clean-room reimplementation** (netBeat is MIT).
- Multiple independent community implementations:
  [chrisle/StageLinq](https://github.com/chrisle/StageLinq) (TS),
  [icedream/go-stagelinq](https://github.com/icedream/go-stagelinq) (Go),
  [Jaxc/PyStageLinQ](https://github.com/Jaxc/PyStageLinQ) (Python, includes
  protocol docs).
- No hardware to test against today — this is a code-first pass using
  protocol knowledge. Real hardware validation will come later.

## Environment / context

- **Monorepo:** `C:\Users\camer\git\Personal Projects\netBeat`
- **Runtime:** Bun 1.3.0 / Node >=20, TypeScript 6.0.3, strict mode
- **Style:** Biome (2-space, single quotes, 100-col, LF)
- **Test framework:** `bun:test`
- **Existing PoC code:** `C:\Users\camer\git\Personal Projects\Empyrean Gate\react-native-templates\apps\server\denon-stagelinq\`
  (StageLinqJS by honusz, GPLv3 — reference only, not copy)
- **Second copy at:** `C:\Users\camer\git\Clients\Entheos\uprising\src\denon-stagelinq\`

## Decisions already made (don't re-ask)

1. **Clean-room implementation.** The PoC is GPLv3; netBeat is MIT. We write
   our own code informed by protocol understanding, not by copying.
2. **Separate workspace package** — `packages/stagelinq` (`@netbeat/stagelinq`),
   mirroring the prolink package structure.
3. **Observer-only posture.** We discover devices, subscribe to state/beat
   data, download metadata — but never send control commands.
4. **Same consumer surface pattern** as prolink: `Observer` class with
   `start()`/`stop()`, event handlers returning unsubscribe fns, `DeckState`
   aggregation.
5. **No hardware today.** Build against protocol spec, unit test with
   hand-crafted byte fixtures, defer live validation.

## Protocol overview (StageLinQ)

Unlike Pioneer's UDP-centric protocol, StageLinQ is TCP-centric:

### Layer 1: Discovery (UDP port 51337)
- Magic: `"airD"` (4 bytes)
- Broadcast every 1000ms
- Message: deviceId(16 bytes) + source(UTF16) + action(UTF16) + softwareName(UTF16) + softwareVersion(UTF16) + port(u16)
- Actions: `"DISCOVERER_HOWDY_"` (login), `"DISCOVERER_EXIT_"` (logout)
- Strings are **NetworkStringUTF16**: `[u32 byte-length][UTF-16BE data]`

### Layer 2: Directory service (TCP, port from discovery)
- First service connected after discovery
- Negotiates which services are available and their ports
- Message types: ServicesAnnouncement(0x0), TimeStamp(0x1), ServicesRequest(0x2)

### Layer 3: Services (TCP, each on its own port)
All use 4-byte big-endian length-prefixed framing (except Broadcast).

**StateMap** — real-time deck state subscriptions
- Magic: `"smaa"`
- Subscribe to state paths (e.g. `/Engine/Deck1/Play`, `/Engine/Deck1/Track/CurrentBPM`)
- Request type 0x7d2, response type 0x0 (JSON values)
- 300+ state paths across decks, mixer, client

**BeatInfo** — beat sync data
- Per-deck beat position, totalBeats, BPM, samples
- Each update: clock(u64 ns) + deckCount(u32) + per-deck(beat f64, totalBeats f64, BPM f64) + per-deck(samples f64)

**FileTransfer** — database/file downloads
- Magic: `"fltx"`, chunk size 4096
- Can stat, list sources, and download files (primarily `m.db` database)
- Transaction-based with transfer IDs

**Broadcast** — track change notifications (JSON, unbuffered)

**TimeSynchronization** — clock sync (experimental, low priority)

### Wire format primitives
- All big-endian
- NetworkStringUTF16: `[u32 byteLength][UTF-16BE chars]`
- DeviceId: 16-byte UUID

### Device models
| Code | Name | Type | Decks |
|------|------|------|-------|
| JC11 | PRIME 4 | Controller | 4 |
| JC16 | PRIME 2 | Controller | 2 |
| JP07 | SC5000 | Player | 2 |
| JP13 | SC6000 | Player | 2 |
| JP14 | SC6000M | Player | 2 |
| JP20 | SC LIVE 2 | Controller | 2 |
| JP21 | SC LIVE 4 | Controller | 4 |
| JM08 | X1800 | Mixer | 0 |
| JM10 | X1850 | Mixer | 0 |
| NH08 | Mixstream Pro | Controller | 2 |

## Plan / steps

### Step 1 — Scaffold package + wire primitives
- [ ] Create `packages/stagelinq/` with `package.json`, `tsconfig.json`
- [ ] Wire format primitives: `ReadContext` / `WriteContext` (big-endian binary r/w)
- [ ] `NetworkStringUTF16` read/write
- [ ] DeviceId (16-byte UUID) type + helpers
- [ ] Unit tests for all primitives with hand-crafted byte fixtures

### Step 2 — Discovery (UDP)
- [ ] Discovery message parser + builder
- [ ] Discovery listener (bind UDP 51337, parse inbound announcements)
- [ ] Discovery announcer (broadcast our presence periodically)
- [ ] Device model classification from software name codes
- [ ] Unit tests for parsing/building discovery messages

### Step 3 — TCP framing + Directory service
- [ ] Length-prefixed TCP message framing (read/write)
- [ ] Directory message types: ServicesAnnouncement, TimeStamp, ServicesRequest
- [ ] Directory service client (connect, request services, parse announcements)
- [ ] Service connection handshake (first-message format)
- [ ] Unit tests for framing and directory messages

### Step 4 — StateMap service
- [ ] StateMap message parser (magic "smaa", type dispatch)
- [ ] State subscription request builder
- [ ] State value change handler
- [ ] State path catalog (typed enum/constants for known paths)
- [ ] Unit tests for message parsing, subscription building

### Step 5 — BeatInfo service
- [ ] BeatInfo message parser (clock, per-deck beat/BPM/totalBeats/samples)
- [ ] BeatInfo subscription request
- [ ] Phase tracking integration (adapt prolink's PhaseTracker pattern)
- [ ] Unit tests with hand-crafted beat data fixtures

### Step 6 — Observer orchestrator
- [ ] `Observer` class: start/stop lifecycle, event handlers
- [ ] Discovery → Directory → service connection pipeline
- [ ] Device manager (add/update/remove lifecycle from discovery)
- [ ] DeckState aggregation from StateMap + BeatInfo
- [ ] Phase resolution (master detection via StateMap paths)
- [ ] Public API: `onDevice()`, `onBeat()`, `onStateChange()`, `phase`, `decks()`
- [ ] Unit tests for observer lifecycle and event dispatch

### Step 7 — FileTransfer service (stretch)
- [ ] FileTransfer message framing (magic "fltx", transaction IDs)
- [ ] Source listing, stat, chunk-based download
- [ ] Database download (`m.db`) and metadata extraction
- [ ] Unit tests

### Step 8 — Broadcast service (stretch)
- [ ] Broadcast message parser (unbuffered JSON)
- [ ] Track-change event surfacing
- [ ] Unit tests

### Step 9 — CLI integration
- [ ] Add StageLinQ support to `@netbeat/cli` observe/pulse commands
- [ ] Auto-detect protocol or let user choose
- [ ] JSON + human output formats

### Step 10 — Documentation + polish
- [ ] Update `docs/research.md` Denon section with references
- [ ] Write `docs/stagelinq-protocol-reference.md`
- [ ] Update README roadmap
- [ ] Verify all tests pass, lint clean

## Findings / gotchas

- **Licensing trap:** The StageLinqJS PoC in Empyrean Gate is GPLv3 (honusz).
  We cannot copy code. All implementation must be clean-room from protocol
  understanding only.
- **Link-local networking:** StageLinQ can operate on 169.254.0.0/16 (APIPA),
  though modern devices also work on regular subnets.
- **Token MSB constraint:** If the most-significant bit of the device token
  is set to 1, StageLinQ source devices won't reply. The PoC uses known-good
  tokens (SoundSwitch, SC6000, Resolume, Listen).
- **No hardware for testing today.** All development is spec-driven with
  fixture-based tests. Real validation is deferred.

## Progress log

- [x] Step 1 — Scaffold + wire primitives (ReadContext/WriteContext, NetworkString, DeviceId)
- [x] Step 2 — Discovery (UDP): parser, builder, device model classification
- [x] Step 3 — TCP framing + Directory service: MessageFramer, directory messages
- [x] Step 4 — StateMap service: subscribe, parse updates, state path catalog
- [x] Step 5 — BeatInfo service: parser, subscription, per-deck beat data
- [x] Step 6 — Observer orchestrator: lifecycle, discovery→directory→service pipeline, DeckState aggregation, DeviceManager
- [ ] Step 7 — FileTransfer service (stretch)
- [ ] Step 8 — Broadcast service (stretch)
- [x] Step 9 — CLI integration: `--protocol stagelinq` flag on observe + pulse
- [x] Step 10 — Documentation: research.md Denon section, README updated

### 2026-04-25 — Initial implementation session

- Scaffolded `packages/stagelinq` as `@netbeat/stagelinq` (MIT, workspace package)
- Implemented full protocol layer: wire primitives, discovery, TCP framing, Directory, StateMap, BeatInfo
- Observer orchestrator handles discovery → directory → service connection pipeline
- 99 unit tests, 282 expect() calls, all passing
- Typecheck and lint clean (biome)
- No hardware validation yet — all tests use hand-crafted byte fixtures
- Referred to StageLinqJS PoC (GPLv3, honusz) as protocol reference only; all code is clean-room

## Open questions for the user

1. **Device identity token:** We need a 16-byte token to identify ourselves
   during discovery. The PoC uses predefined tokens (SoundSwitch, Listen,
   etc.). Should we use the "Listen" token (purely passive) or define our own
   "netbeat" token? **Recommendation:** Start with the Listen token since
   we're observer-only, switch to a custom one if needed.

2. **StateMap subscription scope:** There are 300+ state paths. For the
   initial implementation, should we subscribe to all of them or a curated
   subset (play state, BPM, track info, fader positions)?
   **Recommendation:** Curated subset matching what prolink surfaces, with an
   API for consumers to add custom subscriptions.

3. **FileTransfer priority:** The `m.db` database download gives us track
   metadata but requires SQLite. Should we add `better-sqlite3` as a
   dependency or defer database parsing? **Recommendation:** Defer to step 7;
   BeatInfo + StateMap already give us track name/artist/BPM without database
   access.

## Things not to do

- Don't copy code from the GPLv3 StageLinqJS PoC.
- Don't add SQLite dependency until step 7 (if at all).
- Don't implement control/sync sending — observer only.
- Don't try to test against real hardware yet — fixture-based only.
- Don't over-subscribe StateMap in initial impl — start with essential paths.
