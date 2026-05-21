# VGM MIDI DJ

**Live app:** <https://midislave.github.io/vgm-midi-dj/>

Two-deck DJ webapp for performing classic video-game MIDI through hardware synths (or in-browser GM for preview). Built for an iPad live set: pick tracks, warp them to a shared tempo grid, mute outputs on the fly, beat-loop, transpose, transition between decks with inverse-mute, cut hard at the next bar, and auto-chain tracks.

## What it does

- **Two decks** with per-deck transport, output mute pills, beat loops, key transpose, vertical volume fader, and an animated piano roll.
- **Single master tempo grid.** Both decks warp to one master BPM. The master also drives a beat counter and quantises drops, transitions, cuts, and auto-advance.
- **Track library browser** loaded from a precomputed manifest (~810 tracks across 14 games). Sortable columns: title, game, release, BPM, key, meter, tags, length. Filter by game; search by title.
- **Hardware mode** routes MIDI to a connected USB MIDI interface (channel-mapped to a specific synth rig). Output port selectable in settings.
- **Preview mode** plays everything through an in-browser GM synth (WebAudioTinySynth) using representative patches that simulate each hardware destination — so you can rehearse anywhere.
- **Mix switch** (Channel A / A+B / B) instead of a crossfader, since MIDI cuts don't crossfade musically. Each deck has an independent channel assignment, so either deck can be on either channel.
- **Deck skins.** Each deck shows a low-opacity game cover image in the background of whatever track is loaded.

## Features

### Master transport (footer)
- Beat-count dots centred between the side controls
- Tap-tempo + reset-to-beat-1 (↻)
- Meter spinner (2/4 – 8/4)
- BPM slider — single source of truth; both decks auto-warp
- First loaded track auto-anchors master BPM so nothing gets warped on launch

### Deck (×2 — Deck 1 and Deck 2)
- **Piano roll** — notes coloured by source channel, drum lane at the bottom. Drag to scrub (snaps to beat; hold Shift for fine scrub). Scroll to pan, ctrl/cmd/pinch to zoom. Double-click resets zoom. A faint top strip shows the visible window when zoomed.
- **Live stats** — native BPM, key, length, position, meter (with `*` if it changes).
- **Output pills** — one per hardware destination receiving signal (Juno · 2, SH-01A · 1, …). Tap to mute/unmute that output. Pill lights up while any note is sounding on that output and dims when the last one ends.
- **Vertical volume fader** on the right of the piano roll (top = max).
- **Transport controls** (left → right):
  - **▶ play** / ■ stop
  - **drop** — quantised launch at next master downbeat
  - **trans** — transition: drops the opposite-channel deck at the next bar with **inverse output mute** (anything muted here becomes unmuted there and vice versa). Flashes red if both decks share a channel.
  - **cut** — hard swap at next bar: stops this deck *and* drops the other deck (if loaded). Tap again while pending to cancel.
  - **cue** — solos this deck
  - **loop** toggle + length spinner. 27 lengths from `1/8 beat` to `64 bar` (music-theory bars: 1 bar = 4 beats in 4/4), with half-beat increments through 8 beats for syncopation. Length is dial-able live during an active loop — `loop.in` stays put, `loop.out` re-derives. Tap loop again while active to arm a *clean exit*. Notes ringing across the loop point get deferred noteOffs so tails don't get chopped.
  - **transpose** — `− 0 +` (±12 semitones). Skips drum channels.
- **Deck head** (top-right):
  - **A | B** channel toggle — reassigns this deck to the other channel without restarting. Default: Deck 1 → A, Deck 2 → B.
  - **auto ↻** — when the track reaches its natural end, load the next track in current browser order and drop at next master bar. Inherits routing/mute/transpose.
  - **unmute all** — clears this deck's output-mute set in one tap.

### Settings (⚙ in header)
- **Deck skin overlay** on/off (persists in localStorage)
- **Hardware MIDI output port** selector (persists; auto-restores on device replug)
- **CUE (headphones)** — stubbed; future: route a cued deck through the in-browser GM synth to a chosen audio-interface output pair, while the other deck keeps playing to the hardware.

### Track library (browser)
- 810 tracks across 14 games. Sortable columns:
  - **title**, **game**, **release**, **bpm**, **key**, **meter**, **tags**, **len**
