# SESSION_LOG.md — VGM MIDI DJ

**Read this first.** Captures the 2026-05-23 session state after an earlier Claude was cut off by an API error mid-flight. CLAUDE.md still describes long-lived conventions; this log is the live "where are we right now" handoff.

---

## TL;DR for the next Claude

- Web app under `docs/` has a full **LCXL3 Mk3 integration**, committed at `7a7b24e`. Empirically tested in Chrome against real LCXL3 hardware.
- iOS hybrid app (`../midi-dj-ios/`) is the long-term host. Signal flow: **LCXL3 → VGM DJ (iOS app) → AUM**. The SwiftUI-rewrite plan from earlier is **dead**.
- iOS app has a **baseline commit** at `81a1356` (was previously zero commits). Plus a full directory backup at `/Users/naenae/bloop/baeng-and-raembl/midi-dj-ios.backup/` — safe to roll back to.
- **Immediate next task:** start the iOS-side polyfill extension. See **"NEXT TASK FOR INCOMING AGENT"** below for a step-by-step.
- Two planning docs at repo root (`plan-report.md`, `research-report.md`) are **SUPERSEDED**. Don't act on them. Don't modify them in this session.

---

## NEXT TASK FOR INCOMING AGENT — read this carefully

**Goal:** make the LCXL3 driver work inside the iOS WKWebView shell, the same way it works in desktop Chrome today.

The JS code in `docs/lcxl3/virtual-lcxl3.js` calls `navigator.requestMIDIAccess({ sysex: true })` and then looks up the LCXL3 in `access.inputs`/`access.outputs` by port name. On desktop Chrome this just works; inside the iOS shell it currently fails because the polyfill is output-only with a single hardcoded port and `sysexEnabled: false`.

