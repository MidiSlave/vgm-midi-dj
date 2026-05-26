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

---

## Session 2026-05-26 → 2026-05-27 — Live timing, playlist sequencer mode, drum-flam chase, LCXL3 bypass

Long session. Started chasing a MIDI-flow interruption when queueing tracks into a deck, ended with a complete playlist/snapshot system and a kill switch for LCXL3 surface writes. ~30 commits on `midi-dj`, ~14 sync commits on `midi-dj-ios`. Final push to `origin/main` lifted GitHub Pages from `4fc681a` (5 days stale) to `e9188ad`.

### The MIDI-flow interruption that started it all

User reported that loading a track onto the available deck while the other was playing caused an audible interruption. Root cause: the scheduler dispatched each event at its actual fire moment with no timestamp (`output.send(bytes)` with no second arg), so any main-thread stall — DOM rebuild, fetch, worker round-trip — leaked straight into MIDI timing.

CoreMIDI on the native side already had everything needed for precise scheduled delivery via `MIDIPacketListAdd` with future host-time stamps; the polyfill's `output.send(bytes, timestamp)` was already wired to forward stamps end-to-end. We just weren't using it.

**Fix shipped (`8dd2003`).** Added `LOOKAHEAD_MS = 40` (native shell only; `0` on desktop). Scheduler now fires each event's `setTimeout` 40 ms early and passes `targetWallTime` straight through to `output.send(msg, ts)`. CoreMIDI fires at the exact stamp; main-thread jitter under 40 ms becomes inaudible. Mono-output pre-empt noteOff stamps at `targetWallTime − 1 ms` so CoreMIDI orders it strictly before the incoming noteOn.

### Loop-wrap flam + stuck-notes-on-CUT (lookahead regressions)

Lookahead introduced two surfacings:

1. **Loop-wrap flam (drums).** At wrap, the scheduler's `setTimeout` fired `LOOKAHEAD_MS` before the audible `loop.out` moment. `handleLoopWrap` dispatched `activeNotes`' noteOffs at "now" and called `playDeck` which set `startWallTime = performance.now()` — both `LOOKAHEAD_MS` too early. The new iteration's first events landed BEFORE the old iteration's tail-end events. Audible flam on transient/percussive material.

   Threaded the audible `loop.out` wallclock (the `targetWallTime` that triggered the wrap) through `step()` into `handleLoopWrap`. It now stamps immediate noteOffs at the audible boundary and passes the same stamp as the new iteration's `startWallTime`. Tail noteOffs handed straight to CoreMIDI with `audibleOut + tailMs` rather than a `setTimeout` from "now". `playDeck` grew an optional 3rd `startWallTime` arg. (`cf6cdae`)

2. **Stuck notes on CUT when the new track doesn't reuse the channel.** The scheduler hands up to `LOOKAHEAD_MS` of future noteOns to CoreMIDI ahead of "now". `silenceDeck` at CUT time fired its noteOff/CC123 at "now", landing BEFORE the queued noteOn → CoreMIDI played the noteOn after the kill → note hung forever (the incoming track never touched that channel to release it).

   New `panicStamp()` helper returns `now + LOOKAHEAD_MS + 1 ms`. Used wherever we kill notes synchronously: `silenceDeck`, `silenceAll`, `flipOutputs`, `toggleOutputMute`, the Transition output-mute sweep, and `setTranspose`. Kills now guaranteed to land after any in-flight scheduled noteOns in the lookahead window. (`cf6cdae`)

### Deck-↔-master and deck-↔-deck sync

User reported decks were drifting from each other and from the master clock. Diagnosed three independent timekeepers: the master clock (passive — `master.beatOneAt` + `master.bpm` derived per rAF), and each deck's own `setTimeout` chain with its own `cumulativeMs` accumulator. Drift sources: file-internal tempo events (deck's `currentBPM` walked off, master didn't follow), float error over time, loop-wrap startWallTime re-anchoring jitter.

User asked why not just do the heaviest fix (single shared scheduler refactor). Answered honestly: scheduler is the most blast-prone code in the project, and a cheaper hypothesis-testing fix would be diagnostic. Shipped 1+2 instead of 3:

