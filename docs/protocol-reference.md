# Pioneer Pro DJ Link — protocol reference

Compiled 2026-04-21 from prolink-connect (MIT), Dysentery (EPL-1.0), and
beat-link (EPL-1.0, read for understanding only, no code copied).

This is our internal reference for parser implementation. Treat it as
derivative of the upstream sources cited at the bottom — if a fact here
conflicts with those sources, the upstream wins.

All file references use repository-relative paths. Byte offsets are hex.
Port numbers decimal.

## 1. Ports

| Port | Proto | Purpose | Source |
|-----:|-------|---------|--------|
| 50000 | UDP | Device announcement, keep-alive, player-number claim negotiation | `dysentery/doc/modules/ROOT/pages/packets.adoc` "Port 50000 Packets"; `prolink-connect/src/constants.ts` `ANNOUNCE_PORT` |
| 50001 | UDP | Beat packets, fader start, channels-on-air, sync control, absolute-position (CDJ-3000), master handoff | `dysentery/.../packets.adoc` "Port 50001"; `prolink-connect/src/constants.ts` `BEAT_PORT` |
| 50002 | UDP | CDJ status, mixer status, media-slot query/response, load-track command | `dysentery/.../packets.adoc` "Port 50002"; `prolink-connect/src/constants.ts` `STATUS_PORT` |
| 50004 | UDP | Touch Audio (stream audio between supported players/mixers) — kinds `1e`/`1f`/`20`. Not needed for observer. | `dysentery/.../packets.adoc` "Port 50004" |
| 12523 | TCP | "RemoteDBServer" bootstrap — ask a device for the port of its dbserver | `prolink-connect/src/remotedb/constants.ts` `REMOTEDB_SERVER_QUERY_PORT`; `dysentery/.../track_metadata.adoc` "Connecting to the Database" |
| 1051 (observed) | TCP | rekordbox dbserver port (CDJs). Laptops running rekordbox use a different port — always query 12523 first. | `dysentery/.../track_metadata.adoc` |

All Pro DJ Link UDP packets start with the 10-byte magic:
`51 73 70 74 31 57 6d 4a 4f 4c` (`prolink-connect/src/constants.ts`
`PROLINK_HEADER`; `dysentery/src/dysentery/view.clj` `status-header`).

Byte `0x0a` (the 11th byte) is the packet-kind discriminator; together with
the destination port it uniquely identifies the packet type.

## 2. Packet types (kind byte at offset `0x0a`)

Source: `dysentery/doc/modules/ROOT/pages/packets.adoc` tables.

**Port 50000 (announce / claim)**

| Kind | Purpose | Direction |
|-----:|---------|-----------|
| `0a` | Initial announcement (broadcast, 3x during startup) | broadcast |
| `00` | Stage-1 channel-number claim (broadcast, 3x) | broadcast |
| `02` | Stage-2 channel-number claim (has IP/MAC/claimed D) | broadcast |
| `04` | Stage-3/final channel-number claim | broadcast |
| `01` | Mixer channel-assignment intention (to player) | mixer→CDJ |
| `03` | Mixer channel assignment (assigns D) | mixer→CDJ |
| `05` | Mixer assignment finished | mixer→CDJ |
| `06` | **Keep-alive** (every ~1.5 s). This is the "device announce" you observe. | broadcast |
| `08` | Channel conflict (another device claims same D) | broadcast |

**Port 50001 (beat / mixer realtime)**

| Kind | Purpose |
|-----:|---------|
| `02` | Fader Start (per-player command C1..C4) |
| `03` | Channels-On-Air flags (F1..F4, or F1..F6 on DJM-V10 with subtype `03`) |
| `0b` | **Absolute-Position** (CDJ-3000 only, every 30 ms) |
| `26` | Master-handoff takeover request |
| `27` | Master-handoff takeover response |
| `28` | **Beat** packet (60 bytes) — 1 per beat when playing |
| `2a` | Sync control (turn sync on/off, force master) |

A second *short* 50001 packet (`2d` bytes) exists; `dysentery/.../beats.adoc`
notes "the shorter packets contain information about which channels are
on-air, and fader start/stop commands."

**Port 50002 (status / control)**

