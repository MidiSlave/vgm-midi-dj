# Prompt for the next Claude agent — VGM MIDI DJ iOS polyfill extension

## Read these first, in order

1. **`/Users/naenae/bloop/baeng-and-raembl/midi-dj/SESSION_LOG.md`** — full session state. The "NEXT TASK FOR INCOMING AGENT" section near the top is your spec.
2. **`/Users/naenae/bloop/baeng-and-raembl/midi-dj/CLAUDE.md`** — project conventions and gotchas.
3. **`/Users/naenae/bloop/baeng-and-raembl/midi-dj-ios/CLAUDE.md`** — iOS-side conventions.

You do not need to re-derive the architecture from prior commits or memory entries; SESSION_LOG.md is authoritative for the current direction.

## Your job

Bring the LCXL3 hardware integration that already works in desktop Chrome over to the iOS WKWebView shell. **The JS code does not need to change** — it already calls `navigator.requestMIDIAccess({ sysex: true })` and finds the LCXL3 by port name. What's missing is the iOS-side plumbing.

### Files you will edit

1. **`midi-dj-ios/VGMMidiDJ/UI/WebMIDIPolyfill.js`** — currently output-only, hardcodes `sysexEnabled: false`, has a single `'native-vgm-dj'` output. Extend it to expose real per-device inputs and outputs, with working `onmidimessage` dispatch driven by native.
2. **`midi-dj-ios/VGMMidiDJ/MIDI/MIDIService.swift`** — currently send-only via a virtual source. Add an input port that subscribes to all CoreMIDI sources and forwards bytes to the WebView. Extend send to route by destination UID.
3. **`midi-dj-ios/VGMMidiDJ/UI/WebAppView.swift`** — the bridge coordinator. Route `outputId`-tagged sends to the right destination, and on `didFinish` push the initial port topology into JS.

### Bridge-protocol contract

**JS → Native** (via `webkit.messageHandlers.vgmMidi.postMessage(...)`):

```js
// Send bytes to a specific output (LCXL3 SysEx / LED / OLED, or AUM via VGM DJ virtual)
{ kind: 'send', outputId: '<MIDIUniqueID-string>', bytes: [...], timestamp, deltaMs }

// Backwards-compatible (defaults to native-vgm-dj):
{ kind: 'send', bytes: [...], timestamp, deltaMs }

// Existing — leave intact:
{ kind: 'panic' }
{ kind: 'midiAccessReady', sysex: true }
```

**Native → JS** (via `evaluateJavaScript`):

```js
// Incoming MIDI from a source — fires onmidimessage on the matching input
window.__vgmMidiInput('<source-id>', [0xB0, 0x25, 0x7F], performance.now());

// Topology refresh — polyfill updates ACCESS.inputs/outputs Maps + fires onstatechange
window.__vgmMidiPortsUpdate({
  inputs:  [{ id: '<MIDIUniqueID-string>', name: 'LCXL3 1 DAW Out', manufacturer: 'Focusrite - Novation' }],
  outputs: [{ id: 'native-vgm-dj',         name: 'VGM DJ',           manufacturer: 'VGM DJ' },
            { id: '<MIDIUniqueID-string>', name: 'LCXL3 1 DAW In',   manufacturer: 'Focusrite - Novation' }]
});
```

Port IDs must be **stable across the app lifetime** — use the `MIDIUniqueID` from CoreMIDI as a string. The LCXL3 driver does a name-based match (`port.name.includes('Launch Control XL')`), so the polyfill's name fields must equal the CoreMIDI display name exactly.

### Don't break what's already working

- `'native-vgm-dj'` must keep behaving as a virtual source publisher — AUM subscribes to that. If a JS send arrives with `outputId === 'native-vgm-dj'` (or no `outputId`), publish via `MIDIReceived(virtualSource, ...)` as today.
- `sysexEnabled` should be `true` once iOS grants WebMIDI access. The LCXL3 driver refuses to send SysEx (which is how OLED + LEDs work) if it's `false`.
- The polyfill's status-widget responsibility (the battery + clock thing) must keep working unchanged.

## Verification — must pass before declaring done

Run on a real iPad with an LCXL3 plugged in (USB-C or via a hub):