- **Fix 1 — master clock slaved to anchor deck (`8dd2003`).** `startMasterClock` rAF tick now continuously re-anchors `master.beatOneAt` to the live position of the sole playing deck via `anchorMasterToDeck`. Beat-dots, `msUntilNextDownbeat`, `getMasterPosition` can't drift from what's audible — even with file tempo events shifting deck rate. Two-deck case left alone (user owns the relationship via DROP/CUT).
- **Fix 2 — `LOCK_DECK_RATE_TO_MASTER = true` (`8dd2003`).** Scheduler suppresses file-internal tempo events: `currentBPM` stays at `bpm_initial` forever, deck rate dictated entirely by `master.bpm * deck.pitch`. Two decks now stay in lock-step. Tradeoff: rubato tracks (Castlevania-style "lying tempo") lose their authored curve; the existing "unstable" library badge already flags those, and flat-to-master is the wanted behaviour for DJ mixing.

User confirmed sync was nicer afterwards.

### Loop-length spinner swipe direction inverted

Bonus fix from the same commit (`8dd2003`). The touch handler in `mountSpinner` was inverted vs the wheel handler — swipe right (toward ›) was stepping to the previous value. Flipped signs so right = next, left = previous, matching the arrows and the wheel.

### "Start" button — single-tap-arms-cue on the piano roll

User: "There's gotta be a way more intuitive way to use this playlist… we need a button that actually toggles on selecting the queue or drop position so user can freely pinch + move around the piano roll without ever accidentally selecting a start position."

Per-deck `start` button. Tap once → button pulses accent-coloured; the next single-finger tap on that deck's roll commits the seek and auto-disarms. Loop-handle drags, loop-region slides, and pinch-zoom are unchanged (they key off specific hit-tests / two-finger gestures). Track-load also disarms. (`9c34782`)

Followup bug (`b10ad64`): pinch-end leaked a scrub via the surviving finger. When a two-finger pinch ended by lifting one finger (2→1), `endPointer` unconditionally promoted the remaining finger to `dragMode='scrub'` and the next `pointermove` called `seekDeck`. Now 2→1 transitions neutralise `dragMode`; if the user wants to scrub, they tap Start and start a fresh single-finger gesture.

### Sticky cue point

User: "Start points are being reset after they've been triggered, they should remain where they are unless set elsewhere!"

`stopDeck` was hard-resetting `deck.currentTick = 0`, so any cue the user set via Start was lost on stop / natural track end. Separated the two concepts:

- `deck.cueTick` — the user's sticky start point. Set when `seekDeck` commits, or when a playlist entry's `cueTick` override is applied. Reset to 0 only on track load.
- `deck.currentTick` — the live playhead. Advanced by the scheduler during playback; restored to `cueTick` on stop (was: forced to 0).

`captureDeckIntoEntry` now records `cueTick` rather than `currentTick`, so a snapshot taken mid-playback still encodes the intended start position. (`8935fa8`)

### Playlist sequencer mode

User: "I think we need another mode/view to how the library works — a playlist view-mode … so for each track in the playlist we can preconfigure queue points / loops / mutes etc."

Big spec-then-build pass.

**Data model.** localStorage-backed (`vgmDj.playlists.v1` + `currentPlaylistId.v1` + `catalogMode.v1`). `Playlist = { id, name, created, updated, entries[] }`. `Entry = { id, path, name?, cueTick?, loop?: { in, out, beats?, armed? }, outputMutes?, transpose?, timeFold?, volume? }`. Sparse — absent fields inherit post-load defaults.

**UI.** Mode tabs at the top of the catalog (`[library | playlist]`). Library mode preserves all existing behaviour; library rows gain a "+pl" pill that appends the track to the current playlist. Playlist mode shows the current set: ordered entries with index, title, override badges, ▴/▾ reorder, →1/→2 load, capture-from-deck, ×. Playlist picker dropdown + new/rename/duplicate/delete. (`199f80e`)

**Drop-into-loop.** `dropDeck` now launches from `loop.in` when a loop is `armed` and pre-set, rather than the cue tick. First wrap fires at `loop.out`, landing the drop directly into the loop region.

**Prefetch.** On loading a playlist entry, the next entry is fetched + worker-parsed into a one-slot cache in the background. Loading that next entry is a state-assignment (skips fetch + parse), so swapping between consecutive entries is near-instant. This was the load-time-interruption killer that survived the scheduler lookahead.

