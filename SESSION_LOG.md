# SESSION_LOG.md — VGM MIDI DJ

**Read this first.** Captures the 2026-05-23 session state after an earlier Claude was cut off by an API error mid-flight. CLAUDE.md still describes long-lived conventions; this log is the live "where are we right now" handoff.

---

## TL;DR for the next Claude

- Web app under `docs/` has gained a full **LCXL3 Mk3 integration** (driver patched, new integration layer, OLED renderer, virtual surface mounted in a drawer). Empirically tested in Chrome against real LCXL3 hardware.
- iOS hybrid app (`../midi-dj-ios/`) is the long-term host. Signal flow: **LCXL3 → VGM DJ (iOS app) → AUM**. The SwiftUI-rewrite plan from earlier is **dead**.
- **Immediate next task:** extend `midi-dj-ios/VGMMidiDJ/UI/WebMIDIPolyfill.js` + `MIDIService.swift` so the polyfill exposes real `MIDIInput`s, real per-device `MIDIOutput`s, and SysEx. Currently output-only with a single hardcoded `VGM DJ` port.
- Two planning docs at repo root (`plan-report.md`, `research-report.md`) are **SUPERSEDED**. Don't act on them. Don't modify them in this session.

---

## Architecture decisions locked in 2026-05-23

### iOS app architecture
- **Hybrid WKWebView stays.** `midi-dj-ios/VGMMidiDJ/UI/WebAppView.swift` + `WebMIDIPolyfill.js` is the path forward. The from-scratch SwiftUI rewrite outlined in `plan-report.md` is abandoned.
- **Signal flow:** LCXL3 → VGM DJ (iOS app, source of truth) → `VGM DJ` virtual CoreMIDI source → AUM. The LCXL3 never talks to AUM directly; AUM's mappings consume what the app rebroadcasts.
- **Backgrounding workaround:** iPadOS Split View with AUM in one pane + VGM DJ in the other keeps the WKWebView JS thread alive (WKWebView pauses JS when the host app is fully backgrounded).

### 8-track column model (1:1 with LCXL3 columns)
| Col | Role  | Device       | MIDI ch |
|-----|-------|--------------|---------|
| 1   | Drums | TR-08        | 9       |
| 2   | Bass  | Bass Stn 2   | 2       |
| 3   | Lead  | SH-01A       | 1       |
| 4   | Poly 1| Juno 106     | 0       |
| 5   | Poly 2| Keytar       | 3       |
| 6   | FX 1  | in-app FX    | —       |
| 7   | FX 2  | in-app FX    | —       |
| 8   | FX 3  | in-app FX    | —       |

FX columns 6–8 are stubs; no in-app effects layer exists yet.

### Per-track LCXL3 controls
- **Knob row A:** LP/HP filter (HW tracks) / FX param 1 (FX tracks)
- **Knob row B:** Pan / FX param 2
- **Knob row C:** Bipolar REV/DLY dual-function send (CCW = REV, CW = DLY, centre detent = neither, only one of REV/DLY non-zero at a time) / FX param 3
- **Fader:** track volume
- **Solo + Mute strip buttons:** visual toggles only — AUM owns actual mute/solo
- All three encoder rows are **bipolar with centre-detent LED off**.

### Flip buttons (in app routing-pill row)
- **Lead↔Bass:** swap ch 1 ↔ ch 2.
- **Poly1↔Poly2:** swap ch 0 ↔ ch 3.
- Tracked independently per deck as `deck.leadBassFlipped` and `deck.polyFlipped`.

---

## Work done in `docs/` this session (uncommitted)

`git diff --stat HEAD` shows `docs/app.js` (+457/-60), `docs/index.html`, `docs/style.css`. Plus new untracked files: `docs/lcxl3/`, `docs/lcxl3-integration.js`, `docs/fonts/`, `docs/img/SVG/`, two test HTML files, two planning docs.

### `docs/lcxl3/virtual-lcxl3.js` (driver, patched)
- `_findPorts` now respects `port.state === 'connected'` — disconnect/replug triggers a fresh handshake.
- Handshake re-fires on any port-ID change (covers user-template → DAW-port hand-off).
- LED dedupe cache (`_lastLedSent`) **cleared on each fresh handshake** — identical-colour writes after a power cycle now reach the device.
- `_disableAutoDisplay()` runs after DAW-mode-enable.
- Explicit `B6 1E 02` **DAW-Control sub-mode select** sent after `F0 00 20 29 02 15 02 7F F7` DAW-mode-enable (PDF reveals two sub-modes; we want Control, not Mixer).
- `CONTROL_INDEX.SOLO_ARM` and `CONTROL_INDEX.MUTE_SELECT` corrected to `0x25-0x2C` and `0x2D-0x34` per official PDF — inherited baeng-raembl values were wrong.
- New `onConnect(cb)` callback for integration code.
- Verbose MIDI-in trace toggle via `setMidiInTrace(true)`.
- Looser button input parser — accepts CC or Note On from low channels (sub-modes vary).

