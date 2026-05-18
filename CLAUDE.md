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

The web app lives in three files under `docs/`:

- **`docs/app.js`** — everything except parsing. One file by design.
- **`docs/midi-worker.js`** — MIDI parsing + piano-roll note compilation, off-thread.
- **`docs/style.css`** — dark minimal theme.

`docs/app.js` sections (top→bottom, comment-headered):

1. **Hardware outputs / GM preview patches / drum map** — constants
2. **Custom widgets** — `mountSlider`, `mountDropdown`, `mountToggle`. No native form chrome anywhere; always reuse these.
3. **Deck state** (`makeDeckState`, `decks.a`, `decks.b`)
4. **Channel colour palette** (`CHANNEL_COLORS`)
5. **Master transport** — `master` object, `setMasterBpm`, `syncDeckToMaster`, `masterTapTempo`, beat-dot clock
6. **MIDI plumbing** — `initMIDI`, `sendRaw`, `flashRoutingPill`
7. **Mix state** — A/A+B/B switch + CUE solo
8. **Note dispatch** — `dispatchEvent` is the single chokepoint for note routing, transpose, mute, drum remap. Touch carefully.
9. **`silenceDeck` / `silenceAll`** — kills active notes + sends all-notes-off CC
10. **Worker plumbing** — `getMidiWorker`, `parseInWorker`, `yieldToMain`. `loadTrackIntoDeck` awaits the worker; main thread stays free for the playing deck.
11. **Routing UI** — output pills with tap-to-mute
12. **Playback** — `playDeck` (doubles as in-place seek when already playing), `stopDeck`, `seekDeck` (bar-quantised when playing), `step()`
13. **Quantised drop** — `dropDeck` aligns to `msUntilNextDownbeat()` of the master
14. **Loop wrap** — `handleLoopWrap` defers tail noteOffs
15. **Piano roll** — `renderRollOffscreen` (notes from worker pre-rendered to an offscreen canvas), `paintRoll` (blit + playhead + loop + seek marker), `setRollZoom`, `setRollOffset`, `bindPianoRoll`, `deferRollRender` (idle-time scheduling)
16. **Loop controls** — `setBeatLoop`, `updateLoopUI`
17. **BPM / transpose displays**
18. **Browser** — `renderBrowser`, `renderGameChips`, `initBrowser`, sortable columns, multi-select game chips

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
- **Bar-quantised seek.** `seekDeck` only jumps immediately when the deck is stopped. While playing, it stores `seekPending` and schedules the jump at the next bar of that deck (using its perceived TPB × meter). A dashed marker on the roll shows the pending target. Hold **Shift** during a piano-roll drag for free (non-snap) scrubbing.
- **Loading a track is fully off-thread.** `loadTrackIntoDeck` sends the ArrayBuffer to the worker (transferable, zero-copy) and awaits parsed events + pre-compiled `rollData`. After applying state, the heavy canvas render is deferred via `requestIdleCallback` (250ms timeout fallback) so it can't compete with the other deck's setTimeout scheduler. Don't reintroduce synchronous parsing or eager rendering.
- **BPM range is 20–220.** Slider min/max, internal clamp in `setMasterBpm`, and tap-tempo all agree.

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

## Deployment

- Repo: **`MidiSlave/vgm-midi-dj`** on GitHub (public, MIT-licensed).
- Live site: **<https://midislave.github.io/vgm-midi-dj/>** — served by GitHub Pages from `docs/` on `main`.
- **Pushing `main` is the deploy.** Pages picks up commits automatically (~1–3 min build).
- Before pushing changes that touch `docs/midi-files/`: run `npm run manifest` and commit the regenerated `docs/tracks.json`.

## Commits

- Don't commit unless the user asks.
- Initial commit: `473aa6c`. Subsequent commits split the GitHub Pages restructure, off-thread parsing + idle render + multi-game chips + BPM range, and LICENSE/notes.
- The MIDI library (~830 files in `docs/midi-files/`) is committed because Pages needs to serve it. If pruning the library, just delete the files and re-run `npm run manifest`.