### Files you need to edit
1. **`midi-dj-ios/VGMMidiDJ/UI/WebMIDIPolyfill.js`** (currently ~280 lines)
   - Set `sysexEnabled: true` on the `ACCESS` object.
   - Add factories `makeInput(id, name, manufacturer)` and `makeOutput(id, name, manufacturer)` that produce WebMIDI-shaped port objects.
   - `output.send(data, timestamp)` must include the output's `id` in the bridge `postMessage` payload (currently it doesn't — there's only one output).
   - Expose `window.__vgmMidiInput(inputId, bytes, timestamp)` that looks up the input by id and dispatches `onmidimessage({ data: Uint8Array(bytes), receivedTime })`.
   - Expose `window.__vgmMidiPortsUpdate({ inputs: [...], outputs: [...] })` to refresh the port topology — fire `onstatechange` events on connect/disconnect.
   - Keep the existing `native-vgm-dj` output entry for backwards compatibility (that's what carries note traffic to AUM).

2. **`midi-dj-ios/VGMMidiDJ/MIDI/MIDIService.swift`** (currently ~176 lines, output-only)
   - Add a `MIDIInputPortCreateWithBlock` input port.
   - On each refresh, connect to every CoreMIDI source via `MIDIPortConnectSource`. The read block forwards bytes back to the WebView (you'll need a delegate or closure handle to the `WKWebView`).
   - Extend `send(...)` so it can target a specific destination by UID (passed from JS as `outputId`) rather than always publishing to the virtual source.
   - Add a sources list (`@Published var sources: [Source]`) symmetric to `destinations`.
   - Push the combined source/destination list into JS via `webView.evaluateJavaScript("window.__vgmMidiPortsUpdate({...})")` on every refresh.

3. **`midi-dj-ios/VGMMidiDJ/UI/WebAppView.swift`** (currently ~230 lines)
   - In the `Coordinator.handleSend(...)` switch, route by `outputId`: if `'native-vgm-dj'` (or absent), publish to virtual source as today; otherwise look up the destination by ID and send there.
   - On `didFinish`, push an initial port-topology refresh to JS.
   - Inject MIDI-input bytes from the Swift side back through `evaluateJavaScript` (escape carefully — bytes are an array of ints).

### Bridge protocol (recommended)
JS → Native via `webkit.messageHandlers.vgmMidi.postMessage(...)`:
```js
{ kind: 'send', outputId: 'lcxl3-1-daw-in', bytes: [...], timestamp, deltaMs }
{ kind: 'send', outputId: 'native-vgm-dj', bytes: [...], ... }   // existing path
{ kind: 'panic' }                                                  // existing
{ kind: 'midiAccessReady', sysex: true }                          // existing diagnostic
```
Native → JS via `evaluateJavaScript`:
```js
window.__vgmMidiInput('lcxl3-1-daw-out', [0xB0, 0x25, 0x7F], performance.now());
window.__vgmMidiPortsUpdate({
  inputs:  [{ id: 'lcxl3-1-daw-out', name: 'LCXL3 1 DAW Out', manufacturer: 'Focusrite - Novation' }],
  outputs: [{ id: 'native-vgm-dj',  name: 'VGM DJ',           manufacturer: 'VGM DJ' },
            { id: 'lcxl3-1-daw-in', name: 'LCXL3 1 DAW In',   manufacturer: 'Focusrite - Novation' }]
});
```

For port IDs, use `MIDIUniqueID` from CoreMIDI stringified (e.g. `"lcxl3-1-daw-out"`). They must be stable so the driver can find the LCXL3 by name across topology refreshes.

### Verification path
1. Build the iOS app on a connected iPad.
2. Plug an LCXL3 into the iPad (USB-C → USB-A adapter if needed).
3. App loads → WKWebView fires `navigator.requestMIDIAccess` → polyfill returns ACCESS with the LCXL3's `MIDIInput`/`MIDIOutput` populated.
4. The LCXL3 driver's `_findPorts` matches the device → sends DAW-mode-enable SysEx → device's LEDs light up per `lcxl3-integration.js`'s palette.
5. Press a strip button on the LCXL3 → `onmidimessage` fires in JS → integration's `onButtonDown` callback → button LED toggles + OLED touch popup appears.
6. Open AUM in Split View. Note traffic from the deck should still reach AUM via the `VGM DJ` virtual source (existing path, must not regress).

### Safety net
- **Backup** of the iOS app pre-changes: `/Users/naenae/bloop/baeng-and-raembl/midi-dj-ios.backup/`.
- **Baseline commit** of iOS app: `81a1356`. `git restore --source=81a1356 :/` puts you back to baseline.
- **Web-app baseline**: `7a7b24e` is the LCXL3-integration commit. `git restore --source=4fc681a :/` puts you to pre-LCXL3 state.

### What you DON'T need to touch
- `docs/lcxl3/virtual-lcxl3.js` — empirically tested. Don't second-guess the SysEx commands.
- `docs/lcxl3-integration.js` — works in Chrome; will work in WebView once the polyfill is fixed.
- `docs/app.js` deck logic — the LCXL3 doesn't affect deck state, AUM owns mute/solo via its own mappings.

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

## Work done in `docs/` this session (committed as `7a7b24e`)

Committed at the end of the session. Files in the commit: `docs/app.js`, `docs/index.html`, `docs/style.css`, all of new `docs/lcxl3/`, `docs/lcxl3-integration.js`, `docs/lcxl3-sim.html`, plus this log. Untracked files left alone (font assets, image SVGs, test HTML, the two SUPERSEDED planning docs).

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

The full step-by-step is in **"NEXT TASK FOR INCOMING AGENT"** at the top of this doc. Summary:
- Polyfill needs bidirectional MIDI + sysex + per-device port routing.
- `MIDIService.swift` needs an input port + per-source forwarding to JS.
- `WebAppView.swift` needs `outputId`-aware send routing + initial topology push.

iOS app safety: ✅ baseline commit `81a1356` in `midi-dj-ios/.git` + full directory backup at `/Users/naenae/bloop/baeng-and-raembl/midi-dj-ios.backup/`.

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

## Committed history at end of session

**Web app** (`/Users/naenae/bloop/baeng-and-raembl/midi-dj/`):
- `7a7b24e feat: LCXL3 hardware integration in web app` ← this session's work
- `4fc681a README: link to the live web app at the top`
- `059590a Flip lives between SH-01A and Bass Stn 2 pills…` (the OLD flip — superseded by dual flip in 7a7b24e)
- `9fd6c36 Flip button + push loop-spinner to right edge of deck-controls`
- `a878648 Deck UX: spaced controls, stable output pills, rubato-dim library`

**iOS app** (`/Users/naenae/bloop/baeng-and-raembl/midi-dj-ios/`):
- `81a1356 chore: baseline before LCXL3 polyfill work` ← only commit. Whole project state captured.

**Working-tree leftovers** in the web-app repo (pre-existing, **not part of this session**):
- Untracked: `docs/fonts/`, `docs/img/SVG/`, `docs/img/donkey-kong-logo.svg`, `docs/midi-timestamp-test.html`, `docs/title-preview.html`, `plan-report.md`, `research-report.md`.
- These predate this session. Ignore unless the user asks otherwise.

**Backups:**
- `/Users/naenae/bloop/baeng-and-raembl/midi-dj-ios.backup/` — pre-baseline snapshot of the iOS app.
- No web-app backup needed (everything in git).

---

## 2026-05-23 (later in the day) — iOS polyfill extension landed

Polyfill work from the NEXT-TASK spec above is done and verified on hardware (iPad Air 13-inch M2 + LCXL3 connected). User confirmed LCXL3 → VGM DJ surface works end-to-end inside the WebView shell.

### What was changed

**`midi-dj-ios/VGMMidiDJ/UI/WebMIDIPolyfill.js`** — full bidirectional polyfill:
- `ACCESS.sysexEnabled = true` (was `false`; LCXL3 driver requires SysEx for LED + OLED writes).
- `makeInput(id, name, manufacturer)` and `makeOutput(id, name, manufacturer)` factories producing WebMIDI-shaped port objects with `state`, `connection`, `open/close`, `addEventListener`, and (for inputs) `onmidimessage` + `_deliverMessage`.
- `output.send(data, ts)` now tags the bridge payload with `outputId: this.id` so native can route per-destination.
- `window.__vgmMidiInput(inputId, bytes, timeStamp)` looks up the input by id and dispatches via the saved `_deliverMessage`. Bytes wrapped to `Uint8Array`.
- `window.__vgmMidiPortsUpdate({inputs, outputs})` diffs against current ACCESS maps, mutates port `state`, and fires `MIDIConnectionEvent`-shaped objects on both `ACCESS.onstatechange` and each affected port's `onstatechange`. The `native-vgm-dj` entry is implicitly preserved even if native omits it.

**`midi-dj-ios/VGMMidiDJ/MIDI/MIDIService.swift`** — added the receive side + per-UID routing:
- `Source` struct (id/name/manufacturer/endpoint), `@Published sources: [Source]`, plus `manufacturer` field added to `Destination`.
- `inputPort: MIDIPortRef` created via `MIDIInputPortCreateWithProtocol(... ._1_0 ...)`. UMP read block unpacks MT=1 (system) and MT=2 (channel-voice) words into raw MIDI byte arrays; SysEx (MT=3) ignored — LCXL3 only sends short messages back.
- `refreshSources()` enumerates `MIDIGetSource(i)`, skips our own virtual source's UID (avoids feedback loop), connects new sources via `MIDIPortConnectSource` with a heap-allocated `UnsafeMutablePointer<MIDIUniqueID>` as refCon, disconnects ones that vanished and frees their refCons.
- `send(_:to:at:)` — new overload that targets a hardware destination by UID via `MIDISend` (instead of `MIDIReceived` on the virtual source).
- `onMIDIReceived: ((MIDIUniqueID, [UInt8]) -> Void)?` callback — fires on the CoreMIDI read thread.
- `onTopologyChanged: (() -> Void)?` callback — fires on main alongside the @Published refresh.
- `withPacketList` helper extracted; buffer sized for 1.2 KiB+ SysEx (LCXL3 OLED bitmap).

**`midi-dj-ios/VGMMidiDJ/UI/WebAppView.swift`** — wired the bridge to topology + input forwarding:
- `Coordinator.init` hooks `onMIDIReceived` (→ `deliverMIDIInputToJS`) and `onTopologyChanged` (→ `pushPortTopology`).
- `handleSend` reads `body["outputId"]`: `"native-vgm-dj"` or absent → virtual source; otherwise parsed as `MIDIUniqueID` and routed to that destination.
- `deliverMIDIInputToJS(uid:bytes:)` builds the JS literal on the read thread (cheap), hops to main, calls `evaluateJavaScript("window.__vgmMidiInput('<uid>',[b0,b1,b2])")`.
- `pushPortTopology()` builds inputs/outputs arrays from `midiService.sources`/`destinations`, prepends `native-vgm-dj`, serialises with `JSONSerialization`, calls `window.__vgmMidiPortsUpdate(...)`.
- `webView(_:didFinish:)` calls `pushPortTopology()` so the LCXL3 driver sees the device on first scan.

**`midi-dj-ios/CLAUDE.md`** — bridge-contract table updated to reflect the new `outputId` field on `send` and the new `__vgmMidiInput` / `__vgmMidiPortsUpdate` callbacks.

### Architectural decisions made during the work

- **MIDI 1.0 UMP only.** Created the input port with `MIDIInputPortCreateWithProtocol(... ._1_0 ...)` so the OS converts raw MIDI 1.0 bytes into 32-bit UMP words for us. The decoder handles MT=1 (system common/real-time) and MT=2 (channel voice). SysEx (MT=3) is dropped on the floor for now — the LCXL3 doesn't send SysEx host-bound, so it doesn't matter; if a future device does, the decoder will need a multi-word reassembler.
- **No rebroadcast from LCXL3 to the VGM DJ virtual source yet.** Per the explicit "we are NOT rebroadcasting yet" note in `prompt.md`. AUM can still see the LCXL3 directly if the user enables `LCXL3 1 DAW Out` in AUM's MIDI Connections. The architecture decision to eventually have VGM DJ be the source-of-truth still stands; this just defers the actual rebroadcast.
- **refCon strategy** — heap-allocated `UnsafeMutablePointer<MIDIUniqueID>`, one per connected source. Freed on disconnect or in `deinit`. Avoids the `Unmanaged<Box>` retain/release dance.
- **Skip our own virtual source when enumerating sources.** Otherwise `MIDIPortConnectSource` on our own `MIDISourceCreate`'d endpoint would feed every `MIDIReceived` call straight back into the input port — instant feedback loop, every note we send to AUM would echo back. The destinations skip is defensive (a virtual source isn't a destination anyway).

### Verified on hardware

- Build + install + launch on iPad Air 13" M2 (devicectl, device ID `00008112-001149082683A01E`).
- LCXL3 connects via DAW port, LEDs paint, encoders + Solo/Mute buttons + OLED touch popups all work inside VGM DJ.
- VGM DJ → AUM virtual-source path (note traffic) still works — no regression.
- AUM does NOT see LCXL3 CCs via the VGM DJ source (because we don't rebroadcast). User confirmed this; expected behaviour. To use AUM with LCXL3 today, enable `LCXL3 1 DAW Out` directly in AUM's MIDI Connections.

### Known gaps / next-next agent's playground

- **LCXL3 → VGM DJ virtual-source rebroadcast.** The "VGM DJ owns the LCXL3 and translates to mapping-friendly CCs that AUM consumes" architecture isn't built yet. Today it's two independent subscribers. When you build this, decide whether VGM DJ should *replace* the LCXL3 source for AUM (use the virtual source as the only thing AUM listens to, gain the freedom to remap CCs) or just *also* publish (riskier — feedback loops, dupes).
- **SysEx in (host-bound).** `dispatchEventList` returns nil for MT=3. Not a problem for LCXL3 but blocks any future device that responds with SysEx.
- **Source-list churn.** Every CoreMIDI notification triggers a full refresh + topology re-push. Fine for human-scale device add/remove, but if some device storms `msgSetupChanged`, the polyfill will get spammed.
- **Coordinator → JS marshalling.** `deliverMIDIInputToJS` always hops to main via `DispatchQueue.main.async` per byte-group. For high-rate input that's a lot of mainqueue ping-pong. If it becomes a perf problem, batch + coalesce on a serial queue before evaluating JS.

### Commits at end of this session

- `midi-dj-ios`: new commit on top of `81a1356` — the polyfill expansion described above, plus rsynced `Resources/WebApp/` reflecting `midi-dj` commit `7a7b24e`.
- `midi-dj`: this `SESSION_LOG.md` appendix only.
- Nothing pushed.