### `docs/lcxl3-integration.js` (NEW, 486 lines)
- Mounts virtual surface inside `<details id="lcxl3-drawer">` at the bottom of `docs/index.html`.
- Reads app state via `window.vgmdj` namespace (see below).
- Renders the OLED idle view: dual-deck horizontal (left A, right B, 1-px vertical divider), header + scrolling track title + bare-digit 1–5 slot row per deck + position bar. Slot states: plain digit (loaded), digit+strike (muted), midline dot (unavailable). **No live MIDI-gate flicker.**
- Marquee-scroll helper for long titles (pixel-clipped to column window).
- Touch popups for every CC, including a single-fader REV/DLY for Row C HW tracks. Label flips (e.g. `DRUMS REV` ↔ `DRUMS DLY`) depending on side of centre; last-used side persists through centre detent.
- Encoder LEDs: all three rows bipolar with centre-off. Row C on HW tracks uses teal (REV) / orange (DLY); other rows + FX-column Row C use the column's track colour.
- Strip buttons (SOLO 37–44, MUTE 45–52): **visual toggles only** with local on/off state (`buttonToggle` Map). Bright when ON, dim when OFF. AUM owns actual mute/solo behaviour.
- PAGE_UP / PAGE_DOWN cycle the OLED's focused deck.
- `window.lcxl3Debug` exposes `setRaw`, `sweep`, `list`, `testButtons`, `trace` helpers.

### `docs/index.html`
- Added `<details id="lcxl3-drawer">` containing `<div id="lcxl3-mount">` and `<script type="module" src="lcxl3-integration.js">`.

### `docs/style.css`
- Minor drawer styling appended at the end.

### `docs/app.js`
- `SYNTHS` renamed to role-first labels: **Drums / Bass / Lead / Poly 1 / Poly 2**. Parens like `(Juno)` / `(Keytar)` dropped.
- New `OUTPUT_ORDER = [9, 2, 1, 0, 3]` controls render order so pills line up Drums → Bass → Lead → Poly 1 → Poly 2.
- Two flip pills in routing row via parameterised `flipOutputs(deckId, pair)` with `pair ∈ {'leadBass', 'poly'}`.
- **`window.vgmdj`** exposed at end of `init()`:
  ```js
  window.vgmdj = { decks, master, SYNTHS, OUTPUT_ORDER,
                   setMasterBpm, toggleOutputMute, flipOutputs, silenceAll }
  ```

---

## What is NOT done yet (priority next)

### iOS-side polyfill extension — IMMEDIATE NEXT TASK
`midi-dj-ios/VGMMidiDJ/UI/WebMIDIPolyfill.js` is currently output-only and hardcodes `sysexEnabled: false`. Needs:
- `sysexEnabled: true` once iOS grants it.
- Per-device `MIDIInput` AND `MIDIOutput` entries populated from native (not just one hardcoded `VGM DJ` output).
- Working `onmidimessage` callbacks driven by native MIDI input forwarding via `evaluateJavaScript`.
- `output.send()` routing per-device based on output ID.

### `MIDIService.swift` extension
- Needs an input port + connect block.
- Per-source forwarding back to JS.

### iOS app is NOT git-safe
`.git` initialised but **zero commits**. Every file untracked. Do an initial baseline commit (or directory snapshot) **before** touching anything.

---

## Verified Novation PDF facts
Source: `~/Downloads/Launch Control XL 3 programmer's DAW mode...pdf`

- **DAW-mode-enable SysEx:** `F0 00 20 29 02 15 02 7F F7` (short form: note `9F 0C 7F`).
- **DAW Mode sub-modes:** Mixer (`01h`) / Control (`02h`) on `B6 1Eh`. Use Control.
- **LED control indices == CC numbers:**
  - SOLO/Arm: `0x25-0x2C` (CCs 37–44)
  - Mute/Select: `0x2D-0x34` (CCs 45–52)
  - Encoders Row A: `0x0D-0x14` (CCs 13–20)
  - Encoders Row B: `0x15-0x1C` (CCs 21–28)
  - Encoders Row C: `0x1D-0x24` (CCs 29–36)
  - Faders: `0x05-0x0C` (CCs 5–12)
- **Relative encoder enable:** `B6 45 7F` / `B6 48 7F` / `B6 49 7F` (channel 7, CCs 69/72/73).
- **RGB LED SysEx:** `F0 00 20 29 02 15 01 53 <ctrl idx> <r 0-7F> <g 0-7F> <b 0-7F> F7`.
- **Channels:** encoders + faders on ch 16; buttons on ch 1; Shift on ch 7.
- **Bitmap target:** PDF says `0x20` (stationary) or `0x21` (temporary). Empirically-tested driver uses **`0x35`** successfully — known-working divergence, leave it alone.

---

## Deferred / parked

- **Piano-roll follow-mode jerkiness** at high zoom — user wants to test on iPad first before fixing.
- **FX tracks 6–8** — no in-app effects layer.
- **`plan-report.md` and `research-report.md`** at repo root reflect the obsolete native-iOS-rewrite plan. Should be deleted or marked SUPERSEDED at the top. **Don't modify in this session** — flagged for later.

---

## Memory references (in `~/.claude/projects/-Users-naenae-bloop-baeng-and-raembl-midi-dj/memory/`)

- `project_lcxl3_track_model.md` — the 8-track column model above.
- `project_ios_polyfill_extension.md` — iOS architecture decision (hybrid stays, polyfill expansion next).
- `reference_lcxl3_driver_baeng_raembl.md` — driver origin + verified protocol facts.
- `project_native_ios_port.md` — **SUPERSEDED**; flagged.
- Older entries (mono outputs, doctored MIDI workflow, combos file, etc.) are still current — leave alone.

---

## Recent committed history (for sanity)

Last commit on `main`: `4fc681a README: link to the live web app at the top`. Everything above (LCXL3 integration, flip pills, role-first SYNTHS labels, `window.vgmdj`) is **uncommitted** in working tree.

Branch: `main`. Status: M `docs/app.js`, M `docs/index.html`, M `docs/style.css`, plus untracked `docs/lcxl3/`, `docs/lcxl3-integration.js`, `docs/fonts/`, `docs/img/SVG/`, `docs/lcxl3-sim.html`, `docs/midi-timestamp-test.html`, `docs/title-preview.html`, `plan-report.md`, `research-report.md`.
