// LCXL3 integration — brings the Launch Control XL 3 into the live web app.
//
// Architecture: LCXL3 (USB) → this module (state owner) → VGM DJ virtual MIDI
// source → AUM. We do NOT pass LCXL3 traffic through to AUM directly; AUM
// receives only what this module rebroadcasts on the existing output.
//
// What this module owns:
//   - Mount VirtualLCXL3 in #lcxl3-mount (also bridges to real hardware).
//   - Paint the idle OLED view (master + dual-deck horizontal layout).
//   - Touch popup on any CC / mute-solo button press.
//   - PAGE_UP / PAGE_DOWN cycle which deck has focus.
//   - Track absolute encoder positions in software (LCXL3 encoders are
//     relative ticks; AUM needs absolutes).
//   - Rebroadcast every control as a mapping-friendly absolute CC on the
//     VGM DJ virtual source, MIDI channel 16. Row C HW tracks fan out to
//     two CCs (REV / DLY) split by side of centre detent.
//
// Out of scope:
//   - FX tracks 6-8 effects implementation (no in-app effects layer yet —
//     the CCs are still rebroadcast for future use).

import { VirtualLCXL3 } from './lcxl3/virtual-lcxl3.js';
import {
  createBitmapBuffer, setPixel,
  drawHLine, drawVLine, drawRect, fillRect,
  drawText, drawTextInverted, measureText,
  renderTitleBar,
} from './lcxl3/oled-list-renderer.js';
import * as Viz from './lcxl3/oled-visualizers.js';

// Wait for app.js to expose its handle. init() runs at end of app.js, so by the
// time this module's microtasks run, window.vgmdj may or may not be ready yet
// depending on script ordering. Poll briefly.
function whenReady() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.vgmdj) resolve(window.vgmdj);
      else setTimeout(check, 50);
    };
    check();
  });
}

const vgmdj = await whenReady();
const { decks, master, OUTPUT_ORDER } = vgmdj;

