# Session progress — 2026-05-19 (later)

Third session of the day. Big push: synced the beat-1 plumbing, decoupled deck
identity from channel assignment, built a scroll-spinner widget, added
Transition / CUT / per-deck auto-advance, and switched routing pills to a
gated state. Library down 18 tracks (Streets of Rage dropped).

## Sync fix — beat_one_tick + bpm_initial plumbed end-to-end

The main DJ app used to drop a deck at *raw* tick 0, treating that as the
music's beat-1. For any track with a count-in, pickup, or silent pad before
the audible downbeat, drop B always landed off-grid against A. Manifest
schema now carries `beat_one_tick` (default 0) and `meter` (overridable);
the override file accepts both alongside `perceived_bpm`. `dropDeck`,
`anchorMasterToDeck`, and the play-button handler all anchor against
`beat_one_tick` instead of raw 0.

`playDeck` also stops seeding `currentBPM = master.bpm` and uses
`bpm_initial` from the manifest, so the pre-first-tempo-event window plays
at the right rate on lying-tempo files instead of jumping at tick 0.

The previewer got an **Export → tempo-overrides.json** button that emits a
paste-ready snippet for any tracks the user has BPM/offset/meter-anchored
in localStorage.

## Heuristic trust window widened (70–200 → 50–220)