**Scannable rows + library-button fix (`5d5fb94`).** First pass showed only title + game — useless for navigating a set. Restructured to mirror the library row's columns (BPM / key / meter / length / parts tags), added an on-deck indicator dot (teal=loaded on deck 1, pink=deck 2, split=both), badges column with explicit `cue / loop / loop★ / mute / ±N / 2×` for each captured override, "fresh" italic when nothing's saved, column-header strip. Library row's `load-btns` grid column was 70 px and got squashed when `+pl` joined; bumped to 110 px and made all three buttons same-sized.

**Snapshots framing (`51535d4`).** User: "Each row in the playlist should be like snapshots if you will." Reframed creation flow: per-deck `btn-snap` button. Tapping it captures the deck's full state (cue, loop, mutes, transpose, time-fold, volume, the loaded track) into a new row in the current playlist; view flips to playlist mode so the snapshot lands visibly. Optional `name` per entry; defaults to track title, suffixed `· take N` when the same track appears multiple times. Tap-to-rename via prompt; track filename shows as italic subtitle when the display name has been changed.

**Playlist render defer during playback (`c5d5d8f`).** Switching between library and playlist modes (or any action that triggers `renderPlaylistPane` — +pl, capture, reorder, delete, deck-load) rebuilt the entire entry list synchronously. For 20+ entries that's 30–50 ms of `innerHTML` + `addEventListener` work, more than the `LOOKAHEAD_MS=40` scheduling window, so the playing deck's `setTimeout` chain stalled and leaked audible jitter. Now: when any deck is playing, the rebuild is deferred via `requestIdleCallback` (200 ms cap). When nothing's playing, render is immediate.

### Deck-controls row + snap relocation

User pointed out the deck-controls row went "all fucked" after `start` and `snap` joined (`justify-content: space-between` was distributing items uniformly across the deck's width, ballooning gaps). Switched to a packed flex layout with uniform tight gap + a `.dc-spacer` to push `snap` to the right. Logical button order: play / drop / start / cue → trans / cut → follow / loop / transpose → spacer → snap. (`47d4a56`)

Then user asked for snap to move to the deck-head row instead, next to auto / unmute-all. Moved it. Tightened `.deck-head`'s gap from `clamp(0.55–1.3rem)` to `clamp(0.3–0.6rem)`. (`75d9ea3`)

### Routing pill "4" on the bass output

User: "I'm not sure why I'm still seeing 4 on the bass track?" That's the routing pill's `pill-count` — the number of source MIDI channels mapped to that hardware output. Hidden when 1 (the common case), now only shown when 2+ where it's a useful warning (multiple sources collapsing into one mono voice = dropped notes). Added a tooltip. (`47d4a56`)

### MIDI parser dedup — the real drum-flam root cause

User: "There must be something wrong with how the library is being parsed." Confirmed by writing a one-off Node script that mirrored the parser logic and inspected the dedup losses on level3.

Diagnosis: VGM-style MIDI Type 1 files routinely layer multiple **tracks** onto the same **channel** (one track per game voice, all writing to ch 0 or ch 1 — common for NES rips). The parser flattened those into a single event list containing literal duplicate noteOn/noteOff events at the same `(tick, channel, note, type)`. The piano roll overlaid them as a single note (so visually nothing wrong), but the synth received two identical noteOns and audibly retriggered — a flam on every chord onset, most pronounced at loop wraps where many simultaneous noteOns land at once. That matched the user's exact diagnosis of "the grid looks fine, the audio flams".

**Fix (`86d072b`).** In `midi-worker.js`, after `events.sort`, dedup by `(tick, channel, note, type)`. Keep the loudest velocity when noteOn dupes collide; noteOff dupes just collapse. User confirmed: "Looping is nicer now."

### Pitch-driven default routing

User: "There's only 1 track should go to bass, one to lead, and the rest to our poly channels." The previous rule was `ch === 9 ? 9 : (ch < 4 ? ch : ch % 4)` which dumped source channels 5/6/7 onto Lead/Bass/Poly 2 — multiple sources fighting each mono output.

**New `defaultRoutingFor(midi)` (`86d072b`).** Inspects average note pitch per source channel:
- Lowest avg pitch → Bass (output 2)
- Highest avg pitch → Lead (output 1)
- All other melodic sources alternate between Poly 1 and Poly 2

Mono outputs always carry exactly one source. 1-channel edge case routes to Poly 1 (preserves any chords on that single channel).

### Doom level BPM saga

1. User reported Doom level3-7 all showed 60 BPM and "definitely not 60". Added IOI-heuristic-derived overrides to `tools/tempo-overrides.json` (125, 91, 120, 81, 150) and regenerated the manifest. (`ec927fa`)
2. User came back: "level3 in my DAW looks fine at 60 BPM. There's something wrong with how our app is parsing those tracks in the piano roll!" Realised the overrides were warping the piano roll. `build-manifest` derives `perceived_ticks_per_beat = (metaBpm / perceivedBpm) * ticksPerBeat`; the roll's bar-grid math uses `perceived_ticks_per_beat`. With `perceived_bpm=125` vs `metaBpm=60`, `perceived_tpb` dropped from 560 (the file's actual) to 269 — every bar line on the roll fell out of phase with the file's notes. **Reverted overrides (`2ca3873`).**
3. User started swapping the bad files for differently-authored versions: `level4.mid → ~90 BPM` (`6cf1cfe`), `level6.mid → 80 BPM` (`ed74c7e`), `level7.mid → 140 BPM` (`48d30e7`). Each: `npm run manifest` → build → install → commit. Library row now reads 3=60, 4=90, 5=60, 6=80, 7=140 with `perceived_ticks_per_beat` matching file tpb (no warp).

