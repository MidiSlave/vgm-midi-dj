# Notes — the grid-alignment problem

The single ambition driving most of the open issues: **two decks should be able to play in lock-step on a shared musical grid, with loops and drops landing seamlessly on the beat across the transition.** Everything below is in service of that.

This note is a snapshot of where we are, what makes it hard, and what's still open.

## The dependency chain

For two decks to lock together perfectly, every layer of the chain has to agree on where the beats are:

1. **The MIDI file** has to be musically clean — notes actually on the grid, no sloppy quantisation.
2. **Our perceived BPM** estimate (from `tools/build-manifest.js`) has to match the file's audible groove.
3. **`perceived_ticks_per_beat`** (= `round((avg_meta_bpm / perceived_bpm) × file_ticksPerBeat)`) has to give us an integer number of file-ticks per real musical beat.
4. **The deck's pitch warp** (= `master.bpm / perceived_bpm`) has to scale playback so one perceived beat = `60 / master.bpm` seconds in real time.
5. **The master clock** has to phase-align with the deck's beats (anchored on play/drop).
6. **The piano-roll grid** has to render from the same `perceived_ticks_per_beat`.
7. **The loop pads** have to use the same `perceived_ticks_per_beat × meter` for bar boundaries.

If every link holds, four-beat loops sit on the bar, deck transitions land on master beat 1, and a 16-beat loop on deck A can hand off to deck B mid-bar without anything stuttering.

In practice, the chain has weak links.

## Where it breaks down

### 1. Tempo-detection octave guessing

`detectPerceivedBpm` runs an IOI histogram, takes the dominant inter-onset interval, then octave-folds into 80–160 BPM. For most tracks the result is sensible. But:

- The 80–160 range is a bias, not a rule. A track that genuinely sits at 70 BPM gets pushed to 140; a 165-BPM track gets halved to 82.
- The IOI peak is the *dominant subdivision*, not necessarily the quarter. A track dense with 16ths sometimes folds into half the right BPM; a sparse track sometimes folds into double.
- Two tracks that are musically *the same tempo* can come back with different perceived BPMs if their note density differs.

When this is wrong, perceived_ticks_per_beat is wrong, the warp is wrong, the loop length is wrong, and the visual grid is wrong — all in the same way, so visually it looks consistent. The track plays smoothly but at the wrong audible tempo, and loops will be the wrong number of "real" beats.

We currently have no way to override the perceived BPM per track from the UI.

### 2. Anacrusis / non-zero downbeat

The piano-roll grid and `perceived_ticks_per_beat` assume **tick 0 = beat 1**. For most VGM this is true. But some tracks have pickup notes, fade-in intros, or a few ticks of silence before the actual downbeat — and then everything is offset.

You can see this visually: notes look like they sit *between* the grid lines. Loops anchored to nearest-beat will then land on the off-beat. We don't currently detect or expose a beat-offset.

A proper fix would be a beat tracker (Ellis 2007 / madmom-style) that finds both period AND phase. That's a substantial addition, probably belongs in the manifest builder.

### 3. Tempo-mapped tracks

When a track has tempo meta events (ritardandos, accels, section changes), `perceived_ticks_per_beat` is an *average*. The real tempo at any moment can be different.

What this means in practice:

- Master clock anchors to the deck at play time, so beat 1 lines up immediately.
- As the deck plays through a tempo change, the deck speeds up or slows down (because the file's tempo event fires) — but the deck is still warped by the same fixed `pitch = master.bpm / perceived_bpm` ratio.
- The master clock is unaffected and keeps ticking at `master.bpm`.
- Over the tempo change, master and deck drift apart by `(current_section_bpm − avg_bpm)` worth of time per beat.

For most VGM (stable tempos) you'd never notice. FF6 has notable rits, Chrono Trigger has section accels — those tracks will visibly drift the master indicator.

A proper fix would be to **re-anchor master continuously** to the playing deck, not just at play time. That makes the master a "follower" rather than independent reference. Fine for single-deck playback; awkward when both decks are playing different tempos.

### 4. Mid-playback master BPM changes

`setMasterBpm` re-anchors master to the playing deck's live position so the visual doesn't jump. The deck's pitch is recomputed so it now plays at the new master tempo.

But the deck is currently mid-event, with a `setTimeout` already in flight scheduled at the old `msPerTick`. The next event fires at the old timing; from then on, new timing. One event's worth of jitter — usually inaudible, sometimes a click.

A proper fix would be to cancel the pending timeout and reschedule from the live position with the new rate. Doable but non-trivial because `step()`'s recursion holds local state.

### 5. Loop point seamlessness across decks

A "seamless loop across both tracks" means:

- Deck A is looping (e.g. 8 beats).
- At a master downbeat, you want deck B to take over from where deck A is looping out.

For this to be perfect:

- Deck B's start position has to land on the same master beat as deck A's loop point.
- Both decks need to be on the same `master.bpm` grid (they are, by warp).
- Drop must launch at master beat 1 from a cue point on B that you've prepared.
- The cue point on B has to actually be on B's beat 1 (or wherever you want the handoff to land).

The recent fix that made DROP respect `deck.currentTick` is critical for this — without it, drops always reset to file tick 0, which is rarely where you want the handoff. With it, you can scrub deck B to a chosen point, hit DROP, and it lands musically.

Still open: **a way to nudge deck B's cue point onto its own beat 1**. Currently the snap-to-beat on scrub uses `perceived_ticks_per_beat` — so the cue snaps to the nearest perceived beat — but it doesn't snap to a *bar*. For seamless transitions you usually want the next deck to start on its bar 1, not just any beat.

## The iPad touch UX tension

The same finger-down on the piano roll has to mean two contradictory things:

- "Tap here to cue the playhead to this position." (single-finger, one quick gesture)
- "I'm about to pinch-zoom into this area." (first finger of a two-finger gesture, second finger ~50–100 ms later)

Currently we resolve in favour of the cue: any first-finger touch immediately seeks. This makes pinch-zoom hard because the playhead jumps before the second finger lands.

We tried deferring the seek by 110 ms with a 4 px movement deadband. That made pinch reliable but broke the cue→drop workflow (felt sluggish to tap a cue point). Reverted.

Possible resolutions, in order of effort:

1. **Mode toggle** — a small "edit / browse" switch on the piano roll. Edit mode = single-finger cues. Browse mode = single-finger pans, two-finger zooms, no accidental cues.
2. **Defer only when zoomed in** — at zoom 1× there's no reason to pinch, so single-finger always cues. When zoomed > 1×, defer to give pinch room.
3. **Pan with single-finger when zoomed** — make scrubbing harder to invoke; e.g. require shift on desktop or a tap-then-drag on touch.
4. **Real beat-tracker** that finds bar boundaries — then "tap" snaps to nearest bar instead of nearest beat, which is what cue-points usually want anyway. Reduces the precision needed for the touch interaction.

We haven't picked one yet.

## What's currently solid vs hand-wavy

**Solid**
- Warp model: both decks play at `master.bpm` regardless of file tempo.
- Piano-roll grid and loop pads use the same `perceived_ticks_per_beat`.
- DROP aligns to master next downbeat, respects scrubbed cue position, re-anchors master.
- Note-tail preservation across loop wraps.
- Off-thread MIDI parsing (Web Worker), deferred canvas render (rIC).

**Hand-wavy**
- Perceived BPM accuracy on outliers.
- Anacrusis / beat-1 offset.
- Drift on tempo-mapped tracks.
- iPad single-finger conflict between cue and pinch.

## Where to push next (in priority order)

1. **Per-track BPM/offset override**. Even a manual "this track is actually 100 BPM, beat 1 is at tick X" would let the user fix anything the detector got wrong. Could live in `tracks.json` as overrides, or per-deck inline.
2. **iPad mode toggle** (option 1 above) — cheapest fix for the touch conflict.
3. **Bar-aware snap on scrub** — snap to nearest bar (not just nearest beat) so cue points land where you'd actually want a transition.
4. **Beat-tracker in the manifest** (longest-term) — proper period + phase detection. Removes most of the manual overrides.