const mountEl = document.getElementById('lcxl3-mount');
if (!mountEl) {
  console.warn('[lcxl3] mount point missing — integration disabled');
} else {
  const lcxl3 = new VirtualLCXL3('lcxl3-mount', { logoPath: 'lcxl3/LCXL3_logo.png' });

  // Surface connection state next to the existing MIDI status pill.
  const midiPortEl = document.getElementById('midi-port');
  setInterval(() => {
    if (!midiPortEl) return;
    if (lcxl3.connected && !midiPortEl.dataset.lcxl3Marked) {
      midiPortEl.dataset.lcxl3Marked = '1';
      midiPortEl.title = 'LCXL3 connected';
    }
  }, 500);

  /* ─── Relative-encoder state tracking ─── */
  const FADER_SET = new Set([5, 6, 7, 8, 9, 10, 11, 12]);
  const encValue = {}; // cc → 0..127 absolute
  function initialEncoderValue(cc) {
    // Bipolar knobs rest at centre (64). Linear ones (sizes, times, decays)
    // rest at 0 so the first CW tick takes them off "minimum" instead of
    // off centre — that's what AUM Learn expects for one-sided params.
    return isBipolarCC(cc) ? 64 : 0;
  }
  function applyRelative(cc, raw) {
    let delta;
    if (raw >= 1 && raw <= 63) delta = raw;
    else if (raw >= 64 && raw <= 95) delta = -(raw - 64);
    else if (raw >= 96 && raw <= 127) delta = raw - 128;
    else delta = 0;
    if (encValue[cc] === undefined) encValue[cc] = initialEncoderValue(cc);
    encValue[cc] = Math.max(0, Math.min(127, encValue[cc] + delta));
    return encValue[cc];
  }

  /* ─── Focused deck (which deck the LCXL3 controls right now) ─── */
  let focusedDeckId = '1';
  function deckLabel(id) { return id === '1' ? 'A' : 'B'; }

  /* ─── OLED touch-popup state ─── */
  // Single popup template: title + full-width horizontal bar. For Row C
  // dual-function sends, the label flips between "{TRACK} REV" and "{TRACK} DLY"
  // depending on which side of centre the encoder sits.
  let touchUntil = 0;
  let touchKind = 'single';   // 'viz' | 'single' | 'button' | 'fader'
  let touchLabel = '', touchValue = 0;
  let touchSendAmount = null; // 0..100 numeric for legacy fallback popups
  let touchViz = null;        // visualizer function from oled-visualizers.js
  let touchVizVal = 0;        // 0..100 normalised value passed to the visualizer
  // sendSide tracks which side (REV or DLY) was last engaged for each Row C
  // HW knob so the popup stays stable through a centre-detent crossing.
  const sendSide = {}; // trackIdx → 'REV' | 'DLY'

  // Offscreen 128×64 canvas — every animated visualiser draws here, then
  // the pixels are thresholded into the LCXL3 OLED bitmap buffer.
  const vizCanvas = Viz.makeOLEDCanvas();
  const vizCtx = vizCanvas.getContext('2d');

  /* ─── 8-column track model ─── */
  // Columns 0-4 are HW synth tracks, 5 is FX 1 (reverb), 6 is FX 2 (delay),
  // 7 is the MASTER bus (HP/LP filter on Row A; B + C unassigned for now).
  const TRACK_NAMES = ['DRUMS', 'BASS', 'LEAD', 'POLY 1', 'POLY 2', 'FX 1', 'FX 2', 'MASTER'];
  const HW_COLS = new Set([0, 1, 2, 3, 4]);
  const MASTER_COL = 7;
  function isFilterCol(col) { return HW_COLS.has(col) || col === MASTER_COL; }

  // Bipolar knobs centre-detent at 64 and split into two scaled CCs (one for
  // each side of centre). Every other knob is a plain linear 0..127 control
  // that should rest at 0, not at centre — e.g. Reverb Size / Delay Time
  // are size/amount controls, not bidirectional.
  function isBipolarCC(cc) {
    if (cc >= 13 && cc <= 17) return true;    // Row A LP/HP for HW tracks 1-5
    if (cc === 20) return true;               // Row A LP/HP for master
    if (cc >= 21 && cc <= 25) return true;    // Row B pan for HW tracks 1-5
    if (cc >= 29 && cc <= 33) return true;    // Row C REV/DLY for HW tracks 1-5
    if (cc === 35) return true;               // Row C FX 2 P3 = Delay LP/HP filter
    return false;
  }

  function labelForCC(cc, value) {
    if (cc >= 5 && cc <= 12) return `${TRACK_NAMES[cc - 5]} VOL`;
    if (cc >= 13 && cc <= 20) {
      // Row A: bipolar LP/HP for HW tracks + master; absolute for FX cols.
      const col = cc - 13;
      if (isFilterCol(col)) {
        if (value < DETENT_LO) return `${TRACK_NAMES[col]} LP`;
        if (value > DETENT_HI) return `${TRACK_NAMES[col]} HP`;
        return `${TRACK_NAMES[col]} FILT ·`;
      }
      if (col === 5) return 'REV SIZE';
      if (col === 6) return 'DLY TIME';
      return `${TRACK_NAMES[col]} P1`;
    }
    if (cc >= 21 && cc <= 28) {
      // Row B: pan for HW tracks, FX P2 for cols 5/6, unassigned on master.
      const col = cc - 21;
      if (HW_COLS.has(col)) return `${TRACK_NAMES[col]} PAN`;
      if (col === 5) return 'REV DECAY';
      if (col === 6) return 'DLY FBK';
      return `${TRACK_NAMES[col]} B`;
    }
    if (cc >= 29 && cc <= 36) {
      // Row C: bipolar REV/DLY for HW tracks, FX 1 P3 (damp) linear,
      // FX 2 P3 (DLY filter) bipolar LP/HP, unassigned on master.
      const col = cc - 29;
      if (HW_COLS.has(col)) {
        if (value < DETENT_LO) return `${TRACK_NAMES[col]} REV`;
        if (value > DETENT_HI) return `${TRACK_NAMES[col]} DLY`;
        return `${TRACK_NAMES[col]} SEND ·`;
      }
      if (col === 5) return 'REV DAMP';
      if (col === 6) {
        if (value < DETENT_LO) return 'DLY LP';
        if (value > DETENT_HI) return 'DLY HP';
        return 'DLY FLT ·';
      }
      return `${TRACK_NAMES[col]} C`;
    }
    return `CC ${cc}`;
  }
  function labelForButton(cc) {
    if (cc >= 37 && cc <= 44) return `${TRACK_NAMES[cc - 37]} SOLO`;
    if (cc >= 45 && cc <= 52) return `${TRACK_NAMES[cc - 45]} MUTE`;
    if (cc === 116) return 'PLAY';
    if (cc === 118) return 'REC';
    if (cc === 102) return '← TRACK';
    if (cc === 103) return 'TRACK →';
    if (cc === 106) return `DECK ${deckLabel(focusedDeckId)} ↑`;
    if (cc === 107) return `DECK ${deckLabel(focusedDeckId)} ↓`;
    return null;
  }

  /* ─── Rebroadcast layout (MIDI channel 16, 0-indexed = 15) ─── */
  // Everything LCXL3-derived is fanned out to channel 16 on the VGM DJ
  // virtual source. AUM MIDI-Learns plugin parameters against this source
  // and never has to listen to the LCXL3 directly — that way encoder ticks
  // arrive as proper 0–127 absolutes (not relative-encoder format), and
  // Row C's REV/DLY split lands on two separate CCs that map independently.
  // Note traffic for the hardware synths stays on its own channels (0,1,2,3,9)
  // so channel 16 is reserved entirely for control.
  const REBROADCAST_CHANNEL = 15;            // MIDI ch 16
  // Row C HW track sends are the ONLY controls split into two CCs — REV (CCW,
  // native CC) + DLY (CW, native CC + 24). Everything else, including the
  // LP/HP filter knobs, is a single bidirectional 0..127 CC where 64 = centre
  // (the plugin in AUM, e.g. Reel Tape Delay's filter / a dual LP-HP plugin,
  // handles the morph internally).
  const DLY_CC_BASE = 53;                    // Row C DLY CCs 53-57 for HW tracks 1-5
  function rebroadcast(cc, value) {
    vgmdj.sendCC(REBROADCAST_CHANNEL, cc, value);
  }
  function bipolarSides(absolute) {
    // Helper: split a 0-127 absolute around the centre detent into two scaled
    // 0-127 sides. CCW side ("lo") rises as we move below centre; CW ("hi")
    // rises as we move above centre. Inside the detent band both return 0.
    const lo = absolute < DETENT_LO ? Math.round((64 - absolute) / 64 * 127) : 0;
    const hi = absolute > DETENT_HI ? Math.round((absolute - 64) / 63 * 127) : 0;
    return [lo, hi];
  }

  /* ─── Visualiser dispatch ───
   * Maps an LCXL3 CC + absolute position to one of the canvas-based
   * visualisers in `lcxl3/oled-visualizers.js`. Returns null if the CC has
   * no dedicated animation (faders, master placeholders, etc.). The bipolar
   * filter / DLY-filter pass `absolute / 127 * 100` so 50 = centre detent
   * = neutral. Row C sends pick REV or DLY visualiser based on which side
   * of centre the knob is on, with the last-touched side persisted so the
   * popup doesn't flip every time the user pushes through the detent. */
  function pickVisualizer(cc, absolute) {
    const val127 = (v) => (v / 127) * 100;
    // Row A — filter (HW tracks 1-5 + master)
    if ((cc >= 13 && cc <= 17) || cc === 20) {
      return { fn: Viz.drawFilter, val: val127(absolute) };
    }
    // Row A — FX 1 P1 = Reverb Size, FX 2 P1 = Delay Time
    if (cc === 18) return { fn: Viz.drawReverbSize, val: val127(absolute) };
    if (cc === 19) return { fn: Viz.drawDelayTime, val: val127(absolute) };
    // Row B — Pan (HW tracks 1-5)
    if (cc >= 21 && cc <= 25) {
      return { fn: Viz.drawPan, val: val127(absolute) };
    }
    // Row B — FX 1 P2 = Reverb Decay, FX 2 P2 = Delay Feedback
    if (cc === 26) return { fn: Viz.drawReverbDecay, val: val127(absolute) };
    if (cc === 27) return { fn: Viz.drawDelayFeedback, val: val127(absolute) };
    // Row C — HW tracks 1-5: bipolar REV (CCW) / DLY (CW) sends.
    if (cc >= 29 && cc <= 33) {
      const trackIdx = cc - 29;
      let side = sendSide[trackIdx];
      let amount = 0;
      if (absolute < DETENT_LO) {
        side = 'REV';
        amount = ((64 - absolute) / 64) * 100;
      } else if (absolute > DETENT_HI) {
        side = 'DLY';
        amount = ((absolute - 64) / 63) * 100;
      } else {
        if (!side) side = 'REV';
        amount = 0;
      }
      sendSide[trackIdx] = side;
      return { fn: side === 'REV' ? Viz.drawReverbSend : Viz.drawDelaySend, val: amount };
    }
    // Row C — FX 1 P3 = Reverb Damp, FX 2 P3 = Delay Filter (bipolar LP/HP)
    if (cc === 34) return { fn: Viz.drawReverbDamp, val: val127(absolute) };
    if (cc === 35) return { fn: Viz.drawDelayFilter, val: val127(absolute) };
    return null;
  }

  /* ─── CC handler ─── */
  lcxl3.onCC((cc, value, shift) => {
    let absolute;
    if (FADER_SET.has(cc)) {
      absolute = value;
      encValue[cc] = value;
    } else {
      absolute = applyRelative(cc, value);
    }

    // Rebroadcast as absolute on channel 16 so AUM sees clean 0-127 values
    // instead of the LCXL3's relative-encoder ticks. Only Row C HW sends are
    // split into two CCs (REV CCW, DLY CW) — see below. Everything else is a
    // single bidirectional 0..127 CC and the plugin handles the morph.
    if (cc >= 5 && cc <= 12) {
      // Faders — per-track volume.
      rebroadcast(cc, absolute);
    } else if (cc >= 13 && cc <= 28) {
      // Row A (filter / FX P1) + Row B (pan / FX P2) — single bidirectional CC.
      rebroadcast(cc, absolute);
    } else if (cc >= 29 && cc <= 36) {
      const col = cc - 29;
      if (HW_COLS.has(col)) {
        // Row C HW tracks 1-5 — REV (native CC) + DLY (native + 24) split.
        const [rev, dly] = bipolarSides(absolute);
        rebroadcast(cc, rev);
        rebroadcast(DLY_CC_BASE + col, dly);
      } else {
        // Row C FX P3 / master placeholder — single bidirectional CC.
        rebroadcast(cc, absolute);
      }
    }
    // Dispatch popup → animated visualiser when one exists for this CC.
    // The visualiser library uses 0..100 throughout; we convert from the
    // encoder's 0..127 (or compute side amounts for bipolar splits).
    const viz = pickVisualizer(cc, absolute);
    if (viz) {
      touchKind = 'viz';
      touchViz = viz.fn;
      touchVizVal = viz.val;
      touchLabel = '';
      touchValue = absolute;
      touchSendAmount = null;
    } else if (cc >= 5 && cc <= 12) {
      // Fader — rounded-bar popup without TOUCH banner.
      touchKind = 'fader';
      touchLabel = labelForCC(cc, absolute);
      touchValue = absolute;
      touchSendAmount = null;
    } else {
      // Unassigned / placeholder — plain bar, no TOUCH banner.
      touchKind = 'single';
      touchLabel = labelForCC(cc, absolute);
      touchValue = absolute;
      touchSendAmount = null;
    }
    touchUntil = Date.now() + 900;
    // Repaint the affected encoder's LED so brightness tracks the new value.
    if (cc >= 13 && cc <= 36) {
      const col = (cc - 13) % 8;
      const row = Math.floor((cc - 13) / 8); // 0=A 1=B 2=C
      paintEncoderLED(row, col);
    }
  });

  /* ─── Button handler ───
   * Buttons are also AUM-mapped — no VGM DJ deck state changes. PAGE_UP/DOWN
   * is the one exception: it changes which deck the OLED idle view emphasises,
   * but that's purely an OLED-display affordance, not a MIDI side-effect. */
  lcxl3.onButtonDown((cc, shift) => {
    if (cc === 106 || cc === 107) {
      focusedDeckId = focusedDeckId === '1' ? '2' : '1';
      touchKind = 'single';
      touchLabel = `FOCUS DECK ${deckLabel(focusedDeckId)}`;
      touchValue = 127;
      touchUntil = Date.now() + 1200;
      return;
    }
    // Strip buttons are toggles — flip local state, repaint the LED, and
    // rebroadcast the new state as a 0/127 CC on channel 16 so AUM has a
    // clean latched switch to map to plugin parameters.
    if (isToggleButton(cc)) {
      const next = !(buttonToggle.get(cc) === true);
      buttonToggle.set(cc, next);
      paintButtonLED(cc);
      rebroadcast(cc, next ? 127 : 0);
    }
    if (isToggleButton(cc)) {
      // Streamlined toggle popup: just the state, no numeric value or bar.
      //   Mute press  → "DRUMS MUTED" / "DRUMS UNMUTED"
      //   Solo press  → "DRUMS SOLO"  / "DRUMS SOLO OFF"
      const trackIdx = (cc >= 37 && cc <= 44) ? cc - 37 : cc - 45;
      const on = buttonToggle.get(cc) === true;
      const track = TRACK_NAMES[trackIdx];
      let stateText;
      if (cc >= 37 && cc <= 44) {
        stateText = on ? `${track} SOLO` : `${track} SOLO OFF`;
      } else {
        stateText = on ? `${track} MUTED` : `${track} UNMUTED`;
      }
      touchKind = 'button';
      touchLabel = stateText;
      touchValue = on ? 127 : 0;
      touchUntil = Date.now() + 900;
    } else {
      const label = labelForButton(cc);
      if (label) {
        touchKind = 'button';
        touchLabel = label;
        touchValue = 127;
        touchUntil = Date.now() + 900;
      }
    }
  });

  /* ─── OLED idle view ─── */
  function stateGlyph(deck) {
    if (deck.playing) return '>';
    if (deck.midi) return '.';
    return '|';
  }
  function deckTitle(deck) {
    return (deck.meta?.title || '').toUpperCase();
  }

  // Marquee scroll helper — pixel-clipped to a column window.
  const CHAR_W = 6;
  const SCROLL_PX_PER_SEC = 18;
  const SCROLL_PAUSE_MS = 1200;
  const scratchBuf = createBitmapBuffer();
  function drawTextScrolling(buf, text, x, y, maxW, tMs) {
    const full = measureText(text);
    if (full <= maxW) { drawText(buf, text, x, y); return; }
    const loop = text + '   ';
    const loopW = measureText(loop);
    const periodMs = (loopW / SCROLL_PX_PER_SEC) * 1000 + SCROLL_PAUSE_MS;
    const phase = ((tMs % periodMs) + periodMs) % periodMs;
    const moving = Math.max(0, phase - SCROLL_PAUSE_MS);
    const offset = Math.floor((moving / 1000) * SCROLL_PX_PER_SEC) % loopW;
    for (let copy = 0; copy < 2; copy++) {
      const baseX = x - offset + copy * loopW;
      for (let i = 0; i < loop.length; i++) {
        const cx = baseX + i * CHAR_W;
        if (cx + 5 < x || cx >= x + maxW) continue;
        drawCharClipped(buf, loop[i], cx, y, x, x + maxW);
      }
    }
  }
  function drawCharClipped(buf, char, x, y, xMin, xMax) {
    if (x >= xMax || x + 5 < xMin) return;
    for (let r = 0; r < 7; r++) scratchBuf[r * 19] = 0;
    drawText(scratchBuf, char, 0, 0);
    for (let r = 0; r < 7; r++) {
      const rowByte = scratchBuf[r * 19];
      for (let c = 0; c < 5; c++) {
        const dx = x + c;
        if (dx < xMin || dx >= xMax) continue;
        if (rowByte & (1 << (6 - c))) setPixel(buf, dx, y + r, true);
      }
    }
  }

  // Per-deck slot state derived from app state. Three states only:
  //   loaded      = track has content for this instrument and it's not muted
  //   muted       = track has content but the output is muted
  //   unavailable = the loaded track has no source routed to this output
  // No live MIDI-gate flicker — too noisy to be useful on the OLED.
  function slotStatesFor(deck) {
    const states = new Array(5).fill('unavailable');
    if (!deck.midi) return states;
    const usedOutputs = new Set(Object.values(deck.routing).filter(o => o >= 0));
    for (let col = 0; col < 5; col++) {
      const outCh = OUTPUT_ORDER[col];
      if (!usedOutputs.has(outCh)) continue;
      states[col] = deck.outputMute.has(outCh) ? 'muted' : 'loaded';
    }
    return states;
  }

  function drawSlotDigit(buf, x, y, n, state) {
    const digit = String(n);
    if (state === 'unavailable') {
      setPixel(buf, x + 2, y + 3);
      return;
    }
    drawText(buf, digit, x, y);
    if (state === 'muted') {
      // Strike through the digit's midline to mark "loaded but silenced".
      drawHLine(buf, x - 1, x + 5, y + 3);
    }
  }

  function drawDeckColumn(buf, x, y, w, h, deckId) {
    const deck = decks[deckId];
    const focused = deckId === focusedDeckId;
    // Header: "A >"  (or "*A>" when focused — leading dot marks focus)
    const head = (focused ? '*' : ' ') + deckLabel(deckId) + ' ' + stateGlyph(deck);
    drawText(buf, head, x, y);
    // Scrolling track title on its own line
    drawTextScrolling(buf, deckTitle(deck), x, y + 10, w, Date.now());
    // Slot row 1..5 (bare digits with state encoded in the glyph)
    const digitW = 5;
    const inkW = digitW * 5;
    const gap = Math.max(2, Math.floor((w - inkW) / 4));
    const stripW = inkW + gap * 4;
    const startX = x + Math.floor((w - stripW) / 2);
    const slotY = y + 22;
    const states = slotStatesFor(deck);
    for (let i = 0; i < 5; i++) {
      drawSlotDigit(buf, startX + i * (digitW + gap), slotY, i + 1, states[i]);
    }
    // Position bar (placeholder — wire to real playhead later)
    const barY = y + 36;
    drawRect(buf, x, barY, w, 4);
  }

  function drawIdle(buf) {
    const meterStr = `${master.meter}/4`;
    renderTitleBar(buf, 'MASTER ' + Math.round(master.bpm), meterStr);
    const splitX = 64;
    drawVLine(buf, splitX, 11, 63);
    drawDeckColumn(buf, 1, 12, splitX - 2, 52, '1');
    drawDeckColumn(buf, splitX + 2, 12, 128 - splitX - 3, 52, '2');
  }

  function drawTouchPopup(buf) {
    if (touchKind === 'viz') drawVizPopup(buf);
    else if (touchKind === 'button') drawButtonPopup(buf);
    else if (touchKind === 'fader') drawFaderPopup(buf);
    else drawSinglePopup(buf);
  }

  // Canvas-based visualiser → bitmap. Each frame we wipe the canvas black,
  // call the chosen visualiser (which animates from `time`), then threshold
  // the canvas pixels into the OLED bitmap buffer.
  function drawVizPopup(buf) {
    if (!touchViz) return;
    vizCtx.fillStyle = '#000000';
    vizCtx.fillRect(0, 0, 128, 64);
    try {
      touchViz(vizCtx, performance.now() / 1000, touchVizVal);
    } catch (e) {
      console.warn('[lcxl3] visualiser threw', e);
    }
    Viz.rasterCanvasToOLEDBuffer(vizCanvas, buf);
  }

  // Mute/Solo press — single centred label, no value, no bar. Adds a thin
  // top + bottom rule for framing.
  function drawButtonPopup(buf) {
    drawHLine(buf, 0, 127, 0);
    drawHLine(buf, 0, 127, 63);
    const labW = measureText(touchLabel);
    const labX = Math.max(2, Math.floor((128 - labW) / 2));
    drawText(buf, touchLabel, labX, 28);
  }

  // Fader move — track name top, big value, rounded-corner horizontal bar.
  function drawFaderPopup(buf) {
    const labW = measureText(touchLabel);
    drawText(buf, touchLabel, Math.max(2, Math.floor((128 - labW) / 2)), 8);
    const num = String(touchValue);
    drawText(buf, num, Math.floor((128 - measureText(num) * 2) / 2), 24);
    drawText(buf, num, Math.floor((128 - measureText(num) * 2) / 2) + 1, 24);
    const barW = 110, barX = (128 - barW) / 2, barY = 44, barH = 12;
    drawRoundedRect(buf, barX, barY, barW, barH, 2);
    const fill = Math.round((barW - 4) * (touchValue / 127));
    if (fill > 0) fillRoundedRect(buf, barX + 2, barY + 2, fill, barH - 4, 1);
  }

  // Generic fallback — label centred, value below, rounded bar. No TOUCH banner.
  function drawSinglePopup(buf) {
    const labW = measureText(touchLabel);
    drawText(buf, touchLabel, Math.max(2, Math.floor((128 - labW) / 2)), 8);
    const numeric = touchSendAmount !== null ? touchSendAmount : touchValue;
    const v = String(numeric);
    drawText(buf, v, Math.floor((128 - measureText(v) * 2) / 2), 24);
    drawText(buf, v, Math.floor((128 - measureText(v) * 2) / 2) + 1, 24);
    const barW = 110, barX = (128 - barW) / 2, barY = 44, barH = 12;
    drawRoundedRect(buf, barX, barY, barW, barH, 2);
    const fill = Math.round((barW - 4) * (touchValue / 127));
    if (fill > 0) fillRoundedRect(buf, barX + 2, barY + 2, fill, barH - 4, 1);
  }

  // Tiny rounded-rect helpers on the bitmap buffer. `r` is the corner inset
  // (0 = square, 1 = soft, 2 = noticeably rounded). Suitable for r ≤ 3.
  function drawRoundedRect(buf, x, y, w, h, r) {
    drawHLine(buf, x + r, x + w - 1 - r, y);
    drawHLine(buf, x + r, x + w - 1 - r, y + h - 1);
    drawVLine(buf, x, y + r, y + h - 1 - r);
    drawVLine(buf, x + w - 1, y + r, y + h - 1 - r);
    // Diagonal nibble at each corner.
    for (let i = 0; i < r; i++) {
      setPixel(buf, x + r - i - 1, y + i);
      setPixel(buf, x + w - r + i, y + i);
      setPixel(buf, x + r - i - 1, y + h - 1 - i);
      setPixel(buf, x + w - r + i, y + h - 1 - i);
    }
  }
  function fillRoundedRect(buf, x, y, w, h, r) {
    for (let row = 0; row < h; row++) {
      let inset = 0;
      if (row < r) inset = r - row - 1;
      else if (row >= h - r) inset = r - (h - row);
      const startX = x + Math.max(0, inset);
      const endX = x + w - 1 - Math.max(0, inset);
      if (endX >= startX) drawHLine(buf, startX, endX, y + row);
    }
  }

  /* ─── LED palette ───
   * Per-column track colour for the three encoder rings. RGB values 0-127.
   * Picked to read bright on hardware (strips wash out anything <60). */
  const TRACK_COLOR = [
    [110, 110, 120], // 1 Drums   — light slate grey
    [127, 90, 30],   // 2 Bass    — warm orange
    [80, 60, 127],   // 3 Lead    — purple
    [40, 120, 110],  // 4 Poly 1  — cyan
    [127, 50, 105],  // 5 Poly 2  — pink
    [127, 70, 30],   // 6 FX 1    — burnt orange
    [115, 30, 95],   // 7 FX 2    — magenta
    [60, 40, 127],   // 8 FX 3    — indigo
  ];
  const SOLO_COLOR = [110, 110, 20];  // amber
  const MUTE_COLOR = [110, 30, 30];   // dim red

  // Row C dual-function send colours — used for HW tracks 1–5 only. CCW
  // (REVERB) glows teal, CW (DELAY) glows warm orange.
  const REV_COLOR = [30, 110, 110]; // teal — reverb wash
  const DLY_COLOR = [127, 70, 20];  // warm orange — delay throw

  // Row A bipolar filter colours — HW tracks 1–5 + master only. CCW (LP, cuts
  // highs, "warm/dark") glows deep amber; CW (HP, cuts lows, "thin/airy")
  // glows cool blue. Chosen to be visually distinct from Row C's teal/orange.
  const LP_COLOR = [127, 40, 10];   // deep amber-red — low pass: heavy, warm
  const HP_COLOR = [30, 80, 127];   // cool blue — high pass: bright, airy

  // Encoder LED intensity = current encValue / 127 against the column hue.
  // Idle (no input) sits at a low floor so the rig still reads "lit" at rest.
  const LED_FLOOR = 0.18;
  function scaleColor([r, g, b], k) {
    return [Math.round(r * k), Math.round(g * k), Math.round(b * k)];
  }
  // All three encoder rows are bipolar around centre (raw 64). LED is off in
  // the detent band, lights up scaled by distance from centre. Row C on HW
  // tracks 1–5 has direction-specific colours (REV teal CCW / DLY orange CW);
  // Rows A, B, and Row C on FX tracks 6–8 use the column's track colour.
  const DETENT_LO = 60, DETENT_HI = 68;
  function paintEncoderLED(row, col) {
    const ccBase = [13, 21, 29][row]; // ROW_A=13, ROW_B=21, ROW_C=29
    const cc = ccBase + col;
    const v = encValue[cc] ?? initialEncoderValue(cc);

    if (!isBipolarCC(cc)) {
      // Linear knob (FX sizes / times / decays / damps / feedback). Brightness
      // ramps 0 → full as the encoder moves CW from zero. Track colour.
      const k = Math.min(1, Math.max(0, v / 127));
      const [lr, lg, lb] = scaleColor(TRACK_COLOR[col], k);
      lcxl3.setEncoderLED(row, col, lr, lg, lb);
      return;
    }

    // Centre detent → LED off, no floor.
    if (v >= DETENT_LO && v <= DETENT_HI) {
      lcxl3.setEncoderLED(row, col, 0, 0, 0);
      return;
    }
    const sideK = v < DETENT_LO
      ? Math.min(1, (64 - v) / 64)
      : Math.min(1, (v - 64) / 63);
    let palette;
    if (row === 2 && col < 5) {
      // Row C HW tracks 1–5 — REV teal / DLY orange.
      palette = v < DETENT_LO ? REV_COLOR : DLY_COLOR;
    } else if ((row === 0 && isFilterCol(col)) || (row === 2 && col === 6)) {
      // Row A HW + master, or Row C FX 2 P3 (Delay Filter) — LP amber / HP blue.
      palette = v < DETENT_LO ? LP_COLOR : HP_COLOR;
    } else {
      // Row B pan and the master placeholders — column hue, bipolar brightness.
      palette = TRACK_COLOR[col];
    }
    const [r, g, b] = scaleColor(palette, sideK);
    lcxl3.setEncoderLED(row, col, r, g, b);
  }
  function paintAllEncoderLEDs() {
    for (let col = 0; col < 8; col++) {
      paintEncoderLED(0, col);
      paintEncoderLED(1, col);
      paintEncoderLED(2, col);
    }
  }
  // Strip buttons are visual toggles in VGM DJ. AUM owns the actual mute/solo
  // state via its own MIDI mappings; we just persist the local on/off so the
  // LED reads as a clear "active" indicator on the controller surface.
  const buttonToggle = new Map(); // cc → boolean
  function isToggleButton(cc) {
    return (cc >= 37 && cc <= 44) || (cc >= 45 && cc <= 52);
  }
  const BTN_OFF_LEVEL = 0.18; // dim "available" floor
  function paintButtonLED(cc) {
    const isSolo = cc >= 37 && cc <= 44;
    const base = isSolo ? SOLO_COLOR : MUTE_COLOR;
    const on = buttonToggle.get(cc) === true;
    const k = on ? 1.0 : BTN_OFF_LEVEL;
    const [r, g, b] = scaleColor(base, k);
    lcxl3.setButtonLED(cc, r, g, b);
  }
  function paintStripButtons() {
    for (let col = 0; col < 8; col++) {
      paintButtonLED(37 + col);
      paintButtonLED(45 + col);
    }
    console.log('[lcxl3] paintStripButtons → 16 strip toggles painted');
  }
  function paintLEDs() {
    paintAllEncoderLEDs();
    paintStripButtons();
  }
  paintLEDs();
  lcxl3.onConnect(() => paintLEDs());

  // Debug helper exposed on window — call from devtools to probe LED indices.
  // Usage: lcxl3Debug.setRaw(0x29, 127, 0, 0)  // try lighting LED index 0x29 red
  //        lcxl3Debug.sweep()                   // cycle every plausible index for 1s
  //        lcxl3Debug.list()                    // dump the SOLO/MUTE indices we're using
  window.lcxl3Debug = {
    driver: lcxl3,
    setRaw(index, r, g, b) {
      lcxl3._setLED(index, r, g, b);
      console.log(`[lcxl3Debug] _setLED(0x${index.toString(16)}, ${r}, ${g}, ${b})`);
    },
    sweep(startIdx = 0x00, endIdx = 0x60, dwellMs = 250) {
      let i = startIdx;
      const tick = () => {
        if (i > endIdx) return;
        console.log(`[lcxl3Debug] sweep index 0x${i.toString(16)}`);
        lcxl3._setLED(i, 127, 127, 0); // bright yellow — easy to spot
        setTimeout(() => lcxl3._setLED(i, 0, 0, 0), dwellMs - 50);
        i++;
        setTimeout(tick, dwellMs);
      };
      tick();
    },
    list() {
      console.log('SOLO_ARM CCs 37-44, MUTE_SELECT CCs 45-52');
      console.log('LED indices (post-PDF fix): SOLO 0x25-0x2C, MUTE 0x2D-0x34');
    },
    // Light every strip button bright for 3 seconds — visual sanity check
    // that the SysEx is reaching the device. If nothing lights, the indices
    // are still wrong or the device isn't in DAW Control sub-mode.
    testButtons() {
      console.log('[lcxl3Debug] lighting strip buttons bright for 3s…');
      for (let i = 0x25; i <= 0x34; i++) lcxl3._setLED(i, 127, 127, 127);
      setTimeout(() => {
        for (let i = 0x25; i <= 0x34; i++) lcxl3._setLED(i, 0, 0, 0);
        paintLEDs();
      }, 3000);
    },
    // Verbose MIDI-in trace — every byte the device sends gets logged.
    trace(on = true) { lcxl3.setMidiInTrace(on); console.log(`[lcxl3Debug] MIDI-in trace ${on ? 'ON' : 'OFF'}`); },
  };

  /* ─── Paint loop ─── */
  function paint() {
    const buf = createBitmapBuffer();
    if (Date.now() < touchUntil) drawTouchPopup(buf);
    else drawIdle(buf);
    lcxl3.renderBitmap(buf);
    requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);

  console.log('[lcxl3] integration mounted — connect the LCXL3 + allow Web MIDI to drive hardware');
}
