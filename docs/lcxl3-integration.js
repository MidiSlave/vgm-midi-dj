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
  function applyRelative(cc, raw) {
    let delta;
    if (raw >= 1 && raw <= 63) delta = raw;
    else if (raw >= 64 && raw <= 95) delta = -(raw - 64);
    else if (raw >= 96 && raw <= 127) delta = raw - 128;
    else delta = 0;
    if (encValue[cc] === undefined) encValue[cc] = 64;
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
  let touchKind = 'single';
  let touchLabel = '', touchValue = 0;
  let touchSendAmount = null; // 0..100 numeric for REV/DLY popups (overrides touchValue text)
  let touchCol = 0;           // column index 0-7 for filter / pan popups
  let touchFilterPos = 64;    // 0..127 absolute encoder position for filter popup
  let touchPanPos = 64;       // 0..127 absolute encoder position for pan popup
  // dualSend tracks which side (REV or DLY) was last engaged so the popup
  // stays stable through a centre-detent crossing instead of swapping at zero.
  const sendSide = {}; // trackIdx → 'REV' | 'DLY'

  /* ─── 8-column track model ─── */
  // Columns 0-4 are HW synth tracks, 5 is FX 1 (reverb), 6 is FX 2 (delay),
  // 7 is the MASTER bus (HP/LP filter on Row A; B + C unassigned for now).
  const TRACK_NAMES = ['DRUMS', 'BASS', 'LEAD', 'POLY 1', 'POLY 2', 'FX 1', 'FX 2', 'MASTER'];
  const HW_COLS = new Set([0, 1, 2, 3, 4]);
  const MASTER_COL = 7;
  function isFilterCol(col) { return HW_COLS.has(col) || col === MASTER_COL; }

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
      // Row C: bipolar REV/DLY for HW tracks, FX P3 for cols 5/6, unassigned on master.
      const col = cc - 29;
      if (HW_COLS.has(col)) {
        if (value < DETENT_LO) return `${TRACK_NAMES[col]} REV`;
        if (value > DETENT_HI) return `${TRACK_NAMES[col]} DLY`;
        return `${TRACK_NAMES[col]} SEND ·`;
      }
      if (col === 5) return 'REV DAMP';
      if (col === 6) return 'DLY FLT';
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
  const DLY_CC_BASE = 53;                    // Row C DLY CCs 53-57 for HW tracks 1-5 (CCW = REV native CC, CW = DLY here)
  const HP_HW_CC_BASE = 85;                  // Row A HP CCs 85-89 for HW tracks 1-5 (CCW = LP native CC, CW = HP here)
  const HP_MASTER_CC = 90;                   // Row A HP CC for master column
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
    // instead of the LCXL3's relative-encoder ticks. Two knobs need bipolar
    // splits because the CCW and CW sides drive different plugin parameters:
    //   - Row A on HW tracks 1-5 + master → LP cutoff (native CC) / HP cutoff (85-89, 90)
    //   - Row C on HW tracks 1-5         → REV send (native CC) / DLY send (53-57)
    // We always emit both sides so the released side returns to 0 when the
    // user crosses the centre detent.
    if (cc >= 5 && cc <= 12) {
      // Faders — single absolute (per-track volume).
      rebroadcast(cc, absolute);
    } else if (cc >= 13 && cc <= 20) {
      // Row A — filter (bipolar LP/HP) for HW tracks + master; absolute for FX.
      const col = cc - 13;
      if (isFilterCol(col)) {
        const [lp, hp] = bipolarSides(absolute);
        rebroadcast(cc, lp);
        rebroadcast(col === MASTER_COL ? HP_MASTER_CC : (HP_HW_CC_BASE + col), hp);
      } else {
        rebroadcast(cc, absolute);
      }
    } else if (cc >= 21 && cc <= 28) {
      // Row B — pan (HW tracks) / FX P2 (cols 5/6) / unassigned (master). Single CC.
      rebroadcast(cc, absolute);
    } else if (cc >= 29 && cc <= 36) {
      // Row C — REV/DLY split (HW tracks) / FX P3 / unassigned (master).
      const col = cc - 29;
      if (HW_COLS.has(col)) {
        const [rev, dly] = bipolarSides(absolute);
        rebroadcast(cc, rev);
        rebroadcast(DLY_CC_BASE + col, dly);
      } else {
        rebroadcast(cc, absolute);
      }
    }
    // Pick the right popup kind: filter (Row A HW + master), pan (Row B HW),
    // send (Row C HW), or plain single bar (everything else).
    const rowAIdx = cc - 13;
    const rowBIdx = cc - 21;
    const rowCIdx = cc - 29;
    if (cc >= 13 && cc <= 20 && isFilterCol(rowAIdx)) {
      // Row A filter — bipolar LP / HP, with a passband animation.
      touchKind = 'filter';
      touchCol = rowAIdx;
      touchFilterPos = absolute;
      touchLabel = labelForCC(cc, absolute);
      touchValue = absolute;
      touchSendAmount = null;
    } else if (cc >= 21 && cc <= 25) {
      // Row B HW tracks 1-5 — pan animation.
      touchKind = 'pan';
      touchCol = rowBIdx;
      touchPanPos = absolute;
      touchLabel = labelForCC(cc, absolute);
      touchValue = absolute;
      touchSendAmount = null;
    } else if (cc >= 29 && cc <= 33) {
      // Row C HW — bipolar REV/DLY (existing single bar with side label).
      const trackIdx = rowCIdx;
      let side = sendSide[trackIdx];
      let amount = 0;
      if (absolute < DETENT_LO) {
        side = 'REV';
        amount = Math.round(((64 - absolute) / 64) * 100);
      } else if (absolute > DETENT_HI) {
        side = 'DLY';
        amount = Math.round(((absolute - 64) / 63) * 100);
      } else {
        if (!side) side = 'REV';
        amount = 0;
      }
      sendSide[trackIdx] = side;
      touchKind = 'single';
      touchLabel = `${TRACK_NAMES[trackIdx]} ${side}`;
      touchValue = Math.round(amount * 1.27);
      touchSendAmount = amount;
    } else {
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
    const label = labelForButton(cc);
    if (label) {
      touchKind = 'single';
      touchLabel = label + (isToggleButton(cc) ? (buttonToggle.get(cc) ? ' ON' : ' OFF') : '');
      touchValue = 127;
      touchUntil = Date.now() + 900;
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
    if (touchKind === 'filter') drawFilterPopup(buf);
    else if (touchKind === 'pan') drawPanPopup(buf);
    else drawSinglePopup(buf);
  }

  function drawSinglePopup(buf) {
    renderTitleBar(buf, 'TOUCH', '');
    const labW = measureText(touchLabel);
    const labX = Math.max(2, Math.floor((128 - labW) / 2));
    drawText(buf, touchLabel, labX, 14);
    // Numeric readout — 0..100 for REV/DLY sends, raw 0..127 for everything else.
    const numeric = touchSendAmount !== null ? touchSendAmount : touchValue;
    const v = String(numeric);
    drawText(buf, v, Math.floor((128 - measureText(v) * 2) / 2), 26);
    drawText(buf, v, Math.floor((128 - measureText(v) * 2) / 2) + 1, 26);
    const barW = 110;
    const barX = (128 - barW) / 2;
    drawRect(buf, barX, 40, barW, 8);
    const fill = Math.round((barW - 2) * (touchValue / 127));
    if (fill > 0) fillRect(buf, barX + 1, 41, fill, 6);
  }

  /* ─── Filter popup ───
   * Bipolar LP / HP visualisation. The OLED shows a passband rectangle that
   * shrinks from the right (LP, cuts highs) or from the left (HP, cuts lows).
   * Centre detent = full passband (flat). Label flips LP ↔ HP across centre. */
  function drawFilterPopup(buf) {
    renderTitleBar(buf, 'FILTER', '');
    const labW = measureText(touchLabel);
    drawText(buf, touchLabel, Math.max(2, Math.floor((128 - labW) / 2)), 13);

    // Frequency axis spans 12..115. Centre line at y=33; passband rect from
    // y=23 (top of band) to y=33 (axis). Below that is a thin frequency axis.
    const fxL = 12, fxR = 115;
    const fxTop = 23, fxAxis = 33;
    drawHLine(buf, fxL, fxR, fxAxis);
    // Faint tick marks at L / mid / R to anchor the eye.
    setPixel(buf, fxL, fxAxis - 1); setPixel(buf, fxL, fxAxis + 1);
    setPixel(buf, fxR, fxAxis - 1); setPixel(buf, fxR, fxAxis + 1);
    setPixel(buf, Math.floor((fxL + fxR) / 2), fxAxis - 1);
    setPixel(buf, Math.floor((fxL + fxR) / 2), fxAxis + 1);

    const v = touchFilterPos;
    const width = fxR - fxL;
    let bandL = fxL, bandR = fxR;
    if (v < DETENT_LO) {
      // LP: passband retreats from the right edge.
      const k = Math.min(1, (64 - v) / 64);
      bandR = fxR - Math.round(width * k);
    } else if (v > DETENT_HI) {
      // HP: passband retreats from the left edge.
      const k = Math.min(1, (v - 64) / 63);
      bandL = fxL + Math.round(width * k);
    }
    if (bandR > bandL) fillRect(buf, bandL, fxTop, bandR - bandL + 1, fxAxis - fxTop);

    // Cutoff marker — a small downward triangle just above the axis on the
    // edge the passband is being eaten from.
    if (v < DETENT_LO) drawCutoffMarker(buf, bandR, fxAxis - 1, 'left');
    else if (v > DETENT_HI) drawCutoffMarker(buf, bandL, fxAxis - 1, 'right');

    // Side + 0..100 amount as the numeric. Reuse drawSinglePopup's footer bar.
    const sideAmount = v < DETENT_LO
      ? Math.round((64 - v) / 64 * 100)
      : v > DETENT_HI
        ? Math.round((v - 64) / 63 * 100)
        : 0;
    const numStr = String(sideAmount);
    const numX = Math.floor((128 - measureText(numStr)) / 2);
    drawText(buf, numStr, numX, 42);

    // Bipolar bar at the bottom showing distance from centre.
    const barW = 110;
    const barX = (128 - barW) / 2;
    const barY = 53;
    drawRect(buf, barX, barY, barW, 8);
    const mid = barX + Math.floor(barW / 2);
    if (v < DETENT_LO) {
      const fill = Math.round((barW / 2 - 1) * (64 - v) / 64);
      if (fill > 0) fillRect(buf, mid - fill, barY + 1, fill, 6);
    } else if (v > DETENT_HI) {
      const fill = Math.round((barW / 2 - 1) * (v - 64) / 63);
      if (fill > 0) fillRect(buf, mid + 1, barY + 1, fill, 6);
    }
    // Centre tick on the bar.
    drawVLine(buf, mid, barY - 1, barY + 9);
  }

  function drawCutoffMarker(buf, x, y, side) {
    // Tiny 3-pixel triangle. `side` is which side of x the body sits on.
    setPixel(buf, x, y);
    if (side === 'left') {
      setPixel(buf, x - 1, y - 1);
      setPixel(buf, x - 2, y - 2);
    } else {
      setPixel(buf, x + 1, y - 1);
      setPixel(buf, x + 2, y - 2);
    }
  }

  /* ─── Pan popup ───
   * Horizontal stereo field with an L/R marker. Centre = dead-centre dot;
   * off-centre = marker slides + a filled bar grows from centre outward. */
  function drawPanPopup(buf) {
    renderTitleBar(buf, 'PAN', '');
    const labW = measureText(touchLabel);
    drawText(buf, touchLabel, Math.max(2, Math.floor((128 - labW) / 2)), 13);

    // Field spans 14..113 with end-cap labels L / R sitting outside.
    const fL = 14, fR = 113;
    const axisY = 30;
    drawText(buf, 'L', 4, axisY - 3);
    drawText(buf, 'R', 119, axisY - 3);
    drawHLine(buf, fL, fR, axisY);
    // Tick marks at L / mid / R.
    const mid = Math.floor((fL + fR) / 2);
    setPixel(buf, fL, axisY - 2); setPixel(buf, fL, axisY + 2);
    setPixel(buf, fR, axisY - 2); setPixel(buf, fR, axisY + 2);
    setPixel(buf, mid, axisY - 2); setPixel(buf, mid, axisY + 2);

    // Position marker — solid 5×5 block centred on the pan position.
    const v = touchPanPos;
    const t = Math.max(0, Math.min(127, v)) / 127;
    const markerX = Math.round(fL + (fR - fL) * t);
    fillRect(buf, markerX - 2, axisY - 2, 5, 5);

    // Bias bar from centre outward — visual of how far off-centre.
    const barW = 110;
    const barX = (128 - barW) / 2;
    const barY = 53;
    drawRect(buf, barX, barY, barW, 8);
    const barMid = barX + Math.floor(barW / 2);
    drawVLine(buf, barMid, barY - 1, barY + 9);
    if (v < 64) {
      const fill = Math.round((barW / 2 - 1) * (64 - v) / 64);
      if (fill > 0) fillRect(buf, barMid - fill, barY + 1, fill, 6);
    } else if (v > 64) {
      const fill = Math.round((barW / 2 - 1) * (v - 64) / 63);
      if (fill > 0) fillRect(buf, barMid + 1, barY + 1, fill, 6);
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
    const v = encValue[cc] ?? 64; // rest at centre — all knobs are bipolar
    // Centre detent → LED off, no floor.
    if (v >= DETENT_LO && v <= DETENT_HI) {
      lcxl3.setEncoderLED(row, col, 0, 0, 0);
      return;
    }
    let r, g, b;
    const sideK = v < DETENT_LO
      ? Math.min(1, (64 - v) / 64)
      : Math.min(1, (v - 64) / 63);
    if (row === 2 && col < 5) {
      // Row C HW tracks 1–5 — direction-coloured REV/DLY.
      [r, g, b] = scaleColor(v < DETENT_LO ? REV_COLOR : DLY_COLOR, sideK);
    } else if (row === 0 && isFilterCol(col)) {
      // Row A HW tracks 1–5 + master — direction-coloured LP/HP.
      [r, g, b] = scaleColor(v < DETENT_LO ? LP_COLOR : HP_COLOR, sideK);
    } else {
      // Track colour, brightness = distance from centre.
      [r, g, b] = scaleColor(TRACK_COLOR[col], sideK);
    }
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