Lesson learnt and recorded: `perceived_bpm ≠ bpm_initial` *intentionally* warps the roll's grid (we're saying "play this at a different rate than authored"). Use `tempo-overrides.json` only when the file's authored tempo is genuinely wrong. For "play this Doom track at 120 in a 120 BPM set" the **time-fold** button (½×/1×/2×) is the right tool — scales playback rate via `deck.pitch` without touching `perceived_ticks_per_beat`.

### CUE behaviour rewrite — GM preview synth as headphone monitor

User: "I'm not sure how the CUE button is supposed to work. I thought we would hear GM audio instead of MIDI going out of that deck?"

Previously CUE just soloed the cued deck globally (silenced the other one, kept sending cued MIDI to hardware) — useful for nothing in particular. Rewrote to match the DJ headphone-monitor convention:

- Cued deck's MIDI routes to the in-page GM preview synth (WebAudioTinySynth, output via the cue channel pair set in Settings).
- Hardware output (AUM/FOH) keeps receiving the **other** deck only — audience hears the live mix, DJ auditions the next track in headphones.
- The other deck is no longer silenced when CUE engages.

**Implementation (`a27d319`).** `sendRaw` grew a 5th `deckId` arg. When `cuedDeck === deckId`, routes to the test synth instead of `midiOutput`. Honours `LOOKAHEAD_MS` by deferring `synth.send` via `setTimeout` when a future stamp is passed, so preview aligns with hardware FOH. `dispatchNoteOn` / `dispatchNoteOff` / `silenceDeck` / `flipOutputs` / per-output-mute CC sweep all pass `deck.id` through. `deckAudible` returns true for the cued deck (overrides mix-switch). `setCue` drains the destination we're leaving before flipping `cuedDeck` (hardware on engage, synth on release) so notes don't keep ringing on the wrong bus.

### Settings cue channel-pair dropdown — wrong field name

User: "Something is wrong with output channel pair dropdown in the settings." Found that `buildCuePairOptions` emitted `{ id, label }` but `mountDropdown` reads `value`. Result: dropdown rendered no option as selected (placeholder showed instead of the persisted pair), and clicking an option fired `onChange(undefined)` which threw the moment it tried to `.split(',')` the id. The MIDI output dropdown already used `value`; this one had drifted. (`d0d4551`)

Also refreshed the `.selected` highlight in `mountDropdown.setValue` so an open menu mirrors the new value instead of the previous selection until the next click corrected it.

### MIDI-out port name prettifier (started, deferred)

User: "Why in the web app when I choose hardware output ports it's showing me Launch Control XL3 Mini in and DAW in shouldn't it be fucking LCXL3 out?" Explained CoreMIDI's device-perspective naming convention, then started `prettyOutputLabel(raw)` to strip the trailing " in" / " input" in display only. User interrupted partway through (asking for the LCXL3 bypass instead) — the helper is in place and the settings dropdown uses it, but I never finished applying it to the deck-strip `#midi-port` label or any other display path.