- **Release column** — per-track game-release label (e.g. "A Link to the Past", "Mega Man 2", "Symphony of the Night"). Computed two ways: subdirectories under a game dir (`docs/midi-files/<game>/<release>/`) take precedence, otherwise a per-game classifier in `tools/build-manifest.js` matches filename patterns. Multi-title games currently classified: **zelda** (5 releases), **final-fantasy** (FF6/FF7), **donkey-kong** (DKC1/2/3), **castlevania** (CV2/CV4/SotN), **mega-man** (1/2/3), **mario** (SMB/SMW/SM64), **metroid** (NES/Super), **sonic** (1/2/3). Single-title games (chrono-trigger, contra, doom, earthbound, golden-axe, street-fighter) show '—' in the release column.
- **Tags column** — automatic per-track role classification: `drums`, `bass`, `chords`, `lead`. Computed from per-channel polyphony + average pitch + drum-channel detection.
- Per-track metadata generated by `tools/build-manifest.js`:
  - **Perceived BPM** — trusts the file's metadata tempo when it falls in 50–220 BPM; falls back to an inter-onset-interval heuristic only for files at extreme tempos that almost certainly lie. Overridable per-track in `tools/tempo-overrides.json`.
  - **Beat-1 tick** — raw-tick offset where the music's audible downbeat sits. Overridable per-track. Drops and master-anchoring use this so a count-in / pickup / silent pad doesn't put the deck off-grid.
  - **Key** via Krumhansl-Kessler pitch-class profile correlation.
  - **Meter** from MIDI time-signature meta events; tracks with shifting meters are flagged.
  - **Channels used**, **note count**, **duration**, **L/R stereo-duplicate channel dropping**.

### Standalone previewer (`docs/previewer.html`)
Per-track editor with **two-anchor warp**: pin two notes on the roll, label each as a (bar, beat) position, hit *Apply* — the previewer back-solves `perceived_bpm` and `beat_one_tick` so both anchors land on grid. Plus a GM metronome and `Export → tempo-overrides.json` button that emits a paste-ready snippet for the main library override file.

## Hardware setup

| MIDI channel (1-indexed) | Synth | Role |
|--------------|-------|------|
| 1 | Juno 106 | Pads / chords |
| 2 | SH-01A | Leads / arps |
| 3 | Bass Station 2 | Bass |
| 4 | Roland Keytar | Melody |
| 10 | TR-08 | Drums |

Signal flow:

```
iPad (Chrome) → USB MIDI interface → 5 channels → synth rig
```

Drums get remapped from GM kit note numbers to the TR-08 layout automatically.

## Quick start

```sh
npm run manifest         # rebuild docs/tracks.json from docs/midi-files/
npm run serve-local      # plain HTTP at localhost:8080
npm run serve            # HTTPS at localhost:8080 (needs cert.pem/key.pem; iPad needs HTTPS for Web MIDI)
```

Open `http://localhost:8080`. Toggle **preview** in the header for in-browser GM playback; otherwise it routes to your connected MIDI interface.

## Project structure

```
midi-dj/
├── docs/                       # GitHub Pages root
│   ├── index.html              # main DJ app
│   ├── app.js                  # playback, UI, piano roll, master clock — everything
│   ├── midi-worker.js          # MIDI parsing off-thread
│   ├── style.css
│   ├── previewer.html          # standalone per-track warp/preview editor
│   ├── previewer.js
│   ├── previewer.css
│   ├── tracks.json             # generated manifest (committed for Pages)
│   ├── img/games/              # deck skins — drop <game>.{webp,jpg,png}
│   └── midi-files/             # the library, organised by game
├── tools/
│   ├── build-manifest.js       # walks docs/midi-files/, writes docs/tracks.json
│   ├── tempo-overrides.json    # per-track BPM / beat_one_tick / meter overrides
│   ├── scan-library.js         # library-wide channel/patch audit (report files)
│   └── analyze.js              # CLI: inspect one MIDI file's channels/programs
├── package.json
├── README.md
└── LICENSE
```

## MIDI library

