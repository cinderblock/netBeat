# Research & prior art

This file tracks every reverse-engineering effort, protocol document, and
community resource we've found for the DJ protocols we want to support.
Add new links here as they come up. Don't prune — a dead link or abandoned
project is still valuable as context.

## Pioneer Pro DJ Link

### TypeScript implementations

- [`evanpurkhiser/prolink-connect`](https://github.com/evanpurkhiser/prolink-connect)
  — the de-facto TypeScript implementation. MIT-licensed. Covers device
  discovery, status packets, beat packets, and rekordbox metadata queries.
  Most directly aligned with what we want to build.
- [Tracking issue: protocol coverage](https://github.com/evanpurkhiser/prolink-connect/issues/2)
  — long-running issue documenting what is and isn't implemented in
  prolink-connect. Useful checklist of known packet types.
- [`dmx-js/prolink-connect`](https://github.com/dmx-js/prolink-connect) — fork
  of evanpurkhiser's work, maintained by the dmx-js project for lighting
  control use cases. Published as
  [`@dmxjs/prolink-connect`](https://www.npmjs.com/package/@dmxjs/prolink-connect).
  Worth diffing against upstream to see what dmx-js needed to change.

### Java / Clojure implementations (Deep Symmetry)

Deep Symmetry has done the deepest protocol reverse engineering in public.
Their projects are GPL-licensed, so we cannot copy code directly, but their
findings and documentation are freely usable for independent implementation.

- [`Deep-Symmetry/beat-link`](https://github.com/Deep-Symmetry/beat-link) —
  the core Java library. Handles device discovery, beat packets, status,
  metadata, waveforms, beat grids, cue points.
  - Example deep-dive:
    [`MixerStatus.java`](https://github.com/Deep-Symmetry/beat-link/blob/d86da386baa0fd65c70f75b08fad21af727c8800/src/main/java/org/deepsymmetry/beatlink/MixerStatus.java)
    — good reference for the mixer status packet layout and which fields
    matter for "who is master" logic.
- [`Deep-Symmetry/beat-link-trigger`](https://github.com/Deep-Symmetry/beat-link-trigger)
  — Clojure GUI on top of beat-link. Widely used by lighting/video operators.
  Mostly a UI/integration layer; protocol internals live in beat-link.
- [`Deep-Symmetry/beat-carabiner-java`](https://github.com/Deep-Symmetry/beat-carabiner-java)
  — bridges beat-link to Ableton Link. Interesting as a reference for how to
  convert Pioneer-flavored beat/phase into a normalized "Link-style" clock.
- [API docs — `deepsymmetry.org/beatlink/apidocs/`](https://deepsymmetry.org/beatlink/apidocs/)
  — javadoc for beat-link. The clearest English-language description of the
  observable state that exists anywhere; treat it as a de-facto spec.
- [Zulip community](https://deep-symmetry.zulipchat.com/#narrow/stream/275322-beat-link-trigger)
  — active chat. James Elliott (Deep Symmetry's maintainer) is generous
  about protocol questions. Good place to verify odd packet behavior.

## Denon StageLinQ

*(Planned; not in scope for initial implementation. Add references here as we
find them.)*

## Distilled protocol reference

See [`protocol-reference.md`](protocol-reference.md) for a code-ready digest
of ports, packet kinds, byte offsets, and retrieval paths — compiled from
prolink-connect, Dysentery, and beat-link with citations.

## Notes on read-only ethics — findings

Our stated scope is read-only: we do not want to alter what the DJ hears or
how the hardware behaves. Research confirmed:

1. **Pure passive listening is possible but limited.** Without sending
   anything, we can still receive keep-alive packets (device inventory),
   beat packets (BPM + sub-beat phase), channels-on-air flags from the
   mixer, and absolute-position packets from CDJ-3000s. This alone gets us
   the live-sync picture: who's playing, master BPM, beat phase.
2. **CDJ status packets require posing as a device.** Per dysentery's
   `vcdj.adoc`: players only send status packets unicast to endpoints that
   first announced themselves. Without announcing, we do NOT get trackId,
   play state, master/sync/on-air flags, or emergency-mode signals.
3. **Track metadata is similarly gated.** Both the remotedb TCP path and
   the NFS local-DB scrape require knowing the player's IP (fine from
   passive keep-alives) but querying a CDJ's remotedb requires us to claim
   an ID in 1–4, which in turn requires announcing.
4. **Conclusion:** fully passive is possible for beat-sync / on-air; rich
   metadata requires announcing. Design the library so "observer mode"
   (announces, no sync/control sends) is distinct from "passive mode"
   (only receives). Both are read-only in the sense that we never change
   what the DJ hears.
5. Metadata queries can stress older CDJs if queried too aggressively.
   Rate-limit metadata fetches regardless of path.