1. Build, install, launch.
2. Open the LCXL3 drawer at the bottom of the web app inside the iOS shell.
3. Console (Safari Web Inspector → iPad) should log:
   - `[VGM DJ shell] Web MIDI polyfill installed`
   - `[VirtualLCXL3] Connected via DAW port: in="LCXL3 1 DAW Out" out="LCXL3 1 DAW In"`
   - `[VirtualLCXL3] Sent DAW-mode-enable SysEx`
   - `[VirtualLCXL3] Selected DAW Control sub-mode`
   - `[lcxl3] paintStripButtons → 16 strip toggles painted`
4. **LCXL3 LEDs paint** — encoder rings show the 8-column track palette (centre-off because they're bipolar), strip buttons show dim amber / dim red.
5. **Press a Solo or Mute button** — its LED jumps to full brightness, OLED touch popup shows e.g. `DRUMS SOLO ON`. Press again, LED drops back to dim, popup reads `DRUMS SOLO OFF`.
6. **Turn an encoder** — encoder LED lights up scaled by distance from centre. Row C on tracks 1–5 shows teal CCW / orange CW.
7. **Open AUM in Split View** — load a track in VGM DJ, hit play. AUM still receives MIDI notes through the `VGM DJ` virtual source (regression check). With AUM's MIDI Learn, you can also map LCXL3 controls — they appear on AUM's side as CCs on the `VGM DJ` source if you rebroadcast them, or as the LCXL3 device directly if you don't (per the architecture decision in SESSION_LOG: we are NOT rebroadcasting yet — that's a later step).

## Things you must NOT touch

- `docs/lcxl3/virtual-lcxl3.js` — empirically tested driver, do not edit. SysEx commands inside it match Novation's official PDF spec.
- `docs/lcxl3-integration.js` — works as-is in Chrome; will work in WebView once the polyfill is fixed.
- `docs/app.js` deck logic — the LCXL3 doesn't affect deck state. Don't introduce a coupling.
- `plan-report.md` and `research-report.md` at repo root — SUPERSEDED stale docs, leave alone.
- The 2026-05-23 LCXL3-integration commit `7a7b24e` and baseline commits `81a1356` (iOS) — these are your safety net. Don't reset past them.

## Safety net if things go wrong

```sh
# Roll iOS app to pre-baseline (untracked snapshot):
rm -rf /Users/naenae/bloop/baeng-and-raembl/midi-dj-ios
mv /Users/naenae/bloop/baeng-and-raembl/midi-dj-ios.backup \
   /Users/naenae/bloop/baeng-and-raembl/midi-dj-ios

# Roll iOS app to baseline commit (preserves git history):
cd /Users/naenae/bloop/baeng-and-raembl/midi-dj-ios && git reset --hard 81a1356

# Roll web app to pre-LCXL3-integration:
cd /Users/naenae/bloop/baeng-and-raembl/midi-dj && git reset --hard 4fc681a
```

## After you're done

- Commit your work in `midi-dj-ios/` with a clear message (e.g. `feat: bidirectional WebMIDI polyfill for LCXL3`).
- If you've also touched `docs/`, commit there separately.
- Update `SESSION_LOG.md` with: what you actually did, anything that surprised you, anything the next-next agent should know. Append a new dated section — don't rewrite the existing one.
- Do **not** push to remote unless the user explicitly asks.
- Report back to the user with: commit SHAs, verification result (which steps passed / failed), and what's still pending.

## When to stop and ask

- If the polyfill design above doesn't match what you find in `MIDIService.swift`'s actual structure — stop and clarify before improvising.
- If the iPad-side WebMIDI permission flow needs a different sysex-prompt sequence than expected — stop and clarify.
- If anything would require modifying `docs/lcxl3/virtual-lcxl3.js` — stop and clarify. That driver is treated as load-bearing prior art.
- If you discover the iOS app build/sync pipeline (`project.yml` rsync phase) needs to change — stop and clarify before editing it.

Operate in auto-mode otherwise. Make reasonable assumptions about Swift idioms and CoreMIDI usage. Keep changes minimal and focused on the task above; do not refactor unrelated code.