The IOI heuristic was overriding honest 60-BPM files with bad guesses
(Doom levels 3-8 came out 125/91/120/81/150/91 in the manifest when Logic
confirms they're all 60). Trust window widened so files authored at 60 land
in the "trust the file" zone. 77 tracks changed perceived_bpm in the
regen; existing overrides (doom level2 / level9 / reptilerumble) are
untouched.

## Decks A/B → 1/2; new `deck.channel` field

Decoupled deck identity (Deck 1 / Deck 2 — what you load tracks into) from
channel assignment (Channel A / Channel B — what the mix-switch routes
between). Deck 1 defaults to Channel A and Deck 2 to Channel B; a per-deck
A|B toggle reassigns without restarting playback. The mix-switch's
`mixState` strings (`a` / `both` / `b`) stay unchanged because they
already named channels semantically.

## Scroll-in-place spinner widget

New `mountSpinner` alongside the existing `mountSlider`/`mountDropdown`/
`mountToggle`. Cycles by ‹/› taps, mouse wheel, or horizontal touch drag.
Replaces:
- master meter dropdown
- the five per-deck loop-length pads → one `loop` toggle + one length
  spinner each. 27-entry list: 1/8 beat through 16 bars (music-theory bars:
  1 bar = 4 beats in 4/4), with half-beat increments through 8 beat for
  syncopation loops (3.5-beat against a 4-beat phrase etc.).

Loop length is dial-able live during an active loop — `loop.in` stays put,
`loop.out` re-derives. Sub-beat loop starts now snap to their own length so
a 1/8-beat stutter doesn't round to the next whole beat.

I initially labelled this in DJ-phrase bars (1 bar = 16 beats) — visibly
wrong on the roll, fixed to music-theory bars in a follow-up commit.

## Transition / CUT / channel toggle / unmute-all / auto-advance

Per deck:
- **trans** — copies this deck's mute set onto the opposite-channel deck
  in inverted form, then drops it at the next master bar if it isn't
  already playing. Flashes red if both decks share a channel.
- **cut** — schedules silence for the next master bar; tap again to cancel.
- **A|B channel toggle** — flips `deck.channel`; silences immediately if
  the flip pushed the deck off the audible channel.
- **unmute all** — clears the deck's outputMute set in one tap.
- **auto ↻** — when track ends, loads next in current browser order and
  drops at next master bar. Inherits routing / mute / transpose; loop and
  transport reset.

Channel/auto/unmute-all moved to the deck-head top-right so the routing
pills get the full bottom-row width (the routing-aux row used to sit
under the pills as a fixed dead band).

## Gated routing-pill indicators

Replaced the 90ms flash-on-noteOn with a per-output active-note counter
(`deck.outputActive`). Pills stay lit while ANY note is still sounding on
that output and dim only when the last one ends. Every MIDI noteOn/noteOff
to a hardware output now flows through `dispatchNoteOn`/`dispatchNoteOff`
helpers so the gate stays accurate across loop wraps, mute toggles,
transpose changes, transitions, and silence-deck calls.

## Library audit — source fingerprints found

Library down to 774 tracks across 14 games (Streets of Rage dropped, 18
tracks — the user hadn't heard of it).

Started a per-game source audit. Discovered Street Fighter's 55 tracks
split cleanly into three clusters by metadata:

- **26 tracks** with `embedded_name = "HMP2MID.EXE by Markus Hein"` —
  these are direct conversions from Capcom's HMP arcade-sequence files.
  Authentic source data, but the bpm=25 metadata is a converter quirk and
  the original Capcom sequencing is loose by nature. May need
  re-conversion with a better HMP→MIDI tool.
- **24 tracks** at default file_bpm=120 with no embedded name —
  fan transcriptions, varying quality, most likely candidates for
  replacement.
- **5 tracks** at custom BPMs — better-authored fan work.

Plan to replace some game libraries with higher-quality sources:
- **Street Fighter** — likely SPC2MIDI from SNES SF2/SSF2/SSF2T SPC files
  (snesmusic.org). SPC files contain the actual SNES sound-chip sequencer
  data, so the converted MIDI is tight by construction.
- **Donkey Kong** (DKC1/2/3) — also SPC-sourceable for SNES tracks.
- Possibly **Mega Man X** and **Final Fantasy** SNES titles for the same
  reason.

The library-wide metadata audit + per-track quality score (in the browser)
is the next-likely build to make this navigable.

## What's verified / what still needs eyes

Verified by user:
- Timing improved after sync fix.
- Doom level3 reports 60 BPM in the manifest (was 125).
- Footer transport centred.
- Loop button works on mobile after the `loadTrackIntoDeck` beats-preservation fix.

Still needs verification:
- Gated routing-pill indicator behaviour (lit through long notes, dims when last note ends).
- The 77 perceived_bpm flips from the heuristic-widening — Chrono Trigger
  w1000a* now claims 210 BPM, which is at the trusted-zone edge and might
  be wrong (file lies). Spot-check candidates.
- Transition / CUT / auto-advance under live use.

## Open follow-ups carried forward

- Meter-map / tempo-map architecture (the file's per-segment maps walked
  through the renderer + worker + manifest). Still outlined, not built.
- Library metadata audit + quality-score browser badge (to act on this
  session's source-fingerprint discovery at scale).
- Replacement Street Fighter library via SPC2MIDI workflow.

---

# Session progress — 2026-05-19

Second session. Built two-anchor warp, metronome, and a per-track override system; fixed a clutch of pernicious manifest bugs (Terra Funk's stray tempo at bar 190, Jenova's straggler-note cluster, Contra's IOI quantisation, FF6 ending's truncated file). Still local, not pushed.

## Library

- **Lemmings dropped** — 26 tracks removed (`docs/midi-files/lemmings/`). Library: 818 → 792 tracks across 15 games.
- **Doctored Doom & DKC tracks swapped in** — `doom/level2.mid`, `doom/level9.mid`, `donkey-kong/reptilerumble.mid` replaced with Logic-beat-mapped versions (file tempos are now correct: 136 / 76.89 / 103.46 BPM). Originals copied to `backups/originals-pre-doctored/` outside the served tree.

## Previewer — two-anchor warp

Replaced the single "mark beat 1 on roll" button with a proper **two-anchor warp** override. User clicks any note on the roll to pin Anchor A, labels it as a (bar, beat) position; same for Anchor B somewhere later; **Apply warp** back-solves `perceived_bpm` and `beat_one_tick` so both anchors land on grid.

- Snap-to-nearest-noteOn within ~2% of the visible window (Shift bypasses snap).
- Gold "A" and blue "B" tab markers drawn on the roll as dashed verticals.
- Bar/beat inputs (defaults 1/1 and 9/1). Compound meters honoured via `meter.ticksPerBeatMul`.
- Apply button flashes the resulting BPM + offset; warns on degenerate inputs (A=B, opposite directions, out-of-range BPM).
- Anchors persist per-track in localStorage alongside the existing BPM/meter/offset overrides.
- New meter options in the dropdown: 2/4, 6/4, 9/8.

The previewer's "detected" BPM and meter now come from the manifest (`perceived_bpm`, `meter`) instead of being hardcoded. The info bar shows `XX (file claims YY)` parenthetical when the manifest's perceived value differs from the file's raw tempo average — helpful for spotting lying-tempo files (Doom, etc).

## Previewer — metronome + spacebar

- **♩ Metronome** toggle in the transport bar. Schedules GM-drum-kit woodblock hits on every grid beat: note 76 (Hi Wood Block) on downbeats, 77 (Lo Wood Block) on other beats. Beat positions are derived from the active grid (BPM × meter × beat-1 offset) and converted to ms via the same tempo map the MIDI events ride.
- **Spacebar** toggles play/pause anywhere on the page, ignored when an INPUT/SELECT/TEXTAREA has focus so typing a BPM doesn't pause playback.

## Per-track tempo override mechanism

New file: **`tools/tempo-overrides.json`**. Per-path entries override the manifest's `perceived_bpm` (and recompute `perceived_ticks_per_beat`) for tracks the user has verified by ear — typically after beat-mapping in Logic. `build-manifest.js` reads it on every run, applies entries, preserves the heuristic's guess in a new `perceived_bpm_auto` field. Seeded with:
- `doom/level2.mid` → 136
- `doom/level9.mid` → 77
- `donkey-kong/reptilerumble.mid` → 103

## Manifest builder — major correctness pass

Several systemic bugs in `tools/build-manifest.js` and `docs/midi-worker.js`:

1. **End-of-music tick** is now computed from the last *note* event, not the last *any* event. Stray tempo / EOT / sysex / CC events past the last note (Terra Funk has a tempo at bar 190 past bar-83 music) were inflating `duration_sec` and the roll's maxTick.
2. **Straggler-cluster trim** — small trailing note clusters separated from the bulk by a long silence are now trimmed. Yamaha XG ("Xg") rips include 1–5% of notes 10×+ past the music's real end. Jenova Absolute went from **26:07 → 2:03** (Logic says 2:01). Mark of the Traitor: **154:18 → 1:38**. Staff Roll: **197:15 → 7:02**.
3. **Stop rounding BPM** — `bpm` and `bpm_initial` now carry two decimal places. The worker also stops rounding tempo events to integer (`Math.round(60000000/tempo)` → `60000000/tempo`), so playback ms-per-tick stays accurate over long tracks.
4. **Trust the file's tempo** when it's in a normal listening range (70–200 BPM). The IOI heuristic is kept only as a rescue for files lying at extreme tempos — Doom at 60, Castlevania at 240/250. Contra base now correctly reports **146** (was 143) instead of the IOI's quantised guess.
5. **Truncated-file tolerance in the worker** — `FF6_60_Ending_Theme.mid` claims 21 tracks but the file is corrupt and ends after track 7. The worker now bounds-checks each MTrk header before reading and clamps `trackEnd` to file size, matching the behaviour `build-manifest` already had.

## Findings — empirical groundwork for grid detection

- **Doom level9** is *really* at 76.89 BPM (Logic Smart Tempo). Our IOI heuristic was giving 154 (× 2). My alignment-score scan ranked 102.5 (× 4/3) first — even a "smarter" detector can't break the 2× / 3:2 tie without listening. Suggests the future detector should surface **top-3 candidates** as one-click chips rather than guessing.
- **Many tracks have meter changes** that we currently collapse to the first meter event. Jenova Absolute is `2/4 → 1/4 → 3/4`; most of the music is in 3/4. The manifest reports 2/4. Same for Contra boss's tempo: file has an intro automation 132 → 136, weighted average is 134.05, Logic shows the steady 136. **The right fix is a meter-aware / tempo-aware grid renderer** — walk the file's actual maps segment by segment rather than collapsing to one number. Outlined but not yet built.

## Open / not done

- **Meter-map / tempo-map architecture** — the structural fix to "VGM-DJ should respect the file's automation". Pass the full meter and tempo arrays through to the worker output and `tracks.json`; previewer's `renderRoll` walks the meter map; metronome follows. ~150 lines across worker + previewer + manifest. Highest-leverage thing left undone.
- **Main DJ reading overrides** — `app.js`'s `buildRoutingUI` still ignores `overrides.json`. Previewer-side work doesn't reach the live rig yet.
- **Spread-out straggler tracks** — 36 tracks still report >30 min after the cluster-trim. Their stragglers are spread across the timeline rather than clustered. Needs a density-based rule (end-of-music = where note density drops to ~zero) rather than a single-gap-boundary rule.
- **Candidate-chip BPM detector** — "Auto-detect grid" button in the previewer that shows top-3 alignment-score candidates as chips. Foundation done (alignment scoring works); UI not built.

## What's verified

- Contra base / stage1 now show 146 BPM (matched Logic exactly).
- Terra Funk shows 2:46 instead of 6:21.
- Jenova Absolute shows 2:03 instead of 26:07.
- FF6 ending loads instead of throwing.
- Doom level9 perceived BPM = 77 (matches doctored file + Logic).
- Castlevania files still get the IOI half-time fold (240 → 115 etc).

What still needs the user's eyes:
- Previewer two-anchor warp: pick a song that doesn't already line up, anchor A on a downbeat, anchor B further on, hit Apply, verify grid follows.
- Metronome: toggle on, verify clicks land on the visible grid lines.
- Spacebar play/pause works; doesn't pause when typing in BPM input.

---

# Session progress — 2026-05-18

Fifteen commits landed on `main`, all local (not yet pushed to GitHub). Library, tools, dispatcher, sync, and a new standalone previewer/editor page all moved forward in one session.

## Library

- **Commander Keen dropped** — 13 tracks removed (`docs/midi-files/commander-keen/`). Manifests regenerated. Library: 831 → 818 tracks across 16 games. Commit `d78e662`.
- **SETLIST.md removed** — superseded by the manifest-driven library browser. Commit `a56146e`.

## New tool: library scan (`tools/scan-library.js`)

One-shot CLI (`npm run scan`) that walks every MIDI under `docs/midi-files/` and produces a full picture of what's in the library. Outputs `docs/library-report.json` (machine-readable, ~3 MB) and `docs/library-report.md` (skimmable summary).

Per channel of every track: GM patch (from programChange), pitch low/high/avg, polyphony %, max simultaneous notes, note density, mono/poly classification. Per game: dominant channel-position layout, dominant patch per slot, mono-vs-poly tendencies, register profile. Library-wide: patch-category histogram, channels-per-track histogram, stereo-duplicate counts.

Key findings from the first scan:
- **818 tracks across 16 games**, 7.6 avg channels per track.
- **4,085 mono channels vs 2,098 poly** — about two-thirds of all channels are monophonic.
- **Bass-category patches** on 552 channels (~0.66 per track) — explicit bass labelling is common.
- **Final Fantasy and similar orchestral games** (~45% of library) typically have 5–9 mono parts per track — far more mono content than the current 2-mono-output rig can render distinctly.
- **136 tracks (16%) had detected L/R stereo duplicates** in the first pass.

Commit `5aa59b5`.

## L/R duplicate detection — non-destructive parse-time filtering

After seeing the scan results, we wired duplicate detection into `tools/build-manifest.js` so every track entry in `tracks.json` carries a `drop_channels: [int]` list. The worker (`docs/midi-worker.js`) accepts that hint in its postMessage payload and silently drops noteOn/noteOff events for those channels at parse time. Source MIDI files stay byte-identical; the dedup is applied on read; reversible by flipping the flag.

Two detection passes:
1. **Tick-bucket overlap**: pairs of channels with ≥90% of their (tick, pitch) tuples matching within ±5 ticks → flag the higher-numbered channel.
2. **Stat-identity** (added after a Donkey Kong false-negative): channels with identical note count, pitch range, and average pitch (Δ < 0.05) — catches L/R copies where the tick-bucket scan misses (different velocities, slightly offset ticks).

Final numbers: **221 of 818 tracks have detected duplicates**, **383 channels dropped library-wide** (up from 135 / 216 after pass 1 alone). The main DJ app and the previewer both pass `track.drop_channels` to the worker on load. Commits `92a7fd2` then `66830cb`.

## New standalone tool: previewer/editor (`docs/previewer.html`)

A companion page reachable from the main DJ via a "previewer →" link in the header. Built to audition individual MIDI files, inspect their per-channel detail, and set per-track overrides without touching the source files.

### Features as of end of session
- **Pick from library** (game / track dropdowns, auto-loads on change) or arbitrary file picker.
- **Channel table** with stats: GM patch name, note count, register low/high, avg pitch, polyphony %, max simultaneous, mono/poly tag, suggested role (`bass` / `lead` / `drums` / `strings` / `pad` / `piano` / `other-mono` / `other`), output assignment dropdown, solo / mute toggles, activity dot.
- **Stereo-duplicate badge** (`≈ ch N`) next to the patch name when a channel was flagged as L/R of another.
- **Global role allocation**: exactly one channel claims `bass` → Bass Stn 2 (lowest-avg-pitch mono in bass register or patch-tagged bass), exactly one claims `lead` → SH-01A (highest-avg-pitch remaining mono in lead register or patch-tagged synth-lead). All remaining mono and poly material disperses to Juno (avg pitch < 60) or Keytar (avg ≥ 60). Fixes the case where multiple Donkey Kong channels all claimed "lead → SH-01A" in the first version.
- **Piano roll** mirroring the main DJ's: same colour palette, bar+beat grid, drum strip, playhead during playback, click-to-seek, scroll-to-zoom, shift-drag pan; muted/non-soloed channels dimmed to ~10% opacity.
- **GM-quality audio** via WebAudioTinySynth (the same library the main DJ already uses for preview). Drums on channel 9 route to the synth's built-in GM drum kit; all other channels get their source file's `first_program` (or piano default if untagged). On every play press, all 16 synth channels are reset-controllers + all-notes-off to prevent any state leaking between tracks.
- **Override panel above the piano roll**:
  - **BPM override** (numeric input, scales the grid's ticks-per-beat).
  - **Meter override** (3/4, 4/4, 5/4, 6/8, 7/8, 12/8). Compound meters (denom 8, num divisible by 3) get dotted-quarter beats with 3 eighth-note subdivisions per beat. Fixes the case where 12/8 tunes looked like sloppy sixteenths against a 4/4 grid.
  - **Beat-1 offset (anacrusis)**, in ticks. "Mark on roll" button arms the next roll click to set the offset interactively.
  - **Reset** button clears all override fields for the loaded track.
- **Persistence**: overrides save to browser localStorage under `previewer-overrides-v1`, keyed by track path. Routing overrides (from the channel-row dropdowns) and grid overrides (from the panel) are merged into the same per-track object. "Download overrides.json" exports the full map as a file.

Commits `b95bc1e` (page + first version), `b72da55` (override panel + compound meter grid), `168eb31` (WebAudioTinySynth swap), `f1a1c57` (channel reset on load).

## Routing safety

- **Monophonic outputs enforced in the dispatcher** — `MONO_OUTPUTS = { 1, 2 }` (SH-01A and Bass Station 2 are hardware monosynths). `dispatchEvent` silences any other active note on these outputs before triggering a new noteOn, so the hardware doesn't choke on polyphonic input regardless of routing. Commit `f9e3f46`.

## Sync — main DJ

- **`playDeck` switched to absolute-time scheduling**. Previously the step() loop chained relative `setTimeout(deltaMs)` calls; each timer's jitter (4 ms typical, more under load) propagated forward and accumulated into seconds of drift over a session, and decks couldn't stay in sync. Now `deck.startWallTime` is the anchor, and each event's setTimeout duration is computed against `startWallTime + cumulativeMs` — an absolute wall-clock target — so the lateness of any one event can't propagate. Tempo events and pitch changes (`setMasterBpm`) still flow through correctly via the accumulator. Commit `d122f59`.

  The same look-ahead pattern is already in the previewer's `scheduleAhead`, so this was a port of a validated approach into the main app's playback chokepoint.

## Other fixes

- **Piano-roll scroll-to-zoom restored** — the commit that landed in 5d15e0e (the user's own pre-session edits) had tightened the wheel handler to require ctrl/cmd/shift for zoom. That broke plain-mouse-wheel-zoom on macOS smooth-scroll setups. Reverted to "vertical scroll = zoom by default; shift+wheel or horizontal swipe = pan". Commit `2e0eb6c`.

## Documentation

- **`CLAUDE.md` synced** with the current architecture (worker, idle render, multi-game chips, BPM range, deployment section, current commit history). Commit `8ef92a8`.
- **`NOTES.md` added** as a design doc for the grid-alignment problem — the dependency chain (file → perceived BPM → ticks-per-beat → pitch warp → master clock → roll grid → loop pads), where it breaks down, the iPad touch UX tension, and a prioritised "where to push next" list. Commit `0cd5755`.

## Memory (cross-session, kept under `~/.claude/projects/.../memory/`)

- `hardware_bass_station_mono.md` — outputs 1 (SH-01A) and 2 (Bass Station 2) are hardware monosynths; dispatcher enforces mono, routing must never auto-send poly there.
- `feedback_heuristics_overrides.md` — VGM library is too varied for one-size-fits-all auto-detection; every automated decision needs a per-track manual override path.
- `project_future_hardware_options.md` — Andrew's Nord and a second SH-01A discussed as additions to handle multi-voice mono content (FF strings); deferred until the current 5-rig is tested in anger.

## Deployment status

**15 commits ahead of `origin/main`. Not yet pushed.** Pushing `main` is the deploy; GitHub Pages will pick it up within ~1–3 min and reflect everything in this session on <https://midislave.github.io/vgm-midi-dj/>.

Per the user's standing instruction at the start of the session: push only after verifying all changes locally. Verified during the session: scroll-to-zoom, Bass Station mono, the previewer page (channel table + drums + grid panel), the Donkey Kong global-allocation fix. The sync fix (`d122f59`) was code-reviewed but not yet listened to over a long-running play.

## What's pending (open tasks)

- **#3 — Auto-detect silence segments** and split long tracks into Pt 1 / Pt 2 / … entries. Final Fantasy is full of tracks with huge mid-track gaps where the trim+segment approach would help.
- **#4 — Role-based routing in the main DJ app's `buildRoutingUI`**. The previewer has the deterministic allocation working; the main app still uses the positional default and doesn't read `overrides.json`. Wiring this in is the main outstanding piece of work to make the previewer's overrides actually affect live performance.
- **#7 — Full look-ahead scheduler with WebMIDI timestamps**. The intermediate absolute-time fix (`d122f59`) eliminates cumulative drift but still has a one-event lag when master BPM changes mid-play. The full look-ahead scheduler with `output.send(bytes, timestamp)` would resolve that and bring sub-millisecond precision.
- **#10 (in progress) — Per-track override editor**. BPM / meter / beat-1 offset all done in the previewer. Still pending: start/end trim markers (draggable on the roll, auto-trim button), drop-channel toggle (undrop a false-positive duplicate or drop a channel manually), and the main DJ app reading the saved overrides.

## How to verify after pushing

- `https://midislave.github.io/vgm-midi-dj/` should load the main DJ with the previewer link in the header.
- `https://midislave.github.io/vgm-midi-dj/previewer.html` should load the previewer page.
- Smoke tests: load a Contra track (dedup), a Donkey Kong track (global role allocation), `03dkc2boss` with meter override set to 12/8 (grid alignment), play a long Final Fantasy track on both main-app decks and confirm they don't drift over five minutes (sync fix).
