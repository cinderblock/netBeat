/**
 * Metadata types for rekordbox track analysis data.
 *
 * These types describe the data stored in ANLZ analysis files (.DAT/.EXT)
 * and the rekordbox PDB database on USB/SD media. They have no parsing
 * logic — just the value shapes that library consumers work with.
 *
 * Sources: `rekordbox_anlz.ksy`, `rekordbox_pdb.ksy`, and
 * `docs/protocol-reference.md` §5–6.
 */

// ---- Beat Grid (PQTZ section) ----

/** A single entry in the beat grid — one beat's timing + tempo. */
export interface BeatGridEntry {
  /** Beat position within the bar (1–4). */
  readonly beatInBar: number;
  /** BPM at this beat, hundredths precision. Supports variable-tempo tracks. */
  readonly bpm: number;
  /** Milliseconds from track start at normal pitch (no tempo adjustment). */
  readonly timeMs: number;
}

// ---- Cue Points (PCOB / PCO2 sections) ----

/** Discriminator for cue-point types. */
export type CueType = 'memory' | 'hotcue' | 'loop' | 'hotloop';

/** A cue point or loop marker from rekordbox analysis. */
export interface CuePoint {
  /** Type of marker. */
  readonly type: CueType;
  /** Time position in ms from track start. */
  readonly timeMs: number;
  /** Loop end time in ms (only for `loop` / `hotloop` types). */
  readonly loopEndMs: number | null;
  /** Hot cue slot (1–8 for A–H, null for memory cues). */
  readonly hotCueSlot: number | null;
  /** DJ comment label (PCO2 / nexus2+ only). */
  readonly comment: string | null;
  /** RGB color (PCO2 / nexus2+ only). */
  readonly color: { readonly r: number; readonly g: number; readonly b: number } | null;
  /** Color ID from the rekordbox palette (PCO2 / nexus2+ only). */
  readonly colorId: number | null;
}

// ---- Phrase Analysis (PSSI section) ----

/** Track mood determines which phrase-kind vocabulary applies. */
export type TrackMood = 'high' | 'mid' | 'low';

/**
 * Track bank — a lighting-mode stylistic variant pre-selected in rekordbox.
 * Designed for lighting; the name maps to a mood/color palette.
 */
export type TrackBank =
  | 'default'
  | 'cool'
  | 'natural'
  | 'hot'
  | 'subtle'
  | 'warm'
  | 'vivid'
  | 'club1'
  | 'club2';

/** High mood phrase kind — typical EDM structure. */
export type HighPhraseKind = 'intro' | 'up' | 'down' | 'chorus' | 'outro';

/** Mid mood phrase kind. */
export type MidPhraseKind =
  | 'intro'
  | 'verse1'
  | 'verse2'
  | 'verse3'
  | 'verse4'
  | 'verse5'
  | 'verse6'
  | 'bridge'
  | 'chorus'
  | 'outro';

/** Low mood phrase kind. */
export type LowPhraseKind =
  | 'intro'
  | 'verse1a'
  | 'verse1b'
  | 'verse1c'
  | 'verse2a'
  | 'verse2b'
  | 'verse2c'
  | 'bridge'
  | 'chorus'
  | 'outro';

/** Union of all phrase kinds across all moods. */
export type PhraseKind = HighPhraseKind | MidPhraseKind | LowPhraseKind;

/** A single phrase entry from PSSI song structure analysis. */
export interface Phrase {
  /** 1-based phrase number. */
  readonly phraseNumber: number;
  /** Beat number at which the phrase starts (use beat grid to convert to ms). */
  readonly beatNumber: number;
  /** Phrase kind — meaning determined by the track's mood. */
  readonly kind: PhraseKind;
  /** Raw kind number from the PSSI entry (for unknown/unmapped values). */
  readonly rawKind: number;
  /** Whether a fill-in is present at the end of this phrase. */
  readonly fillIn: boolean;
  /** Beat number at which the fill-in starts (if `fillIn` is true). */
  readonly fillInBeatNumber: number | null;
}

/** Complete phrase analysis from a PSSI section. */
export interface PhraseAnalysis {
  /** Track mood — determines which phrase-kind vocabulary applies. */
  readonly mood: TrackMood;
  /** Beat number at which the last phrase ends. */
  readonly endBeat: number;
  /** Track bank — lighting-mode stylistic variant. */
  readonly bank: TrackBank;
  /** Ordered list of phrases. */
  readonly phrases: readonly Phrase[];
}

// ---- Aggregated Track Metadata (from PDB database) ----

/** Track metadata from the rekordbox PDB database. */
export interface TrackMetadata {
  /** Rekordbox track ID (slot-relative). */
  readonly trackId: number;
  /** Track title. */
  readonly title: string;
  /** Artist name. */
  readonly artist: string;
  /** Album name. */
  readonly album: string;
  /** Genre. */
  readonly genre: string;
  /** Record label. */
  readonly label: string;
  /** Musical key (e.g. "Ab", "Fm"). */
  readonly key: string;
  /** Track BPM from rekordbox analysis. */
  readonly bpm: number;
  /** Duration in seconds. */
  readonly duration: number;
  /** Rating (0–5 stars). */
  readonly rating: number;
  /** Track comment. */
  readonly comment: string;
  /** Year of release. */
  readonly year: number;
  /** Bitrate in kbps. */
  readonly bitrate: number;
  /** Color ID from the rekordbox palette. */
  readonly colorId: number | null;
  /** Path to the ANLZ .DAT file on the USB/SD media. */
  readonly anlzPath: string;
}

// ---- Complete per-track analysis bundle ----

/** Everything we can learn about a track from the USB/SD media. */
export interface TrackAnalysis {
  /** Track metadata from PDB (null if PDB unavailable). */
  readonly metadata: TrackMetadata | null;
  /** Beat grid entries (null if ANLZ unavailable or section missing). */
  readonly beatGrid: readonly BeatGridEntry[] | null;
  /** Cue points and loops from PCOB + PCO2 sections. */
  readonly cuePoints: readonly CuePoint[];
  /** Phrase analysis from PSSI section (null if .EXT unavailable). */
  readonly phrases: PhraseAnalysis | null;
}

// ---- ANLZ file parse result ----

/** Parsed contents of an ANLZ analysis file (.DAT or .EXT). */
export interface AnlzFile {
  /** Beat grid from PQTZ section. */
  readonly beatGrid: readonly BeatGridEntry[] | null;
  /** Cue points from PCOB + PCO2 sections (merged). */
  readonly cuePoints: readonly CuePoint[];
  /** Phrase analysis from PSSI section (.EXT only). */
  readonly phrases: PhraseAnalysis | null;
}