| Kind | Purpose | Length notes |
|-----:|---------|--------------|
| `05` | Media-slot query (what's in this slot?) | 48 B |
| `06` | Media-slot response | 192 B in `prolink-connect/tests/_data/media-slot-usb.dat` |
| `0a` | **CDJ status** (~every 200 ms) | variable: `d0` older, `d4` nexus, `11c`/`124` nxs2, `11b` XDJ-1000, `200` CDJ-3000. See `dysentery/.../vcdj.adoc` lines 84-88. |
| `19` | Load-Track command (remote-load) | `0x58` |
| `1a` | Load-Track acknowledgment | |
| `29` | **Mixer status** | 56 B (`0x38`) |
| `34` | Load settings command | |

`dysentery/src/dysentery/view.clj` `correct-type-and-length?` is the
authoritative length table.

## 3. Packet structures

### 3a. Keep-alive / device announce (port 50000, kind `06`)

Parser: `prolink-connect/src/devices/utils.ts::deviceFromPacket`. Offsets:

- `0x0a` = `0x06` (keep-alive discriminator; function filters for this)
- `0x0c..0x1f` (20 B, NUL-padded ASCII) — **device name**
- `0x24` (u8) — **device ID (player number)**, 1-4 CDJ, `0x21` (=33) for mixer, usually `0x11` (=17) for rekordbox laptop (unconfirmed ID — prolink-connect treats it generically)
- `0x26..0x2b` (6 B) — **MAC address**
- `0x2c..0x2f` (u32 BE) — **IPv4 address**
- `0x34` (u8) — **device type** (enum `DeviceType` in `prolink-connect/src/types.ts`: `0x01` CDJ, `0x03` Mixer, `0x04` Rekordbox). Note: dysentery startup.adoc docs it as `01` CDJ, `02` mixer — so `0x03`/`0x04` in prolink-connect actually refers to the `0x34` value at the end of the packet, consistent with its reading.
- Spec diagram: `dysentery/.../startup.adoc` "CDJ keep-alive packets" and "Mixer keep-alive packets".

Full packet length: `0x36` (54) bytes.

### 3b. Beat packet (port 50001, kind `28`, 60 bytes)

Spec: `dysentery/doc/modules/ROOT/pages/beats.adoc`. No parser in
prolink-connect — *this is a gap in prolink-connect*; only `control` sends
these. Offsets:

- `0x0a` = `0x28` (kind)
- `0x0b..0x1f` — 20 B device name (packet subtype `00` starts one byte earlier)
- `0x20` = `0x01`
- `0x21` (u8) — **D** = device number (1-4 CDJ, `0x21` mixer)
- `0x22..0x23` (u16 BE) — `len_r` = `0x003c` (bytes remaining after this field)
- `0x24..0x27` (u32 BE) — **nextBeat** ms to next beat (at normal pitch)
- `0x28..0x2b` (u32 BE) — **2ndBeat** ms
- `0x2c..0x2f` (u32 BE) — **nextBar** ms to next downbeat
- `0x30..0x33` (u32 BE) — **4thBeat** ms
- `0x34..0x37` (u32 BE) — **2ndBar** ms
- `0x38..0x3b` (u32 BE) — **8thBeat** ms
  *Any of these = `0xffffffff` means "track ends before that beat."*
- `0x3c..0x53` — 24 × `0xff` padding
- `0x54..0x57` (u32 BE) — **Pitch** — actually a u24 value; see below
- `0x58..0x59` — zeros
- `0x5a..0x5b` (u16 BE) — **BPM** × 100 (i.e. 12850 = 128.50 BPM)
- `0x5c` (u8) — **B_b** = beat-within-bar, 1..4
- `0x5d..0x5e` — zeros
- `0x5f` (u8) — **D** repeated

**Pitch encoding** (same in beat and status packets, confirmed by
`prolink-connect/src/status/utils.ts::calcPitch` and
`dysentery/.../beats.adoc`):
`0x00000000` = −100 %, `0x00100000` = 0 %, `0x00200000` = +100 %.
`percent = ((value - 0x100000) / 0x100000) * 100`. The bytes actually read
are a u24 starting at `0x55` (or `0x8d` in status); the equation in
`dysentery/.../beats.adoc` is
`(byte[55]<<16 + byte[56]<<8 + byte[57] - 0x100000) / 0x100000 * 100`.

Effective BPM = `trackBPM * pitchMultiplier` where
`pitchMultiplier = value / 0x100000`.

> Emission rule: CDJs send beat packets only while **playing** and only for
> rekordbox-analyzed tracks (CDJ-3000 can analyze on first play). The mixer
> sends them constantly as a fallback metronome. — `dysentery/.../beats.adoc`
> lines 11-15.

### 3c. CDJ status packet (port 50002, kind `0a`)

Parser: `prolink-connect/src/status/utils.ts::statusFromPacket`. Any packet
shorter than `0xc8` (200) is discarded as "rekordbox short packet". Offsets
that prolink-connect reads:

| Offset | Size | Field | prolink-connect name |
|-------:|-----:|-------|-----|
| `0x21` | 1 | Device ID (player number) | `deviceId` |
| `0x28` | 1 | Source device for loaded track (`D_r`) | `trackDeviceId` |
| `0x29` | 1 | Source slot (`S_r`) | `trackSlot` (MediaSlot enum) |
| `0x2a` | 1 | Track type (`T_r`) | `trackType` |
| `0x2c` | 4 BE | rekordbox track ID | `trackId` |
| `0x7b` | 1 | `P_1` play state | `playState` (PlayState enum) |
| `0x89` | 1 | Status flag bits (`F`) | — |
| `0x8d` | 3 | `Pitch_1` u24 (effective, actually applied — name is inverted in source) | `sliderPitch` in code, but see below |
| `0x92` | 2 BE | Track BPM × 100; `0xffff` = no track | `trackBPM` |
| `0x99` | 3 | `Pitch_2` u24 (what the fader shows) | `effectivePitch` in code |
| `0xa0` | 4 BE | Beat counter from start of track; `0xffffffff` = n/a | `beat` |
| `0xa4` | 2 BE | Beats until next cue; `0x01ff` = none (CDJ shows "--.-") | `beatsUntilCue` |
| `0xa6` | 1 | B_b beat-within-bar (1-4); 0 when no track | `beatInMeasure` |
| `0xba` | 1 | `el` — emergency loop / emergency-mode flag | `isEmergencyMode` |
| `0xc8` | 4 BE | Packet counter | `packetNum` |

Note: prolink-connect labels `sliderPitch=0x8d` and `effectivePitch=0x99`,
but `dysentery/.../vcdj.adoc` (lines 410-433) says `Pitch_1` at `0x8c-8f`
and `Pitch_3` at `0xc0-c3` are the *actually-applied* pitch, while
`Pitch_2` (`0x98-9b`) and `Pitch_4` (`0xc4-c7`) track the fader. So
prolink-connect's *naming* of these two fields is reversed relative to
dysentery; the values read are still correct numbers. Double-check before
copying names. (unconfirmed which labeling is correct for end-user
semantics — prefer dysentery's.)

**Status flag byte `F` at `0x89`** — `prolink-connect/src/status/types.ts::StatusFlag`:

- `0x08` On-Air
- `0x10` Sync
- `0x20` Master
- `0x40` Playing
- `0x02` BPM-sync degraded (in dysentery, not in prolink-connect)

**PlayState (`0x7b`, `P_1`)** — `prolink-connect/src/status/types.ts::PlayState`:
`0x00` Empty / `0x02` Loading / `0x03` Playing / `0x04` Looping / `0x05`
Paused / `0x06` Cued / `0x07` Cuing / `0x08` PlatterHeld / `0x09` Searching
/ `0x0e` SpunDown / `0x11` Ended. dysentery adds `0x12` emergency loop.

**`S_r` slot values** (`dysentery/.../vcdj.adoc` lines 228-246): `00` none,
`01` CD, `02` SD, `03` USB, `04` rekordbox collection, `05`/`08` unknown-
streaming, `06` Streaming Direct Play, `07` USB-2 (XDJ-AZ four-deck), `09`
Beatport LINK.

**`T_r` track type** (lines 260-271): `00` none, `01` rekordbox,
`02` unanalyzed, `05` CD-DA, `06` streaming.

**CDJ-3000 status packets are `0x200` bytes.** Additional fields at
`0x113` (`P_4`), `0x116-117` (`T_b` bar-time-steps), `0x11a-11b` (`T_pos`
position in bar), `0x120-124` (`NeedleDragPos`), `0x158` (`M_t` master
tempo engaged), `0x15c-15e` (`Key` — note/major-minor/accidental),
`0x15f+7` (KeyShift). See `dysentery/.../vcdj.adoc` lines 556-610.
**prolink-connect does not parse any of these** — implement from spec.

Master-handoff byte `M_h` at `0x9f` (CDJ) and `0x36` (mixer) — `ff`
normally, otherwise the player-number taking over. See
`dysentery/.../sync.adoc`.

Time-remaining is **not a field in the status packet.** It must be computed
from `Beat` + pitch + a downloaded beat-grid. For CDJ-3000 you get
`Playhead` and `TrackLength` directly in the Absolute-Position packet
(see 3e).

### 3d. Mixer status packet (port 50002, kind `29`, 56 bytes)

Spec: `dysentery/.../vcdj.adoc` lines 25-80 "Mixer Status Packets".
prolink-connect does **not** parse these. Offsets (subtype `00`):

- `0x21` — D (usually `0x21` for DJM)
- `0x22-23` — `len_r` = `0x0014`
- `0x27` — F (mixer status flags: `0xf0` = tempo master; `0xd0` = not master)
- `0x28-2b` — Pitch (always `0x00100000`)
- `0x2e-2f` (u16 BE) — **BPM × 100** (master BPM reported by mixer)
- `0x36` — `M_h` master-handoff byte
- `0x37` — `B_b` beat-within-bar (unreliable — not aligned with master)

Per-channel fader positions are **not** in the mixer status packet. The
on-air state *is* in the separate kind-`03` packet on port 50001 (`F_1..F_4`
flags at offsets immediately after `len_r`). Full fader values are not
transmitted on the network. (unconfirmed for newer DJM-V10 —
`dysentery/.../mixer_integration.adoc` documents only on-air flags.)

### 3e. Absolute-Position packet (port 50001, kind `0b`, CDJ-3000 only, 30 ms cadence)

Spec: `dysentery/.../beats.adoc` "Absolute Position Packets". Sent even
when paused (but only when a track is loaded). Offsets:

- `0x0a` = `0x0b`
- `0x21` — D
- `0x22-23` — `len_r`
- `0x24-27` (u32 BE) — **TrackLength** seconds (integer)
- `0x28-2b` (u32 BE) — **Playhead** milliseconds (absolute)
- `0x2c-2f` (s32 BE) — **Pitch**: slider pct × 100 (e.g. `0x0146` = +3.26 %). This format is *not* the `0x100000` convention.
- `0x30-37` — 8 × `0x00`
- `0x38-3b` (u32 BE) — **BPM**: effective tempo × 10 (120.2 → `0x04b2`). `0xffffffff` = unknown.

This is the cleanest source of position info. prolink-connect does not
parse it.

## 4. Track metadata

Two completely different paths:

### A. Remotedb over TCP (prolink-connect primary)

1. TCP connect to player's IP:12523. Send
   `[00 00 00 0F "RemoteDBServer" 00]` (19 B). Receive 2 B big-endian port
   (commonly 1051 for CDJs, but ALWAYS query; rekordbox laptops differ).
   — `prolink-connect/src/remotedb/index.ts::getRemoteDBServerPort`.
2. TCP connect to that port. Send preamble `UInt32(0x01)`; expect
   `UInt32(0x01)` back.
3. Send `Introduce` message (type `0x0000`, txid `0xfffffffe`, one u32 arg
   = *our* player ID). Server replies with `Success` (type `0x4000`,
   arg2 = *their* player ID).
4. From here, send typed "messages" defined in
   `prolink-connect/src/remotedb/message/types.ts`:

**Request message type codes** (all u16, from `DataRequest` enum):

- `0x2002` GetMetadata (rekordbox)
- `0x2003` GetArtwork
- `0x2004` GetWaveformPreview
- `0x2102` GetTrackInfo (file path)
- `0x2104` GetCueAndLoops (classic)
- `0x2202` GetGenericMetadata (unanalyzed/CD)
- `0x2204` GetBeatGrid
- `0x2904` GetWaveformDetailed
- `0x2b04` GetAdvCueAndLoops (nexus2 — hot cues D-H + colors + labels)
- `0x2c04` GetWaveformHD (nexus2 color)

**Response codes** (`Response` enum same file): `0x4000` Success, `0x4001`
MenuHeader, `0x4101` MenuItem, `0x4201` MenuFooter, `0x4002` Artwork,
`0x4003` Error, `0x4402` WaveformPreview, `0x4602` BeatGrid, `0x4702`
CueAndLoop, `0x4a02` WaveformDetailed, `0x4e02` AdvCueAndLoops, `0x4f02`
WaveformHD.

**Message envelope constants:** magic `0x872349ae`
(`prolink-connect/src/remotedb/constants.ts::REMOTEDB_MAGIC`). Field-type
bytes: `0x0f` u8, `0x10` u16 BE, `0x11` u32 BE, `0x14` binary blob
(4-byte length prefix), `0x26` UTF-16BE string (4-byte length prefix,
length in chars inc. trailing NUL). Arg-type tags differ: `02` string /
`03` blob / `04` u8 / `05` u16 / `06` u32. See
`dysentery/.../track_metadata.adoc` "Field Types" and "Messages".

The metadata response is a paginated menu: server sends MenuHeader + N
MenuItem + MenuFooter. Each MenuItem carries 12 typed args whose meaning
depends on the "type" field (arg 7).
`prolink-connect/src/remotedb/message/item.ts::ItemType` enumerates them:
`0x02` AlbumTitle, `0x04` TrackTitle, `0x07` Artist, `0x06` Genre, `0x0a`
Rating, `0x0b` Duration (seconds), `0x0d` Tempo (BPM × 100), `0x0e` Label,
`0x0f` Key, `0x10` BitRate, `0x11` Year, `0x23` Comment, `0x28`
OriginalArtist, `0x29` Remixer, plus color-item types `0x13-0x1b`.

**Hard constraint — player number for metadata:** the `Introduce` packet
uses the vcdj player ID. `prolink-connect/src/network.ts::NetworkConfig.vcdjId`
doc comment (lines 18-31 of the interface): to query *rekordbox-analyzed*
metadata directly from a CDJ you must claim an ID 1-4, and that player
number must not currently be used by a real CDJ, AND (per
`dysentery/.../track_metadata.adoc` line 50-56) the real CDJ at that
number must actually be present on the net, not yourself. Outside 1-4,
rekordbox laptops will still answer, CDJs will not. If four real CDJs are
on the network, you cannot query any of them via remotedb — fall back to
local-DB scraping (next).

### B. Local DB (USB/SD scrape via NFS)

prolink-connect implements a second path: it mounts the CDJ's exported
USB/SD as NFS and reads rekordbox's PDB+ANLZ files directly.

- `prolink-connect/src/nfs/` — NFS/RPC client
- `prolink-connect/src/localdb/kaitai/rekordbox_pdb.ksy` — the on-disk database (tracks, playlists, history, genres…)
- `prolink-connect/src/localdb/kaitai/rekordbox_anlz.ksy` — the per-track analysis file (beat grid, cues, waveforms, song structure)

This works even with four real players and no free slot. See also
`dysentery/.../missing.adoc#four-players` which credits this to the
Crate Digger project.

## 5. Phrase analysis

Source: `prolink-connect/src/localdb/kaitai/rekordbox_anlz.ksy` under
`song_structure_tag` / `song_structure_body` / `song_structure_entry`.

Section magic: `PSSI` (`0x50535349`), only in `.EXT` analysis files — i.e.
rekordbox 6+ / nexus2+. Not in the basic `.DAT`.

**Retrieval path:** this tag is NOT exposed as a dedicated remotedb query.
It is only available via the local-DB scrape (Path A above does not
expose `PSSI` directly). To get phrases on a live network you must grab
the track's `.EXT` analysis file — either via NFS
(`prolink-connect/src/localdb`) or via Crate Digger.

**Encoding:** the `PSSI` body is XOR-obfuscated with a mask derived from
the phrase count. Mask = 19-byte sequence
`[0xCB, 0xE1, 0xEE, 0xFA, 0xE5, 0xEE, 0xAD, 0xEE, 0xE9, 0xD2, 0xE9, 0xEB, 0xE1, 0xE9, 0xF3, 0xE8, 0xE9, 0xF4, 0xE1]`
with `len_entries` added (mod 256) to each byte. Mask repeats across the
body.

**Shape:**

- `mood` (u16, `track_mood` enum): `1` high / `2` mid / `3` low — determines which phrase-name enum applies to this whole track.
- `end_beat` (u16) — the last phrase's ending beat.
- `bank` (u8, `track_bank` enum): `0` default, `1` cool, `2` natural, `3` hot, `4` subtle, `5` warm, `6` vivid, `7` club_1, `8` club_2. Lighting-mode stylistic variant.
- then `len_entries` of `song_structure_entry` (24 B each):
  - `phrase_number` u16 (1-based)
  - `beat_number` u16 (the beat at which the phrase starts; use the beat grid to convert to ms)
  - `kind` u16 (meaning switches on track mood):
    - **high mood**: `1` intro, `2` up, `3` down, `5` chorus, `6` outro
    - **mid mood**: `1` intro, `2-7` verse_1..verse_6, `8` bridge, `9` chorus, `10` outro
    - **low mood**: `1` intro, `2,3,4` verse_1 variants, `5,6,7` verse_2 variants, `8` bridge, `9` chorus, `10` outro
  - padding to entry size
  - `fill_in` u8 (nonzero = fill-in present)
  - `fill_in_beat_number` u16

So phrases are **beat-indexed intervals** (start-beat; end-beat is implicit
from the next phrase or `end_beat`), not time intervals. Convert via
beat-grid. Only intro/up/down/chorus/outro are reliably labeled on "high"-
mood tracks — the typical EDM shape you need for "drop detection" lives in
the high-mood vocabulary.

## 6. Hot cues, memory cues, beat grid, waveforms

All in `rekordbox_anlz.ksy`:

**Beat grid** — section `PQTZ` (`beat_grid_tag`). Array of
`beat_grid_beat`:

- `beat_number` u16 (1..4, position within bar)
- `tempo` u16 (BPM × 100 at this beat — variable-BPM tracks)
- `time` u32 (ms from track start, at normal pitch)

Also reachable over remotedb via `Request.GetBeatGrid` (`0x2204`) →
`Response.BeatGrid` (`0x4602`). prolink-connect types it as
`BeatGrid = Array<{offset, count: 1|2|3|4, bpm}>` in `src/types.ts`.

**Cue points** — two variants:

- `PCOB` `cue_tag` — legacy, `cue_list_type` = 0 memory cues or 1 hot cues A-C. Each entry (`cue_entry`) has `time` u32 ms, `loop_time` u32 ms (if loop), `type` = 1 memory / 2 loop, `hot_cue` u32 (0 = memory, else hot cue slot).
- `PCO2` `cue_extended_tag` (nexus2+) — adds hot cues D-H, DJ comment label (`comment` UTF-16BE), and RGB color bytes + color_id table lookup.

Via remotedb: `Request.GetCueAndLoops` (`0x2104`) and
`Request.GetAdvCueAndLoops` (`0x2b04`). prolink-connect types in
`src/types.ts`: `CuePoint`, `Loop`, `Hotcue`, `Hotloop` tagged union.
`HotcueButton` enum A..H. `CueColor` enum.

**Waveforms:**

- `PWAV` wave_preview_tag (400-segment blue/white waveform for touch strip)
- `PWV2` wave_tiny (small overview)
- `PWV3` wave_scroll (detailed blue/white, 150 half-frames per second)
- `PWV4` wave_color_preview (nexus2 color preview; 6-byte entries)
- `PWV5` wave_color_scroll (nexus2 color detail; 2-byte entries)

prolink-connect's waveform typings (`src/types.ts`): 0..31 height, 0..1
whiteness for the classic; 0..31 height + RGB[0..1]³ for HD. Remotedb
requests: `0x2004`, `0x2904`, `0x2c04`.

## 7. Virtual-CDJ / observer mode

**Do you have to claim a player number to see anything?**

Read-only broadcast listening (no send) gets you:

- Keep-alive packets on port 50000 — device inventory, IP, MAC, device type, player number.
- Beat packets on port 50001 — BPM × pitch × beat-within-bar. You'll see every CDJ that is playing a rekordbox-analyzed track. Master identification requires status packets though.
- Absolute-position packets on port 50001 from CDJ-3000s.
- On-air flags broadcast from the mixer (port 50001 kind `03`).

What you **do not** get without posing as a device:

- CDJ status packets (kind `0a` on port 50002). From
  `dysentery/.../vcdj.adoc` line 11: "start sending keep-alive packets to
  port 50000 on the broadcast address as if you were a CDJ. … the other
  players and mixers will begin sending packets directly to the socket you
  have opened on port 50002." Without this you will NOT receive status —
  including trackId, sync flags, emergency mode, etc.
- Remotedb metadata (needs the `Introduce` handshake).

**What prolink-connect does:** `prolink-connect/src/network.ts::bringOnline`
binds all three ports. `ProlinkNetwork.connect` starts `Announcer` (sends
the keep-alive every `ANNOUNCE_INTERVAL = 1500 ms`). Default vcdj ID =
`0x07` (`DEFAULT_VCDJ_ID` in `src/constants.ts`) — outside the 1-4 range,
so it cannot query CDJ metadata but can still (a) receive status + beats +
absolute-position and (b) query rekordbox-laptop metadata. Name defaults
to `"prolink-typescript"` (20-char max ASCII). Firmware string `"1.43"`.

**beat-link's analogous behavior:**
`beat-link/src/main/java/org/deepsymmetry/beatlink/VirtualCdj.java` has
`setUseStandardPlayerNumber(boolean)` which defaults to `false`. False =
self-assigns a number ≥5 (non-conflicting, no remotedb). True = tries to
grab 1-4 if free.

**Neither library offers a pure passive mode out of the box.** Both always
announce. You could implement one (skip `Announcer.start()` in prolink's
terms) and lose status + remotedb access.

**Claim-protocol when you decide to claim** (from
`dysentery/.../startup.adoc`):

1. Broadcast 3× kind `0a` (initial announcement, ~300 ms apart) to port 50000.
2. Broadcast 3× kind `00` stage-1 claim (includes MAC and a counter N = 1..3).
3. Broadcast 3× kind `02` stage-2 claim (includes IP, MAC, the D you want, and "auto" flag `a`).
4. Broadcast 1× (if fixed D) or 3× (if auto) kind `04` final claim.
5. Settle into kind `06` keep-alive every ~1.5 s.

If another device already uses D, expect kind `08` (channel conflict).
prolink-connect skips this entire choreography — it just starts spamming
keep-alives on kind `06`, and it works in practice, but it is a shortcut.
For CDJ-3000 compatibility use the variant packets with a different byte
at `0x21` (see `dysentery/.../startup.adoc#startup-3000`).

**"4 real CDJs + us":** if you're in the standard range (1-4), the fourth
real CDJ wins and you get kicked with kind `08`. Practical outcome: for
observer mode on a 4-CDJ stage, default to ID ≥ 5 (or ≤6 only if there's
no CDJ-3000 using 5/6), accept that you cannot use CDJ-remotedb, and fall
back to Crate Digger / NFS local-DB scraping
(`prolink-connect/src/localdb/` and `src/nfs/`).

## 8. Known gotchas

- **Rekordbox laptop quirks:** `prolink-connect/src/status/utils.ts` drops any status packet shorter than `0xc8` — "rekordbox sends some short status packets that we can just ignore." rekordbox also uses packet *subtype* `01` in mixer-status layout where a field changes from `len_r` to `len_p` (full-packet length vs remaining). See `dysentery/.../vcdj.adoc` lines 55-57.
- **Four pitch fields** in the CDJ status packet (`Pitch_1..4`). Which is "effective" vs "fader" differs between the prolink-connect naming and the dysentery authoritative doc. Use dysentery: Pitch_1 (`0x8d`) and Pitch_3 (`0xc0-c3`) are the actually-applied value. Pitch_2 (`0x99`) and Pitch_4 (`0xc4-c7`) track the fader.
- **Pitch in beat & status packets** is the `0x100000`-based u24 scheme. Pitch in CDJ-3000 **absolute-position** packets is `× 100`. BPM in status/beat is `× 100`, but BPM in absolute-position is `× 10`. Different scales — don't share a parser.
- **BPM adjustment:** track BPM × (pitch/0x100000) = effective BPM. Mixer always reports pitch = 0 so mixer BPM is directly usable. See `dysentery/.../beats.adoc` lines 113-126.
- **Status packet timing** ~200 ms for most fields; newer players send more frequently during jog-wheel activity. Beat packets are per-beat event-driven. Absolute-position (CDJ-3000) is every 30 ms.
- **"0x68 and 0x75 must be 1" / "0xb6 must be 1"**: `prolink-connect/src/virtualcdj/index.ts` comments — if you send a hand-built status packet, these bytes matter, otherwise CDJs think you are ancient firmware or refuse mp3 metadata. See brunchboy/dysentery issue #15.
- **CDJ-3000 startup packets differ at byte `0x21`**: if 5/6 are in use, you must use `cdj-3000-foreshadowing` variants — see `dysentery/.../startup.adoc#startup-3000`. prolink-connect does **not** implement these (it was written pre-CDJ-3000 packet fixes).
- **XDJ-XZ / XDJ-AZ** present themselves as one IP with two decks + a mixer — SD slot is actually USB-1, USB is USB-2. New slot value `07` only exists on XDJ-AZ four-deck mode. See `dysentery/.../vcdj.adoc` lines 248-256.
- **Fader start is dead on CDJ-3000 and XDJ-XZ.** — `dysentery/.../mixer_integration.adoc` explicit note.
- **Message-vs-packet framing** for remotedb: warning in `dysentery/.../track_metadata.adoc` — "You might receive more than one message in a single network packet (especially with rekordbox)". Parse by the length field in each message, not by datagram boundary. Caused a real bug in beat-link.
- **Beatport LINK / Streaming Direct Play** use slots `06` and `09` and track type `06`; the `rekordbox` field is a CDJ-internal index, not a Beatport catalog ID, so it is not queryable via remotedb. (CDJ-3000 feature.)
- **dmx-js/prolink-connect fork** (`gh repos/dmx-js/prolink-connect`): identical protocol constants and packet handling; the fork modernizes the build (ESM, Deno/Bun targets) and adds a changesets release workflow. No new protocol facts.

## 9. Observable state surface (library-consumer view)

Based on `beat-link` API docs and `prolink-connect/src/status/types.ts::State`,
`src/types.ts::Device`, `CDJStatus`:

**Per device** (shape from prolink-connect + CDJ-3000 additions from dysentery):

- `id: 1|2|...|6|33(mixer)|other` — player number
- `name: string`, `ip: string`, `mac: Uint8Array`
- `type: 'cdj' | 'mixer' | 'rekordbox'`
- `lastSeen: Date`
- If CDJ: `trackId`, `trackDeviceId`, `trackSlot`, `trackType`
- `playState` (see PlayState enum)
- flags: `isPlaying`, `isMaster`, `isSync`, `isOnAir`, `isEmergencyMode`
- `trackBPM: number | null` (hundredths resolved)
- `effectivePitch: number` (percent)
- `sliderPitch: number` (percent)
- `beatInMeasure: 0-4`
- `beat: number | null` (absolute beat from track start)
- `beatsUntilCue: number | null`
- CDJ-3000 extras: `playheadMs`, `trackLengthSec`, `key` (note + major/minor + accidental), `keyShift`, `masterTempo: boolean`, `loopStart/End` (ms), `bufferAheadMs`, `bufferBehindMs`
- From beat packets: `msToNextBeat`, `msToNextBar`, `ms{2nd,4th,8th}Beat`, `ms2ndBar` — useful for quantization look-ahead.

**Session / network state** (corresponds to `ProlinkNetwork` + `MixstatusProcessor`):

- `masterDeviceId: number | null`
- `masterBPM: number | null` (the master's effective BPM)
- `networkState: Offline | Online | Connected | Failed` (`prolink-connect/src/types.ts::NetworkState`)
- `onAir: { [channel: 1|2|3|4|5|6]: boolean }` (from the mixer's port-50001 kind-`03`)
- handoff in progress: source device, target device
- `nowPlayingDeviceId` (prolink's `MixstatusProcessor` — smart-timing / waits-for-silence / follows-master modes — see `src/mixstatus/index.ts`)
- discovered devices map, connect/disconnect events (from `DeviceManager`)

**Per track** (once metadata resolved —
`prolink-connect/src/entities.ts::Track`):

- `id`, `title`, `artist`, `album`, `genre`, `label`, `remixer`, `originalArtist`, `key`, `comment`, `color`
- `duration` (sec), `tempo` (BPM), `rating` (0-5), `year`, `bitrate`
- `artwork` (id → bytes)
- `beatGrid: Array<{offsetMs, count: 1|2|3|4, bpm}>`
- `cueAndLoops: Array<CuePoint | Loop | Hotcue | Hotloop>`
- `waveformHd: WaveformHDSegment[]` (150 half-frames per second, RGB-valued)
- From ANLZ-only: `phrases: Array<{phraseNumber, beatNumber, kind, fillInBeatNumber?, fillIn: bool}>` + track-level `mood: 'high'|'mid'|'low'` and `bank` (0-8).

## 10. Citations

### prolink-connect (https://github.com/evanpurkhiser/prolink-connect, MIT)

- `src/constants.ts` — ports, header magic, vcdj defaults.
- `src/types.ts` — top-level Device, DeviceType, MediaSlot, TrackType, BeatGrid, CuePoint, Hotcue, NetworkState.
- `src/devices/utils.ts::deviceFromPacket` — keep-alive packet parser (offsets for name, id, mac, ip, type).
- `src/status/types.ts` — CDJStatus.State, PlayState, StatusFlag bitmask.
- `src/status/utils.ts::statusFromPacket` — CDJ status parser (authoritative offsets).
- `src/status/utils.ts::mediaSlotFromPacket` — media-slot response parser.
- `src/virtualcdj/index.ts` — keep-alive and status packet builders; `makeStatusPacket` notes bytes 0x68/0x75/0xb6 "magic" values.
- `src/network.ts` — ProlinkNetwork orchestration + `NetworkConfig.vcdjId` docstring on the 1-6 rule.
- `src/control/index.ts::makePlaystatePacket` — kind-`02` fader-start packet builder.
- `src/remotedb/constants.ts` — REMOTEDB_MAGIC `0x872349ae`, REMOTEDB_SERVER_QUERY_PORT 12523.
- `src/remotedb/index.ts` — dbserver TCP handshake (`getRemoteDBServerPort`, preamble, Introduce).
- `src/remotedb/message/types.ts` — all request/response type codes (`DataRequest`, `ControlRequest`, `MenuRequest`, `Response` enums).
- `src/remotedb/message/item.ts` — `ItemType` enum + transform per item kind.
- `src/remotedb/queries.ts` — getMetadata / getBeatgrid / getWaveformHD / getCueAndLoopsAdv request builders.
- `src/localdb/kaitai/rekordbox_anlz.ksy` — **authoritative** shapes for beat-grid (`PQTZ`), cues (`PCOB`/`PCO2`), waveforms (`PWAV`/`PWV2`/`PWV3`/`PWV4`/`PWV5`), song structure (`PSSI`) including the XOR mask, mood/phrase enums, track_bank enum.
- `src/localdb/kaitai/rekordbox_pdb.ksy` — rekordbox USB/SD database layout (tracks, playlists, etc.).
- `src/mixstatus/index.ts` — "now playing" heuristics worth copying.

### dysentery (https://github.com/Deep-Symmetry/dysentery, Eclipse Public License v1.0)

- `doc/modules/ROOT/pages/packets.adoc` — canonical table of packet kinds per port.
- `doc/modules/ROOT/pages/startup.adoc` — full 4-stage claim choreography, CDJ-3000 variants, channel-specific ports.
- `doc/modules/ROOT/pages/beats.adoc` — beat packet (kind `28`) byte layout + absolute-position packet (kind `0b`).
- `doc/modules/ROOT/pages/vcdj.adoc` — CDJ status and mixer status packet field-by-field, including CDJ-3000 extended fields (Key, KeyShift, MasterTempo, buffers, loop positions).
- `doc/modules/ROOT/pages/track_metadata.adoc` — remotedb framing (message envelope, field types, argument tags, menu-item arguments); authoritative field list for track metadata.
- `doc/modules/ROOT/pages/mixer_integration.adoc` — fader start, on-air packet formats (4- and 6-channel variants).
- `doc/modules/ROOT/pages/sync.adoc` — sync control, master handoff, unsolicited handoff.
- `doc/modules/ROOT/pages/missing.adoc` — "four-players" gotcha and fallback.
- `src/dysentery/view.clj` — practical parsing reference (authoritative byte offsets in `update-cdj-50002-details-label` and `log-beat`; status-flag bit constants; packet length map in `correct-type-and-length?`).

### beat-link (https://github.com/Deep-Symmetry/beat-link, Eclipse Public License v1.0 — observe only, do not copy code)

- `src/main/java/org/deepsymmetry/beatlink/VirtualCdj.java` — `UPDATE_PORT = 50002`, `MAC_ADDRESS_OFFSET = 38`, `useStandardPlayerNumber` default false, `inOpusQuadCompatibilityMode` — useful for understanding the observable-state contract and the Opus Quad compatibility path (rekordbox-posing mode).
- `src/main/java/org/deepsymmetry/beatlink/DeviceFinder.java`, `BeatFinder.java` — event shapes for consumers.
- API docs at https://deepsymmetry.org/beatlink/apidocs/ — reference for the public state model.

### dmx-js/prolink-connect (fork)

Commits since upstream add ESM/modern-runtime build changes and release
tooling; no new protocol constants or parsing changes observed. Skip unless
you specifically target Deno/Bun.
