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
