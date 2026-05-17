# CLAUDE.md — VGM MIDI DJ

Project context for future Claude sessions working on this codebase. The README is for humans/users; this file captures conventions, architecture, and gotchas you'd otherwise re-derive.

## Project intent

A two-deck DJ webapp for performing classic video-game MIDI through hardware synths on stage (iPad over WiFi → USB MIDI interface → 5 hardware synths). Built around a **single master tempo grid**: both decks warp to one BPM. Preview mode plays through an in-browser GM synth so it can be rehearsed anywhere.

The target user (Nathan) is technical, has clear DJ-controller intuitions, and prefers minimal/slick UI over feature-density. He simulates iPad in Chrome devtools during development; eventually deploys to a real iPad over WiFi.

## Dev workflow

```sh
npm run serve-local       # http://localhost:8080 (plain HTTP, fine for dev)
npm run serve             # HTTPS (needs cert.pem/key.pem; iPad needs HTTPS for Web MIDI)
npm run manifest          # rebuild docs/tracks.json after adding tracks to docs/midi-files/
```

The dev server is typically already running. Don't restart it unless something demands it — `http-server` serves static files fresh on each request.

## Architecture

Everything is in `docs/app.js` — one file by design, not modularised. Logical sections (top→bottom, search for the comment headers):

1. **Hardware outputs / GM preview patches / drum map** — constants at the top
2. **Custom widgets** — `mountSlider`, `mountDropdown`, `mountToggle` (no native form chrome exists in this app; always reuse these)
3. **Deck state** (`makeDeckState`, `decks.a`, `decks.b`)
4. **Channel colour palette** (`CHANNEL_COLORS`)
5. **Master transport** — `master` object, `setMasterBpm`, `syncDeckToMaster`, `masterTapTempo`, beat-dot clock
6. **MIDI plumbing** — `initMIDI`, `sendRaw`, `flashRoutingPill`
7. **Mix state** — A/A+B/B switch + CUE solo
8. **Note dispatch** — `dispatchEvent` is the single chokepoint for all note routing, transpose, mute, drum remap. Touch this carefully.
9. **`silenceDeck` / `silenceAll`** — kills active notes + sends all-notes-off CC
10. **MIDI file parsing** — `parseMidiFile` (also pairs `noteOn` with its `noteOff` so each `noteOn` carries `endTick`)
11. **Routing UI** — output pills with tap-to-mute
12. **Playback** — `playDeck` (also acts as seek when called on a playing deck), `stopDeck`, `seekDeck`, `step()`
13. **Quantised drop** — `dropDeck` aligns to `msUntilNextDownbeat()` of the master
14. **Loop wrap** — `handleLoopWrap` defers tail noteOffs
15. **Piano roll** — `compileNotes`, `renderRollOffscreen` (notes pre-rendered to an offscreen canvas), `paintRoll` (blit + playhead + loop overlay), `setRollZoom`, `setRollOffset`, `bindPianoRoll`
16. **Loop controls** — `setBeatLoop`, `updateLoopUI`
17. **BPM / transpose displays**
18. **Browser** — `renderBrowser`, `initBrowser`, sortable columns

## Conventions

- **Custom widgets only.** Never introduce a native `<select>`, `<input type=range>`, or `<input type=checkbox>` into the UI. Use `mountSlider`/`mountDropdown`/`mountToggle`. Scrollbars are styled globally; don't override.
- **UK/AUS English** in user-facing text and comments. *Exception:* CSS keywords are American (`text-align: center`).
- **Minimal comments.** Don't narrate what the code does. Only add a comment when the *why* is non-obvious (a hidden invariant, a workaround, surprising ordering). Most existing comments earn their place — match the style.
- **Single source of truth for tempo:** `master.bpm`. Per-deck `pitch` is *derived* (`master.bpm / track.perceived_bpm`), never user-controlled. There are no per-deck pitch faders.
- **`perceived_ticks_per_beat`** (from the manifest) is the source of truth for loop/beat math, NOT the file's `ticksPerBeat`. Many MIDI files lie about their tempo (Doom, Commander Keen especially). Use `getDeckTicksPerBeat(deck)` instead of `deck.midi.ticksPerBeat`.
- **Avoid backwards-compatibility shims.** This is a single-deployment app; just change the code.

## Gotchas

- **`deck.activeNotes` is a `Map<string, endTick>`**, not a `Set`. Iterate with `for (const [key, endTick] of deck.activeNotes)` or `for (const [key] of [...deck.activeNotes])` (the latter clones so you can mutate while iterating).
- **`playDeck(deckId, startTick)` doubles as seek.** If the deck is already playing, it silences and resumes from `startTick`. The same function handles both initial play and loop-wrap re-entry. Don't add a separate seek path.
- **Loop wrap doesn't call `silenceDeck`.** It calls `handleLoopWrap`, which schedules deferred `noteOff`s for notes whose natural `endTick` is past `loop.out`. This is what stops notes being chopped at the loop boundary. If you ever add code that runs on loop wrap, don't reintroduce a blanket silence.
- **Transpose changes silence active pitched notes** (`setTranspose`). This prevents hung notes when `noteOff` would compute a different note than the `noteOn` that's sounding. Don't remove that silencing.
- **`docs/midi-files/`** holds the MIDI library directly. (Was a symlink to `../midi-files/` before the GitHub Pages restructure; now everything lives under `docs/` so Pages can serve it.)
- **`docs/tracks.json`** is generated by `npm run manifest`. It IS committed (Pages needs it). Always regenerate before pushing if you've added or removed MIDI files.
- **DROP aligns to master clock**, not to the playing deck's bars. This is intentional — gives the user a stable reference grid independent of any deck's quirks.
- **Tempo detection is heuristic.** `detectPerceivedBpm` in `tools/build-manifest.js` uses an IOI histogram + octave-folding into 80–160 BPM. It's better than the file's metadata but not infallible. If a track sounds wrong, the user may need to override BPM manually (no UI for that yet).

## What works / what's hand-wavy

- **Solid:** library browser, playback, loops, mute pills, transpose, master clock, DROP quantisation, note-tail preservation on loop wrap.
- **Works but rough:** mid-playback master BPM changes have a one-event lag (no reschedule). Acceptable but not perfect.
- **Approximate:** tempo detection. Most tracks land sensibly; some still surprise.
- **Not yet:** harmonic-mixing badges in the browser, real headphone routing for CUE (currently CUE just solos that deck globally), per-deck "snap master to me" button.
- **Won't have:** crossfader. Replaced by an A/A+B/B mix switch since MIDI cuts don't crossfade musically.

## Testing reality

- Audio/MIDI can't be verified from CLI. After code changes, *tell the user what to verify in the browser* — don't claim something "works" or "is fixed" until they confirm.
- Syntax-check with `node --check docs/app.js` before handing off.
- For changes that affect the manifest schema, regenerate with `npm run manifest` and inspect a few tracks via `curl localhost:8080/tracks.json | python3 -c "..."`.

## Commits

- Don't commit unless the user asks. The repo was initialised in this session; the first commit is `473aa6c`.
- `docs/midi-files/` is committed (~830 files, mostly small). Required for GitHub Pages to serve the library.
- Deployed via GitHub Pages from the `docs/` folder on `main`. Pushing `main` is the deploy.