| Game | Tracks |
|------|--------|
| Final Fantasy (6 & 7) | 177 |
| Chrono Trigger | 95 |
| Donkey Kong Country (1 & 2) | 94 |
| Legend of Zelda (NES, ALTTP, Link's Awakening, Majora, Wind Waker) | 88 |
| Castlevania (CV4, SotN, CV2) | 72 |
| Street Fighter II | 55 |
| Mega Man (1, 2, 3) | 54 |
| Super Mario (SMB, SMW, SM64) | 53 |
| Metroid (NES & Super) | 43 |
| Earthbound | 31 |
| Golden Axe | 15 |
| Sonic the Hedgehog | 14 |
| Contra | 11 |
| Doom | 8 |

Drop new `.mid`/`.midi` files into `docs/midi-files/<game>/`, then `npm run manifest` to rebuild the index.

## Deck skins

`docs/img/games/<game>.{webp,jpg,png}` — the loader probes those extensions in order. Filename matches the directory name under `docs/midi-files/`. Drop a file in, run `npm run manifest`, and the deck shows it as a low-opacity (14%) background when a track from that game loads. The manifest's `generated` timestamp is used as a cache-buster, so the browser fetches fresh images on the next soft reload after a manifest regen.

## TR-08 drum note map

GM kit notes are remapped to the TR-08 layout when routed to channel 10.

| Instrument | GM note | TR-08 note |
|-----------|---------|-----------|
| Bass Drum | C2 (36) | C2 (36) |
| Rim Shot | C#2 (37) | C#2 (37) |
| Snare | D2 (38) | D2 (38) |
| Hand Clap | D#2 (39) | D#2 (39) |
| Closed HH | F#2 (42) | F#2 (42) |
| Open HH | A#2 (46) | A#2 (46) |
| Cymbal | C#3 (49) | C#3 (49) |
| Toms (hi/mid/lo) | D3 / B2 / G2 | D3 / B2 / G2 |
| Cowbell | G#2 (56) | G#2 (56) |
| Congas (hi/lo) | D3 (62) / C3 (64) | D3 / C3 |

## Converting SPC → MIDI (VGMTrans)

For SNES games not yet in the library (e.g. A Link to the Past):

1. Get `.spc` files (rip from ROM with SPC700 Player, or download from zophar.net/snesmusic)
2. Open [VGMTrans](https://github.com/vgmtrans/vgmtrans)
3. Drag the `.spc` in → it auto-detects the N-SPC sequence
4. Right-click the collection → Convert → MIDI
5. Drop the `.mid` into `docs/midi-files/<game>/`
6. Run `npm run manifest`
7. Optional: `node tools/analyze.js <file.mid>` to inspect channel layout

SPC2MIDI is a planned replacement workflow for some games whose current MIDIs are loosely-sequenced fan transcriptions (Street Fighter in particular).

## Architecture notes

- **Decks vs channels.** A deck (1 or 2) is a playback engine — what you load tracks into. A channel (A or B) is a mix-bus assignment — what the master mix-switch (A / A+B / B) routes between. They're decoupled: a per-deck A|B toggle reassigns without restarting.
- **Playback engine** is a `setTimeout`-driven event scheduler keyed off MIDI ticks. Per-deck `pitch` warps real-time scheduling so a deck plays at master BPM regardless of its file's native tempo. Initial `currentBPM` is seeded from `bpm_initial` so lying-tempo files don't briefly play at the wrong rate before the first tempo event fires.
- **Beat-1 anchoring.** Drops and `anchorMasterToDeck` align to `beat_one_tick` (from the manifest, default 0) rather than raw tick 0, so tracks with count-ins / pickups / silent pads land on grid.
- **Note tails across loop wraps** — at load time, every `noteOn` is paired with its matching `noteOff` so each carries its natural `endTick`. When a loop wraps, in-flight notes whose end is past `loop.out` get deferred `noteOff` timers rather than being cut, and those timers are cancelled if a fresh note retriggers the same pitch+output.
- **Tempo detection** — the manifest trusts the file's metadata tempo when it falls in 50–220 BPM (the common honest range). For files at extreme tempos (Doom levels 2 & 9 lying at 60, Castlevania at 240+), an IOI-histogram heuristic kicks in. Per-track overrides in `tools/tempo-overrides.json` are authoritative on top of either.
- **Gated routing-pill indicators** — each deck maintains a per-output active-note counter so pills light *while* notes are sounding (not just for 90 ms after each noteOn). Loop wraps, mute toggles, transpose, and silence-deck all keep the counter accurate.
- **Custom widgets** — sliders (horizontal + vertical), dropdowns, the loop-length spinner, scrollbars, and the master toggle are all built from scratch so the look is consistent and touch-friendly; no native form chrome anywhere.

## Status

Pre-show development. Run locally; iPad over WiFi works fine via HTTPS or via `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for HTTP.

## Notes

- The MIDI files under `docs/midi-files/` are community transcriptions of video-game soundtracks, already publicly available across the usual archives (vgmusic.com, midishrine.com, zophar.net) and SPC-converted via VGMTrans. They're bundled here for convenience; original compositions remain the work of their respective composers and publishers. No affiliation is implied.
- Deck skin images under `docs/img/games/` are box art / cover scans sourced from Wikipedia infoboxes and community archives (e.g. thecoverproject.net). Non-free fair-use for a personal performance tool; not licensed for redistribution.
- This is a personal performance tool — non-commercial, hobbyist.
- The web app and tooling are MIT-licensed (see `LICENSE`).