### Wrap-noteOff stagger experiment (shipped → reverted)

User: "It's still damn near impossible to get the Drums to loop without flaming on the kick drum at the loop point." Hypothesised that same-stamp noteOff (from `handleLoopWrap`) + noteOn (from new iter's `loop.in` events) at exactly `audibleOut` caused CoreMIDI's same-timestamp packet ordering to present as a flam on drums. Stamped wrap noteOffs at `audibleOut − 1 ms` so they'd land strictly before the new noteOns. (`01121a7`)

User then tested with live hardware: "completely fucked and out of time." Suspected the change. Reverted on their suspicion (`46c0882`) before deeper diagnosis — wanted them to confirm whether the stagger was actually the culprit. User then clarified the timing issue was on a single deck through hardware (hardware should be **less** CPU work than the AUM softsynth setup that was fine), so the stagger probably wasn't the cause — but the revert stands until we know what actually changed.

Open question for next session: hardware timing path is broken in some way we haven't pinned down. Suspects: the `LOOKAHEAD_MS=40` window itself may interact poorly with USB-MIDI latency stacks (events stamped 40 ms ahead arriving late enough to land in the past at CoreMIDI → fired immediately → clumping audible as "whack"), or the AUM-then-hardware chain strips timestamps, or… we don't know.

### LCXL3 LED + OLED bypass

User: "Can we have a bypass on all of the launch control LED / LED stuff."

The integration paints 16 strip-button LEDs + 24 encoder-ring LEDs + the full 128×64 OLED bitmap as SysEx on every animation frame. Substantial outbound traffic on the same CoreMIDI bus as the deck's note output — plausible suspect for the hardware timing regression.

**Settings → LCXL3 → "Bypass LED & OLED writes" toggle (`e9188ad`).** When on, `setEncoderLED` / `setButtonLED` / `_setLED` / `renderBitmap` on the LCXL3 instance become no-ops via wrapper functions. Input handlers (encoder CCs, button presses) keep working — you can still play the controller, you just won't get feedback on its surface. Engaging the bypass first sends one round of "clear everything" via the un-gated bindings so the controller doesn't sit on stale state. Disengaging triggers a fresh `paintLEDs()` pass; OLED catches up on the next `paint()` rAF frame. Persists in `localStorage` (`vgmdj.lcxl3.bypass.v1`). `window.vgmdjLcxl3Bypass(boolean)` exposed for devtools toggling too.

### GitHub Pages push

`midi-dj` was 29 commits ahead of `origin/main` at session end (everything from `8dd2003` to `e9188ad`). Pushed on user's say-so. GitHub Pages picked it up and rebuilt; final live URL is **https://midislave.github.io/vgm-midi-dj/**. The `midi-dj-ios` repo has no remote configured at all; iOS shell remains local-only.

### Files touched (web app)

- `docs/app.js` — scheduler lookahead, master-slaves-to-deck, lock-to-master, panic stamps, sticky cue, Start arm gating, playlist module (~600 lines), snapshot creation flow, prefetch, drop-into-loop, defaultRoutingFor, sendRaw deckId routing, mountDropdown setValue refresh, LCXL3 bypass toggle wiring.
- `docs/midi-worker.js` — `(tick, channel, note, type)` dedup pass after sort.
- `docs/index.html` — Start button + snap button per deck, catalog modes bar, library/playlist panes, settings sections for CUE channel pair and LCXL3 bypass.
- `docs/style.css` — `.btn-start.active` pulse, `.btn-snap.flash`, `.deck-controls` repacking, `.deck-head` tightening, catalog modes / playlist controls / playlist rows full styling, library row grid bump.
- `docs/lcxl3-integration.js` — bypass wrapper around `setEncoderLED` / `setButtonLED` / `_setLED` / `renderBitmap`; `window.vgmdjLcxl3Bypass` handle.
- `docs/midi-files/doom/level4.mid`, `level6.mid`, `level7.mid` — user-replaced source files at intended BPMs.
- `docs/tracks.json` — regenerated three times across the Doom shuffling.
- `tools/tempo-overrides.json` — added then reverted level3-7 overrides.

### Files touched (iOS shell)

- `VGMMidiDJ/Resources/WebApp/` — bundle rsynced after every web-app commit (handled by the Xcode build phase that runs unconditionally).
- Nothing else. No Swift changes this session.

### Architectural decisions worth carrying forward

- **Lookahead is opt-in by native shell.** `LOOKAHEAD_MS` is non-zero only when `window.__vgmDjNativeShell` is set, so testMode (WebAudioTinySynth, no timestamp arg) and unverified desktop Web MIDI impls stay on the existing fire-at-now path. If we add a desktop-Web-MIDI deploy target later, vet whether their implementations honour future stamps before flipping LOOKAHEAD_MS on for them.
- **`LOCK_DECK_RATE_TO_MASTER = true` is the default for DJ-style mixing.** Files with intentional rubato (Castlevania-style "lying tempo") lose their curve. Acceptable for the live-mixing use case; the `unstable` library badge already flags those tracks. If we want a per-deck override, the constant is the place to wire a runtime toggle.
- **Playlist row = snapshot.** The mental model is "snapshot of deck state, not just a track reference." The primary creation path is the per-deck `snap` button; the per-row `←1`/`←2` capture buttons update an existing snapshot, and library's `+pl` creates a "fresh" placeholder.
- **`cueTick` is the user's sticky start point.** `currentTick` is the live playhead. They're separate. Stop returns to `cueTick`; entry overrides write to both. Future autoadvance / song-mode work should respect `cueTick` for "where does this entry start".
- **CUE is headphone-monitor, not solo-globally.** Hardware FOH stays unchanged when CUE engages; only the cued deck's routing flips to the GM preview synth.
- **Pages serves from `main:/docs`.** Push to `origin/main` and the build kicks off automatically. ~50 second median build time per the API history.

### Known gaps / next session's playground

- **Hardware timing regression unconfirmed.** User reported "completely fucked and out of time" on a real-hardware test. The 1 ms wrap stagger was reverted on suspicion but they didn't confirm whether timing returned. Suspects to chase in order: (1) the LCXL3 SysEx traffic (bypass toggle just shipped — should be the first thing to A/B with), (2) the `LOOKAHEAD_MS=40` window being incompatible with the user's USB-MIDI latency chain, (3) AUM stripping timestamps when forwarding to hardware. Diagnostic plan: have user confirm whether LCXL3 bypass alone restores timing; if not, try `LOOKAHEAD_MS=0` next.
- **Drum loop-wrap flam revisit.** The 1 ms stagger fix was the principled solution but was reverted under suspicion. If the bypass toggle fixes hardware timing independently, the stagger can come back. If not, the right move is probably a more targeted fix: detect when a wrap noteOff and the new iter's noteOn share a stamp for the same `(outCh, note)` and either coalesce or skip the noteOff.
- **MIDI-out port label prettifier.** `prettyOutputLabel(raw)` exists in `app.js` and is wired into `refreshSettingsMidiPortDropdown`, but `setMidiOutputById` / `choose()` still set `port.textContent = pick.name` raw. Should apply the prettifier on every display path.
- **Per-entry inline editor.** Right now overrides are only set via "snap" or "capture from deck". Fine-tuning a specific field (cue tick, loop length, single mute) requires re-tweaking the deck. A popover with sliders/spinners per entry would close the loop.
- **Touch-based drag reorder.** ▴/▾ buttons are the safe shim; iOS Safari needs pointer-based drag for native reorder.
- **Auto-advance from playlist (song mode).** Spec'd in chat but not built. The deck's existing `auto ↻` flag could prefer playlist order over library order when a playlist is active.
- **The `midi-dj-ios` repo has no remote.** All session bundle-sync commits are local-only on that side. If we want it on GitHub, `git remote add origin …` + `git push -u`.

### Commits at end of this session

- `midi-dj`: 29 new commits, tip at `e9188ad`. Pushed to `origin/main` — Pages built and is now live.
- `midi-dj-ios`: 14 new bundle-sync commits, tip at `8f5f98d`. No remote; not pushed anywhere.
- iPad install: current on `e9188ad` / `8f5f98d` (built + installed after every web-app commit via `xcodebuild` + `xcrun devicectl device install`).
