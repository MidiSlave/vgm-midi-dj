// ──────────────────────────────────────────────────────────────
// Hardware outputs — channel index → name
// ──────────────────────────────────────────────────────────────
const SYNTHS = {
  0: 'Juno 106',
  1: 'SH-01A',
  2: 'Bass Stn 2',
  3: 'Keytar',
  9: 'TR-08',
};

// Representative GM patches used in preview mode for each hardware output.
// Channel 9 = GM drum kit (auto). Picks roughly match each synth's role.
const GM_PREVIEW_PATCH = {
  0: 89, // Warm Pad      — Juno 106 (pads/chords)
  1: 81, // Sawtooth Lead — SH-01A (leads/arps)
  2: 38, // Synth Bass 1  — Bass Station 2
  3: 80, // Square Lead   — Roland Keytar
};

// Hardware outputs that are physically monophonic — the dispatcher must
// note-off any active note on these before sending a new note-on.
const MONO_OUTPUTS = new Set([1, 2]); // SH-01A (lead), Bass Station 2

const GM_TO_TR08 = {
  35: 36, 36: 36, 37: 37, 38: 38, 39: 39, 40: 38,
  41: 43, 42: 42, 43: 43, 44: 42, 45: 47, 46: 46,
  47: 47, 48: 50, 49: 49, 50: 50, 51: 49, 52: 49,
  53: 49, 54: 42, 55: 49, 56: 56, 57: 49, 62: 62, 63: 62, 64: 64,
};

// ──────────────────────────────────────────────────────────────
// Custom widgets — no native sliders/selects/checkboxes
// ──────────────────────────────────────────────────────────────

function mountSlider(el, { onInput }) {
  const min = parseFloat(el.dataset.min ?? 0);
  const max = parseFloat(el.dataset.max ?? 100);
  let value = parseFloat(el.dataset.value ?? min);

  el.innerHTML = `
    <div class="cslider-track">
      <div class="cslider-fill"></div>
      <div class="cslider-thumb"></div>
    </div>
  `;
  const fill = el.querySelector('.cslider-fill');
  const thumb = el.querySelector('.cslider-thumb');

  const paint = () => {
    const pct = ((value - min) / (max - min)) * 100;
    fill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
  };

  const setFromPointer = (clientX) => {
    const rect = el.querySelector('.cslider-track').getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const newVal = Math.round(min + pct * (max - min));
    if (newVal !== value) {
      value = newVal;
      paint();
      onInput?.(value);
    }
  };

  let pointerId = null;
  el.addEventListener('pointerdown', (e) => {
    pointerId = e.pointerId;
    el.setPointerCapture(pointerId);
    el.classList.add('dragging');
    setFromPointer(e.clientX);
  });
  el.addEventListener('pointermove', (e) => {
    if (pointerId !== null) setFromPointer(e.clientX);
  });
  el.addEventListener('pointerup', () => {
    if (pointerId !== null) el.releasePointerCapture(pointerId);
    pointerId = null;
    el.classList.remove('dragging');
  });
  el.addEventListener('pointercancel', () => {
    pointerId = null;
    el.classList.remove('dragging');
  });

  paint();
  return {
    setValue(v) { value = Math.max(min, Math.min(max, v)); paint(); },
    getValue() { return value; },
  };
}

function mountDropdown(mountEl, { options, value, onChange, placeholder, className = '' }) {
  const root = document.createElement('div');
  root.className = `cdropdown ${className}`;

  const button = document.createElement('button');
  button.className = 'cdropdown-button';
  button.type = 'button';
  button.innerHTML = `<span class="cdropdown-value"></span><span class="cdropdown-caret">▾</span>`;

  const menu = document.createElement('ul');
  menu.className = 'cdropdown-menu';
  menu.hidden = true;

  root.appendChild(button);
  root.appendChild(menu);
  mountEl.replaceWith(root);
  root.id = mountEl.id;

  const valueEl = button.querySelector('.cdropdown-value');
  let current = value;

  const render = () => {
    menu.innerHTML = '';
    for (const opt of options) {
      const li = document.createElement('li');
      li.textContent = opt.label;
      li.dataset.value = opt.value;
      if (opt.value === current) li.classList.add('selected');
      li.addEventListener('click', () => {
        current = opt.value;
        const found = options.find(o => o.value === current);
        valueEl.textContent = found?.label ?? placeholder ?? '';
        menu.querySelectorAll('li').forEach(n => {
          n.classList.toggle('selected', n.dataset.value === String(current));
        });
        close();
        onChange?.(current);
      });
      menu.appendChild(li);
    }
    const found = options.find(o => String(o.value) === String(current));
    valueEl.textContent = found?.label ?? placeholder ?? '';
  };

  const open = () => {
    root.classList.add('open');
    menu.hidden = false;
  };
  const close = () => {
    root.classList.remove('open');
    menu.hidden = true;
  };
  const toggle = () => (root.classList.contains('open') ? close() : open());

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) close();
  });

  render();
  return {
    setOptions(newOpts) { options = newOpts; render(); },
    setValue(v) {
      current = v;
      const f = options.find(o => String(o.value) === String(v));
      valueEl.textContent = f?.label ?? placeholder ?? '';
    },
    getValue() { return current; },
    el: root,
  };
}

function mountToggle(el, { onChange, initial = false }) {
  let on = initial;
  const sync = () => el.setAttribute('aria-checked', String(on));
  sync();
  el.addEventListener('click', async () => {
    on = !on;
    sync();
    await onChange?.(on);
  });
  return {
    isOn() { return on; },
    set(v) { on = v; sync(); },
  };
}

// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────
let midiOutput = null;
let testMode = false;
let testSynth = null;

// 'a' | 'both' | 'b' — A/B switch (binary mute, no fade)
let mixState = 'both';

// Tracks which deck (if any) is currently CUE-soloed
let cuedDeck = null;

const decks = {
  a: makeDeckState('a'),
  b: makeDeckState('b'),
};

function makeDeckState(id) {
  return {
    id, midi: null, playing: false, timer: null,
    volume: 100, pitch: 1.0,
    transpose: 0, // semitones; drums (ch9) are skipped
    routing: {}, meta: null,
    activeNotes: new Map(), // key "outCh:note" → natural endTick (or null)
    tailTimers: new Map(),  // key → setTimeout id for deferred noteOff after loop wrap
    outputMute: new Set(),  // output channel indices currently muted
    dropTimer: null,
    dropPending: false,
    seekTimer: null,
    seekPending: null, // tick the playhead will jump to at the next bar of this deck
    // playback transport (live state for visualisation)
    currentTick: 0,
    currentBPM: 120,
    currentMsPerTick: 4,
    lastEventWallTime: 0,
    lastEventTick: 0,
    // visualisation
    rollData: null,        // {notes, maxTick, minNote, maxNote}
    rollOffscreen: null,   // pre-rendered notes canvas
    rollView: { zoom: 1, offset: 0 }, // zoom ∈ [1, 50]; offset ∈ [0, 1 - 1/zoom]
    // loop
    loop: { in: null, out: null, active: false, beats: null, pendingExit: false },
  };
}

// Channel colour palette for the piano roll (matches across decks for consistency)
const CHANNEL_COLORS = [
  '#5ce0d0', '#9b8cff', '#ffb86c', '#ff79c6',
  '#7dd87d', '#f1fa8c', '#8be9fd', '#bd93f9',
  '#50fa7b', '#7a8094', // ch 9 = drums (grey)
  '#ffb86c', '#ff6e6e', '#9b8cff', '#5ce0d0', '#ff79c6', '#ffb86c',
];

let trackLibrary = [];

// ──────────────────────────────────────────────────────────────
// Master transport — independent clock used as reference for quantised drops
// ──────────────────────────────────────────────────────────────
const master = {
  bpm: 120,
  meter: 4,                       // numerator (beats per bar)
  beatOneAt: performance.now(),   // wall-clock time of last beat-1
  tapTimes: [],
  autoSet: false,                 // true once first loaded track has anchored master.bpm
};

function getMasterPosition() {
  const beatSec = 60 / master.bpm;
  const elapsed = (performance.now() - master.beatOneAt) / 1000;
  const totalBeats = elapsed / beatSec;
  const beatIdx = ((Math.floor(totalBeats) % master.meter) + master.meter) % master.meter;
  const phase = totalBeats - Math.floor(totalBeats);
  return { beat: beatIdx + 1, phase, beatSec };
}

function msUntilNextDownbeat() {
  const beatSec = 60 / master.bpm;
  const elapsed = (performance.now() - master.beatOneAt) / 1000;
  const totalBeats = elapsed / beatSec;
  const beatsUntilDown = master.meter - ((totalBeats % master.meter + master.meter) % master.meter);
  return beatsUntilDown * beatSec * 1000;
}

function setMasterBpm(bpm) {
  bpm = Math.max(20, Math.min(240, Math.round(bpm)));
  if (bpm === master.bpm) return;
  master.bpm = bpm;
  for (const id of ['a', 'b']) syncDeckToMaster(id);
  document.getElementById('master-bpm-value').textContent = bpm;
  // Re-anchor beat-1 so it stays phase-locked: prefer the playing deck if there
  // is one (alignment to musical content), otherwise preserve the visual phase
  // so the master counter doesn't appear to jump.
  const playingId = decks.a.playing ? 'a' : (decks.b.playing ? 'b' : null);
  if (playingId) {
    anchorMasterToDeck(playingId, getLivePlaybackTick(decks[playingId]));
  } else {
    const pos = getMasterPosition();
    master.beatOneAt = performance.now() - ((pos.beat - 1) + pos.phase) * (60000 / bpm);
  }
}

function syncDeckToMaster(deckId) {
  const deck = decks[deckId];
  if (!deck.meta?.perceived_bpm) {
    deck.pitch = 1;
    return;
  }
  deck.pitch = master.bpm / deck.meta.perceived_bpm;
  updateBpmDisplay(deckId);
}

function masterReset() {
  master.beatOneAt = performance.now();
  updateMasterBeatDots(true);
}

// Anchor master beat-1 to a specific deck's tick position so the beat counter
// stays phase-locked to that deck's perceived beats. Called on play and drop.
function anchorMasterToDeck(deckId, deckTick) {
  const deck = decks[deckId];
  if (!deck.midi) return;
  const tpb = getDeckTicksPerBeat(deck);
  const beatsIntoTrack = deckTick / tpb;
  // At master tempo, those beats took this long in real time
  const msIntoTrack = beatsIntoTrack * (60000 / master.bpm);
  master.beatOneAt = performance.now() - msIntoTrack;
}

function masterTapTempo() {
  const now = performance.now();
  master.tapTimes = master.tapTimes.filter(t => now - t < 2500);
  master.tapTimes.push(now);
  if (master.tapTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < master.tapTimes.length; i++) {
      intervals.push(master.tapTimes[i] - master.tapTimes[i - 1]);
    }
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const newBpm = Math.round(60000 / avgMs);
    if (newBpm >= 20 && newBpm <= 240) {
      setMasterBpm(newBpm);
      // Anchor beat 1 onto this tap so the visual aligns with what the user is feeling
      master.beatOneAt = now;
      if (masterBpmSlider) masterBpmSlider.setValue(newBpm);
    }
  }
}

let masterBpmSlider = null;

function buildMasterBeatDots() {
  const root = document.getElementById('master-beat');
  if (!root) return;
  root.innerHTML = '';
  for (let i = 0; i < master.meter; i++) {
    const d = document.createElement('div');
    d.className = 'beat-dot' + (i === 0 ? ' downbeat' : '');
    root.appendChild(d);
  }
}

let lastShownBeat = -1;
function updateMasterBeatDots(force = false) {
  const { beat } = getMasterPosition();
  if (!force && beat === lastShownBeat) return;
  lastShownBeat = beat;
  const dots = document.querySelectorAll('#master-beat .beat-dot');
  dots.forEach((d, i) => d.classList.toggle('on', i === beat - 1));
}

function startMasterClock() {
  const tick = () => {
    updateMasterBeatDots();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ──────────────────────────────────────────────────────────────
// Audio: GM preview synth
// ──────────────────────────────────────────────────────────────
function getTestSynth() {
  if (testSynth) return testSynth;
  if (typeof WebAudioTinySynth === 'undefined') {
    console.error('WebAudioTinySynth not loaded');
    return null;
  }
  testSynth = new WebAudioTinySynth({ quality: 1, useReverb: 1, voices: 64 });
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (typeof testSynth.setAudioContext === 'function') {
      testSynth.setAudioContext(ctx, ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    testSynth._ctx = ctx;
  } catch (err) {
    console.error('AudioContext init failed:', err);
  }
  return testSynth;
}

async function unlockTestSynth() {
  const synth = getTestSynth();
  if (!synth) return;
  const ctx = synth._ctx;
  if (ctx?.state === 'suspended') {
    try { await ctx.resume(); } catch (e) { console.error(e); }
  }
  // Program the representative patches now
  for (const [ch, prog] of Object.entries(GM_PREVIEW_PATCH)) {
    synth.send([0xc0 | parseInt(ch), prog]);
  }
  // Audible confirmation: short C-major chord on pad
  synth.send([0x90, 60, 80]);
  synth.send([0x90, 64, 80]);
  synth.send([0x90, 67, 80]);
  setTimeout(() => {
    synth.send([0x80, 60, 0]);
    synth.send([0x80, 64, 0]);
    synth.send([0x80, 67, 0]);
  }, 300);
}

// ──────────────────────────────────────────────────────────────
// MIDI plumbing
// ──────────────────────────────────────────────────────────────
async function initMIDI() {
  const port = document.getElementById('midi-port');
  const status = document.getElementById('midi-status');
  if (!navigator.requestMIDIAccess) {
    port.textContent = 'no Web MIDI';
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    const pickFirst = () => {
      const outs = [...access.outputs.values()];
      if (outs.length) {
        midiOutput = outs[0];
        port.textContent = midiOutput.name;
        status.classList.add('ok');
      } else {
        midiOutput = null;
        port.textContent = 'no midi out';
        status.classList.remove('ok');
      }
    };
    pickFirst();
    access.onstatechange = pickFirst;
  } catch (err) {
    port.textContent = `err: ${err.message}`;
  }
}

function sendRaw(status, data1, data2) {
  const msg = data2 !== undefined ? [status, data1, data2] : [status, data1];
  if (testMode) {
    const synth = getTestSynth();
    if (synth) synth.send(msg);
  } else if (midiOutput) {
    midiOutput.send(msg);
  }
}

function flashRoutingPill(deckId, outCh) {
  const pill = document.querySelector(`.routing-pill[data-deck="${deckId}"][data-out="${outCh}"]`);
  if (!pill) return;
  pill.classList.add('active');
  setTimeout(() => pill.classList.remove('active'), 90);
}

// ──────────────────────────────────────────────────────────────
// Mix state — which decks are audible
// ──────────────────────────────────────────────────────────────
function deckAudible(deckId) {
  if (cuedDeck) return cuedDeck === deckId; // CUE solos
  if (mixState === 'both') return true;
  return mixState === deckId;
}

function setMixState(state) {
  if (state === mixState) return;
  const losing = (mixState === 'both') ? [state === 'a' ? 'b' : 'a'] :
                 (state === 'both') ? [] : [mixState];
  mixState = state;
  for (const d of losing) silenceDeck(d);
  document.querySelectorAll('.mix-pos').forEach(b => {
    b.classList.toggle('active', b.dataset.state === state);
  });
}

function setCue(deckId, on) {
  if (on) {
    if (cuedDeck && cuedDeck !== deckId) silenceDeck(cuedDeck);
    cuedDeck = deckId;
    // Silence the OTHER deck while cued
    const other = deckId === 'a' ? 'b' : 'a';
    silenceDeck(other);
  } else {
    if (cuedDeck === deckId) {
      cuedDeck = null;
      // Re-evaluate: silence anything no longer audible
      for (const d of ['a', 'b']) if (!deckAudible(d)) silenceDeck(d);
    }
  }
  document.querySelectorAll('.btn-cue').forEach(b => {
    b.classList.toggle('cued', b.dataset.deck === cuedDeck);
  });
}

// ──────────────────────────────────────────────────────────────
// Note dispatch — applies routing + mix state + drum remap
// ──────────────────────────────────────────────────────────────
function dispatchEvent(ev, deck) {
  if (ev.channel === undefined) return;
  const outCh = deck.routing[ev.channel];
  if (outCh === undefined || outCh < 0) return; // unmapped or muted

  // Apply transpose to pitched channels only (skip drum routing)
  let note = ev.note;
  if (ev.channel !== 9 && outCh !== 9 && deck.transpose) {
    note = Math.max(0, Math.min(127, note + deck.transpose));
  }

  if (ev.type === 'noteOn') {
    if (!deckAudible(deck.id)) return; // drop noteOn when deck muted by mix switch
    if (deck.outputMute.has(outCh)) return; // pill-muted output — drop noteOn, allow noteOff
    const vel = Math.min(127, Math.round(ev.velocity * (deck.volume / 100)));
    if (!testMode && outCh === 9) note = GM_TO_TR08[note] || note;
    const key = `${outCh}:${note}`;
    // Cancel any pending tail noteOff for this key so it doesn't kill the new note
    const pending = deck.tailTimers.get(key);
    if (pending) { clearTimeout(pending); deck.tailTimers.delete(key); }
    // Mono outputs (e.g. Bass Station 2): silence any other note already sounding
    // on this output before triggering the new one, so the synth doesn't choke.
    if (MONO_OUTPUTS.has(outCh)) {
      const prefix = `${outCh}:`;
      for (const activeKey of [...deck.activeNotes.keys()]) {
        if (activeKey.startsWith(prefix) && activeKey !== key) {
          const prevNote = Number(activeKey.slice(prefix.length));
          sendRaw(0x80 | outCh, prevNote, 0);
          deck.activeNotes.delete(activeKey);
          const tail = deck.tailTimers.get(activeKey);
          if (tail) { clearTimeout(tail); deck.tailTimers.delete(activeKey); }
        }
      }
    }
    sendRaw(0x90 | outCh, note, vel);
    deck.activeNotes.set(key, ev.endTick ?? null);
    flashRoutingPill(deck.id, outCh);
  } else if (ev.type === 'noteOff') {
    if (!testMode && outCh === 9) note = GM_TO_TR08[note] || note;
    sendRaw(0x80 | outCh, note, 0);
    deck.activeNotes.delete(`${outCh}:${note}`);
  }
  // programChange from the source is ignored — output patches are fixed per hardware target
}

function silenceDeck(deckId) {
  const deck = decks[deckId];
  for (const [key] of deck.activeNotes) {
    const [outCh, note] = key.split(':').map(Number);
    sendRaw(0x80 | outCh, note, 0);
  }
  deck.activeNotes.clear();
  // Cancel any pending tail noteOffs from a prior loop wrap
  for (const t of deck.tailTimers.values()) clearTimeout(t);
  deck.tailTimers.clear();
  // All-notes-off CC on every output channel this deck uses
  const outs = new Set(Object.values(deck.routing).filter(v => v >= 0));
  for (const ch of outs) sendRaw(0xb0 | ch, 123, 0);
}

function silenceAll() {
  silenceDeck('a');
  silenceDeck('b');
  const all = testMode ? [0, 1, 2, 3, 9] : [0, 1, 2, 3, 9];
  for (const ch of all) sendRaw(0xb0 | ch, 123, 0);
}

// ──────────────────────────────────────────────────────────────
// MIDI parsing — runs in a Web Worker so loading a track on one deck
// can't stall the playing deck's setTimeout-driven scheduler.
// ──────────────────────────────────────────────────────────────
let midiWorker = null;
let nextWorkerReqId = 0;
const workerRequests = new Map();

function getMidiWorker() {
  if (midiWorker) return midiWorker;
  midiWorker = new Worker('midi-worker.js');
  midiWorker.onmessage = (e) => {
    const { id, midi, rollData, error } = e.data;
    const req = workerRequests.get(id);
    if (!req) return;
    workerRequests.delete(id);
    if (error) req.reject(new Error(error));
    else req.resolve({ midi, rollData });
  };
  midiWorker.onerror = (err) => {
    console.error('midi worker error', err);
  };
  return midiWorker;
}

function parseInWorker(buffer) {
  const worker = getMidiWorker();
  const id = ++nextWorkerReqId;
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject });
    worker.postMessage({ id, buffer }, [buffer]);
  });
}

const yieldToMain = () => new Promise(r => setTimeout(r, 0));

function getChannelsUsed(midi) {
  const channels = new Set();
  for (const ev of midi.events) if (ev.channel !== undefined) channels.add(ev.channel);
  return [...channels].sort((a, b) => a - b);
}

// ──────────────────────────────────────────────────────────────
// Routing UI — compact per-output pills + popover editor
// ──────────────────────────────────────────────────────────────
const ROUTING_OPTIONS = [
  ...Object.entries(SYNTHS).map(([v, label]) => ({ value: parseInt(v), label })),
  { value: -1, label: 'mute' },
];

function buildRoutingUI(deckId, midi) {
  const deck = decks[deckId];
  deck.routing = {};
  for (const ch of getChannelsUsed(midi)) {
    deck.routing[ch] = ch === 9 ? 9 : (ch < 4 ? ch : ch % 4);
  }
  renderRoutingPills(deckId);
}

function renderRoutingPills(deckId) {
  const container = document.querySelector(`.routing-slots[data-deck="${deckId}"]`);
  if (!container) return;
  container.innerHTML = '';
  const deck = decks[deckId];

  // Group source channels by output (only outputs actually receiving signal)
  const groups = {};
  for (const [src, out] of Object.entries(deck.routing)) {
    const o = parseInt(out);
    if (o < 0) continue;
    (groups[o] ||= []).push(parseInt(src));
  }

  for (const outCh of Object.keys(SYNTHS).map(Number)) {
    const sources = groups[outCh];
    if (!sources || !sources.length) continue;
    const isMuted = deck.outputMute.has(outCh);

    const pill = document.createElement('button');
    pill.className = `routing-pill${isMuted ? ' muted' : ''}`;
    pill.type = 'button';
    pill.dataset.deck = deckId;
    pill.dataset.out = outCh;
    pill.innerHTML = `
      <span class="pill-dot"></span>
      <span class="pill-name">${SYNTHS[outCh]}</span>
      <span class="pill-count">${sources.length}</span>
    `;
    pill.addEventListener('click', () => toggleOutputMute(deckId, outCh));
    container.appendChild(pill);
  }
}

function toggleOutputMute(deckId, outCh) {
  const deck = decks[deckId];
  if (deck.outputMute.has(outCh)) {
    deck.outputMute.delete(outCh);
  } else {
    deck.outputMute.add(outCh);
    // Silence any active notes on this output
    for (const [key] of [...deck.activeNotes]) {
      const [oc, note] = key.split(':').map(Number);
      if (oc === outCh) {
        sendRaw(0x80 | oc, note, 0);
        deck.activeNotes.delete(key);
      }
    }
    sendRaw(0xb0 | outCh, 123, 0); // belt + braces: all-notes-off CC
  }
  renderRoutingPills(deckId);
}

// ──────────────────────────────────────────────────────────────
// Playback
// ──────────────────────────────────────────────────────────────
function playDeck(deckId, startTick = 0) {
  const deck = decks[deckId];
  if (!deck.midi) return;

  // If already playing, treat this as a seek
  if (deck.playing) {
    deck.playing = false;
    if (deck.timer) { clearTimeout(deck.timer); deck.timer = null; }
    silenceDeck(deckId);
  }

  deck.playing = true;
  const btn = document.querySelector(`.btn-play[data-deck="${deckId}"]`);
  if (btn) { btn.classList.add('playing'); btn.textContent = '■'; }

  const { events, ticksPerBeat } = deck.midi;
  // Default: file's metadata tempo will override on the first tempo event; for files
  // without tempo events, fall back to master so timing stays consistent.
  let currentBPM = master.bpm;
  let eventIndex = 0;
  // Fast-forward to startTick, picking up the active tempo
  while (eventIndex < events.length && events[eventIndex].tick < startTick) {
    if (events[eventIndex].type === 'tempo') currentBPM = events[eventIndex].bpm;
    eventIndex++;
  }
  let currentTick = startTick;
  deck.currentTick = currentTick;
  deck.currentBPM = currentBPM;

  const msPerTick = () => (60000 / (currentBPM * deck.pitch)) / ticksPerBeat;

  function step() {
    if (!deck.playing) return;

    // If we're already at/past loop end, either jump back or exit cleanly
    if (deck.loop.active && deck.loop.out != null && currentTick >= deck.loop.out) {
      if (deck.loop.pendingExit) {
        deck.loop.active = false;
        deck.loop.pendingExit = false;
        updateLoopUI(deckId);
      } else {
        handleLoopWrap(deckId);
        return;
      }
    }

    const ev = events[eventIndex];
    if (!ev && !deck.loop.active) { stopDeck(deckId); return; }

    let nextTick = ev ? ev.tick : Infinity;
    let isLoopJump = false;

    // If loop end falls before the next event, schedule either the wrap-jump or
    // a clean exit at that exact tick. With pendingExit we land on loop.out then
    // the next step() iteration disables the loop and resumes forward playback.
    if (deck.loop.active && deck.loop.out != null && deck.loop.out < nextTick) {
      nextTick = deck.loop.out;
      isLoopJump = !deck.loop.pendingExit;
    }

    const deltaMs = (nextTick - currentTick) * msPerTick();
    deck.lastEventWallTime = performance.now();
    deck.lastEventTick = currentTick;
    deck.currentMsPerTick = msPerTick();

    deck.timer = setTimeout(() => {
      currentTick = nextTick;
      deck.currentTick = currentTick;
      if (isLoopJump) {
        handleLoopWrap(deckId);
        return;
      }
      do {
        const e = events[eventIndex];
        if (e.type === 'tempo') {
          currentBPM = e.bpm;
          deck.currentBPM = currentBPM;
        } else {
          dispatchEvent(e, deck);
        }
        eventIndex++;
      } while (eventIndex < events.length && events[eventIndex].tick === currentTick);
      updatePosition(deckId, currentTick, ticksPerBeat, currentBPM);
      step();
    }, Math.max(0, deltaMs));
  }
  startRollAnimation();
  step();
}

// ──────────────────────────────────────────────────────────────
// Quantised drop — launch this deck at the next bar of the playing deck
// ──────────────────────────────────────────────────────────────
function dropDeck(deckId) {
  const deck = decks[deckId];
  if (!deck.midi || deck.playing) return;

  // Align to the master clock's next downbeat (beat 1)
  const msUntil = msUntilNextDownbeat();
  deck.dropPending = true;
  updateDropUI(deckId);
  if (deck.dropTimer) clearTimeout(deck.dropTimer);
  const startTick = deck.currentTick || 0; // respect any cue position the user has scrubbed to
  deck.dropTimer = setTimeout(() => {
    deck.dropPending = false;
    deck.dropTimer = null;
    updateDropUI(deckId);
    anchorMasterToDeck(deckId, startTick);
    playDeck(deckId, startTick);
  }, Math.max(0, msUntil));
}

function cancelDrop(deckId) {
  const deck = decks[deckId];
  if (deck.dropTimer) clearTimeout(deck.dropTimer);
  deck.dropTimer = null;
  deck.dropPending = false;
  updateDropUI(deckId);
}

function updateDropUI(deckId) {
  const btn = document.querySelector(`.btn-drop[data-deck="${deckId}"]`);
  if (!btn) return;
  btn.classList.toggle('pending', decks[deckId].dropPending);
}

// Loop wrap — defer noteOff for any active note whose natural end falls past loop.out,
// so the tail rings out into the next loop iteration instead of being cut.
function handleLoopWrap(deckId) {
  const deck = decks[deckId];
  const msPerTickNow = deck.currentMsPerTick || 4;
  for (const [key, endTick] of deck.activeNotes) {
    const [outCh, note] = key.split(':').map(Number);
    if (endTick != null && endTick > deck.loop.out) {
      const tailMs = (endTick - deck.loop.out) * msPerTickNow;
      const t = setTimeout(() => {
        sendRaw(0x80 | outCh, note, 0);
        deck.tailTimers.delete(key);
      }, Math.max(0, tailMs));
      deck.tailTimers.set(key, t);
    } else {
      sendRaw(0x80 | outCh, note, 0);
    }
  }
  deck.activeNotes.clear();
  // Re-arm without the full silenceDeck (which would kill the tails we just scheduled)
  deck.playing = false;
  if (deck.timer) { clearTimeout(deck.timer); deck.timer = null; }
  playDeck(deckId, deck.loop.in);
}

function stopDeck(deckId) {
  const deck = decks[deckId];
  deck.playing = false;
  if (deck.timer) { clearTimeout(deck.timer); deck.timer = null; }
  cancelPendingSeek(deckId);
  silenceDeck(deckId);
  const btn = document.querySelector(`.btn-play[data-deck="${deckId}"]`);
  if (btn) { btn.classList.remove('playing'); btn.textContent = '▶'; }
  deck.currentTick = 0;
  const posEl = document.querySelector(`#deck-${deckId} .stat-position`);
  if (posEl) posEl.textContent = '0:00';
  paintRoll(deckId);
}

function msUntilNextDeckBar(deck) {
  if (!deck.playing) return 0;
  const tpb = getDeckTicksPerBeat(deck);
  const meterNum = parseMeterNum(deck.meta?.meter) || 4;
  const ticksPerBar = tpb * meterNum;
  const liveTick = getLivePlaybackTick(deck);
  const nextBarTick = Math.ceil((liveTick + 1) / ticksPerBar) * ticksPerBar;
  const msPer = deck.currentMsPerTick || 4;
  return Math.max(0, (nextBarTick - liveTick) * msPer);
}

function cancelPendingSeek(deckId) {
  const deck = decks[deckId];
  if (deck.seekTimer) clearTimeout(deck.seekTimer);
  deck.seekTimer = null;
  deck.seekPending = null;
}

function seekDeck(deckId, tick) {
  const deck = decks[deckId];
  if (!deck.midi) return;
  if (!deck.playing) {
    cancelPendingSeek(deckId);
    deck.currentTick = tick;
    updatePosition(deckId, tick, deck.midi.ticksPerBeat, deck.currentBPM);
    paintRoll(deckId);
    return;
  }
  // Playing — queue the seek for the next bar of THIS deck so it lands musically
  if (deck.seekTimer) clearTimeout(deck.seekTimer);
  deck.seekPending = tick;
  const ms = msUntilNextDeckBar(deck);
  deck.seekTimer = setTimeout(() => {
    const t = deck.seekPending;
    deck.seekTimer = null;
    deck.seekPending = null;
    if (t != null) playDeck(deckId, t);
  }, ms);
  paintRoll(deckId);
}

// ──────────────────────────────────────────────────────────────
// Piano roll — compile, render, animate
// ──────────────────────────────────────────────────────────────
function buildPianoRoll(deckId) {
  if (!decks[deckId].rollData) return;
  renderRollOffscreen(deckId);
  paintRoll(deckId);
}

// Defer the heavy offscreen render to browser idle time so audio scheduling on
// the OTHER playing deck doesn't get jittered by 5–15 ms of canvas fillRect calls.
const _pendingRender = { a: null, b: null };
function deferRollRender(deckId) {
  if (_pendingRender[deckId]) {
    if (window.cancelIdleCallback) cancelIdleCallback(_pendingRender[deckId]);
    else clearTimeout(_pendingRender[deckId]);
  }
  const cb = () => {
    _pendingRender[deckId] = null;
    if (decks[deckId].rollData) buildPianoRoll(deckId);
  };
  _pendingRender[deckId] = window.requestIdleCallback
    ? requestIdleCallback(cb, { timeout: 250 })
    : setTimeout(cb, 80);
}

function parseMeterNum(meter) {
  if (!meter) return null;
  const n = parseInt(meter.split('/')[0], 10);
  return isFinite(n) && n > 0 ? n : null;
}

function zoomedEnough(deck) {
  // Show "1" labels when bars are at least ~40px apart
  if (!deck.rollData) return false;
  const tpb = getDeckTicksPerBeat(deck);
  const meterNum = parseMeterNum(deck.meta?.meter) || 4;
  const ticksPerBar = tpb * meterNum;
  const { startTick, endTick } = getRollViewWindow(deck);
  const visibleSpan = endTick - startTick;
  const canvas = document.querySelector(`.piano-roll[data-deck="${deck.id}"]`);
  const cssW = canvas?.clientWidth || 600;
  const pxPerBar = (ticksPerBar / visibleSpan) * cssW;
  return pxPerBar >= 40;
}

function getRollViewWindow(deck) {
  const z = deck.rollView.zoom;
  const o = deck.rollView.offset;
  const max = deck.rollData?.maxTick || 1;
  const visibleTicks = max / z;
  return { startTick: o * max, endTick: o * max + visibleTicks, max };
}

function renderRollOffscreen(deckId) {
  const deck = decks[deckId];
  const visible = document.querySelector(`.piano-roll[data-deck="${deckId}"]`);
  if (!visible || !deck.rollData) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = visible.clientWidth || 600;
  const cssH = visible.clientHeight || 110;
  visible.width = cssW * dpr;
  visible.height = cssH * dpr;

  const off = document.createElement('canvas');
  off.width = visible.width;
  off.height = visible.height;
  const ctx = off.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = cssW, h = cssH;

  ctx.fillStyle = '#0d0f14';
  ctx.fillRect(0, 0, w, h);

  const { notes, minNote, maxNote } = deck.rollData;
  const { startTick, endTick } = getRollViewWindow(deck);
  const visibleSpan = endTick - startTick;
  const tickToX = (t) => ((t - startTick) / visibleSpan) * w;

  const drumLaneH = 8;
  const pitchedH = h - drumLaneH;
  const noteRange = Math.max(12, maxNote - minNote);
  const noteH = pitchedH / noteRange;

  // Octave grid lines (C every octave)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let n = Math.ceil(minNote / 12) * 12; n <= maxNote; n += 12) {
    const y = pitchedH - (n - minNote) * noteH;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.moveTo(0, pitchedH); ctx.lineTo(w, pitchedH); ctx.stroke();

  // Beat + downbeat grid. Use the track's meter numerator for bar length.
  const tpb = getDeckTicksPerBeat(deck);
  const meterNum = parseMeterNum(deck.meta?.meter) || 4;
  const ticksPerBar = tpb * meterNum;

  // Faint per-beat ticks
  const firstBeat = Math.ceil(startTick / tpb);
  const lastBeat = Math.floor(endTick / tpb);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let b = firstBeat; b <= lastBeat; b++) {
    const x = tickToX(b * tpb);
    ctx.beginPath(); ctx.moveTo(x, pitchedH); ctx.lineTo(x, h); ctx.stroke();
  }
  // Brighter downbeat (beat-1) lines through the full height
  const firstBar = Math.ceil(startTick / ticksPerBar);
  const lastBar = Math.floor(endTick / ticksPerBar);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  for (let b = firstBar; b <= lastBar; b++) {
    const x = tickToX(b * ticksPerBar);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    // Tiny "1" marker above the lane
    if (zoomedEnough(deck)) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillText('1', x + 2, 9);
    }
  }

  // Notes — only those intersecting visible window
  for (const n of notes) {
    if (n.endTick < startTick || n.startTick > endTick) continue;
    const x1 = tickToX(n.startTick);
    const x2 = tickToX(n.endTick);
    const width = Math.max(1, x2 - x1);
    ctx.fillStyle = CHANNEL_COLORS[n.channel] || '#888';
    if (n.channel === 9) {
      ctx.globalAlpha = 0.5 + Math.min(0.5, n.velocity / 254);
      ctx.fillRect(x1, pitchedH + 2, Math.max(1.5, width), drumLaneH - 4);
    } else {
      const y = pitchedH - (n.note - minNote + 1) * noteH;
      ctx.globalAlpha = 0.35 + Math.min(0.65, n.velocity / 200);
      ctx.fillRect(x1, y, width, Math.max(1, noteH - 0.5));
    }
  }
  ctx.globalAlpha = 1;

  deck.rollOffscreen = off;
}

function paintRoll(deckId) {
  const deck = decks[deckId];
  const visible = document.querySelector(`.piano-roll[data-deck="${deckId}"]`);
  if (!visible) return;
  const ctx = visible.getContext('2d');
  const w = visible.width, h = visible.height;
  if (deck.rollOffscreen) {
    ctx.drawImage(deck.rollOffscreen, 0, 0);
  } else {
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, w, h);
  }

  if (!deck.midi || !deck.rollData) return;
  const dpr = window.devicePixelRatio || 1;
  const { startTick, endTick } = getRollViewWindow(deck);
  const visibleSpan = endTick - startTick;
  const cssW = visible.clientWidth || (w / dpr);
  const cssH = visible.clientHeight || (h / dpr);
  const tickToX = (t) => ((t - startTick) / visibleSpan) * cssW * dpr;

  // Loop region shading
  if (deck.loop.in != null) {
    const liveOut = deck.loop.out ?? deck.currentTick;
    const x1 = tickToX(deck.loop.in);
    const x2 = tickToX(liveOut);
    ctx.fillStyle = deck.loop.active ? 'rgba(102,214,138,0.18)' : 'rgba(102,214,138,0.08)';
    ctx.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), h);
    ctx.strokeStyle = deck.loop.active ? '#66d68a' : 'rgba(102,214,138,0.5)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.stroke();
    if (deck.loop.out != null) {
      ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, h); ctx.stroke();
    }
  }

  // Pending seek marker (dashed, deck colour) — where playhead will jump at next bar
  if (deck.seekPending != null && deck.seekPending >= startTick && deck.seekPending <= endTick) {
    const px = tickToX(deck.seekPending);
    ctx.save();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = deckId === 'a' ? 'rgba(92,224,208,0.7)' : 'rgba(255,122,138,0.7)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    ctx.restore();
  }

  // Playhead
  let tick = deck.currentTick;
  if (deck.playing && deck.currentMsPerTick) {
    const elapsedMs = performance.now() - deck.lastEventWallTime;
    tick = deck.lastEventTick + elapsedMs / deck.currentMsPerTick;
  }
  if (tick >= startTick && tick <= endTick) {
    const px = tickToX(tick);
    ctx.strokeStyle = deckId === 'a' ? '#5ce0d0' : '#ff7a8a';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }

  // Mini-overview strip at the top showing zoomed window position
  if (deck.rollView.zoom > 1) {
    const stripH = 3 * dpr;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, 0, w, stripH);
    const max = deck.rollData.maxTick;
    const wx = (startTick / max) * w;
    const ww = ((endTick - startTick) / max) * w;
    ctx.fillStyle = deckId === 'a' ? '#5ce0d0' : '#ff7a8a';
    ctx.fillRect(wx, 0, Math.max(2, ww), stripH);
  }
}

function setRollZoom(deckId, newZoom, anchorFrac = 0.5) {
  const deck = decks[deckId];
  if (!deck.rollData) return;
  const max = deck.rollData.maxTick;
  newZoom = Math.max(1, Math.min(50, newZoom));
  // Tick under the anchor point should stay there
  const { startTick, endTick } = getRollViewWindow(deck);
  const anchorTick = startTick + anchorFrac * (endTick - startTick);
  const newVisible = max / newZoom;
  let newOffset = (anchorTick - anchorFrac * newVisible) / max;
  newOffset = Math.max(0, Math.min(1 - 1 / newZoom, newOffset));
  deck.rollView.zoom = newZoom;
  deck.rollView.offset = newOffset;
  renderRollOffscreen(deckId);
  paintRoll(deckId);
}

function setRollOffset(deckId, newOffset) {
  const deck = decks[deckId];
  deck.rollView.offset = Math.max(0, Math.min(1 - 1 / deck.rollView.zoom, newOffset));
  renderRollOffscreen(deckId);
  paintRoll(deckId);
}

let rollAnimating = false;
function startRollAnimation() {
  if (rollAnimating) return;
  rollAnimating = true;
  const frame = () => {
    paintRoll('a');
    paintRoll('b');
    if (decks.a.playing || decks.b.playing) {
      requestAnimationFrame(frame);
    } else {
      rollAnimating = false;
    }
  };
  requestAnimationFrame(frame);
}

function bindPianoRoll(deckId) {
  const canvas = document.querySelector(`.piano-roll[data-deck="${deckId}"]`);
  if (!canvas) return;
  // Prevent default page-scroll/zoom inside the canvas
  canvas.style.touchAction = 'none';

  const pointers = new Map(); // pointerId → {x, y}
  let dragMode = null;        // 'scrub' | 'pan' | 'pinch' | null
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let pinchStartMidFrac = 0.5;  // midpoint as fraction of canvas at pinch start
  let pinchStartWorldX = 0;     // world fraction (0..1) under the midpoint at pinch start
  let panStartX = 0;
  let panStartOffset = 0;

  const xToTick = (x, snap = true) => {
    const deck = decks[deckId];
    if (!deck.rollData) return 0;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    const { startTick, endTick } = getRollViewWindow(deck);
    let t = startTick + frac * (endTick - startTick);
    if (snap) {
      const tpb = getDeckTicksPerBeat(deck);
      t = Math.round(t / tpb) * tpb;
    }
    return Math.round(t);
  };

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);

    if (pointers.size === 2) {
      // Two-finger gesture: combined pinch-zoom + pan
      const [p1, p2] = [...pointers.values()];
      pinchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      pinchStartZoom = decks[deckId].rollView.zoom;
      const startOffset = decks[deckId].rollView.offset;
      const rect = canvas.getBoundingClientRect();
      pinchStartMidFrac = (((p1.x + p2.x) / 2) - rect.left) / rect.width;
      pinchStartWorldX = startOffset + pinchStartMidFrac / pinchStartZoom;
      dragMode = 'pinch';
      return;
    }

    panStartX = e.clientX;
    panStartOffset = decks[deckId].rollView.offset;
    if (e.shiftKey) {
      dragMode = 'pan';
    } else {
      dragMode = 'scrub';
      seekDeck(deckId, xToTick(e.clientX));
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (dragMode === 'pinch' && pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const ratio = dist / (pinchStartDist || 1);
      const newZoom = Math.max(1, Math.min(50, pinchStartZoom * ratio));
      const rect = canvas.getBoundingClientRect();
      const curMidFrac = (((p1.x + p2.x) / 2) - rect.left) / rect.width;
      // Keep the world point that was originally under the midpoint under the (possibly moved) midpoint
      const deck = decks[deckId];
      const maxOffset = 1 - 1 / newZoom;
      const newOffset = Math.max(0, Math.min(maxOffset, pinchStartWorldX - curMidFrac / newZoom));
      deck.rollView.zoom = newZoom;
      deck.rollView.offset = newOffset;
      renderRollOffscreen(deckId);
      paintRoll(deckId);
      return;
    }

    if (dragMode === 'pan') {
      const rect = canvas.getBoundingClientRect();
      const dx = (e.clientX - panStartX) / rect.width;
      const deck = decks[deckId];
      setRollOffset(deckId, panStartOffset - dx / deck.rollView.zoom);
      return;
    }

    if (dragMode === 'scrub') {
      seekDeck(deckId, xToTick(e.clientX, !e.shiftKey));
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) dragMode = null;
    else if (pointers.size === 1) dragMode = 'scrub';
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Wheel: ctrl/cmd/shift = zoom (also covers macOS trackpad pinch, which Chrome
  // dispatches as wheel with ctrlKey=true). Anything else = horizontal pan, with
  // deltaX preferred (trackpad two-finger horizontal swipe) and deltaY as fallback
  // (mouse wheel users on a deck they've zoomed in on).
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const deck = decks[deckId];
    if (!deck.rollData) return;
    const rect = canvas.getBoundingClientRect();
    const anchorFrac = (e.clientX - rect.left) / rect.width;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const zoomFactor = Math.exp(-e.deltaY * 0.005);
      setRollZoom(deckId, deck.rollView.zoom * zoomFactor, anchorFrac);
    } else {
      const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const panAmount = primary / 600;
      setRollOffset(deckId, deck.rollView.offset + panAmount / deck.rollView.zoom);
    }
  }, { passive: false });

  // Double-click to reset zoom
  canvas.addEventListener('dblclick', () => {
    decks[deckId].rollView.zoom = 1;
    decks[deckId].rollView.offset = 0;
    renderRollOffscreen(deckId);
    paintRoll(deckId);
  });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (decks[deckId].rollData) {
        renderRollOffscreen(deckId);
        paintRoll(deckId);
      }
    });
    ro.observe(canvas);
  }
}

// ──────────────────────────────────────────────────────────────
// Loop controls — auto-loop N beats from current playhead
// ──────────────────────────────────────────────────────────────
function getLivePlaybackTick(deck) {
  if (!deck.playing || !deck.currentMsPerTick) return deck.currentTick;
  const elapsedMs = performance.now() - deck.lastEventWallTime;
  return deck.lastEventTick + elapsedMs / deck.currentMsPerTick;
}

function getDeckTicksPerBeat(deck) {
  // Prefer perceived ticks-per-beat (matches audible groove); fall back to file metadata
  return deck.meta?.perceived_ticks_per_beat || deck.midi?.ticksPerBeat || 480;
}

function setBeatLoop(deckId, beats) {
  const deck = decks[deckId];
  if (!deck.midi) return;
  // Toggle off → arm pending exit (loop plays out to loop.out, then continues)
  if (deck.loop.active && deck.loop.beats === beats) {
    deck.loop.pendingExit = !deck.loop.pendingExit;
    updateLoopUI(deckId);
    return;
  }
  const tpb = getDeckTicksPerBeat(deck);
  const live = getLivePlaybackTick(deck);
  // Quantise loop start to the nearest perceived beat boundary
  const startTick = Math.round(live / tpb) * tpb;
  deck.loop.in = startTick;
  deck.loop.out = startTick + beats * tpb;
  deck.loop.active = true;
  deck.loop.beats = beats;
  deck.loop.pendingExit = false;
  updateLoopUI(deckId);
  paintRoll(deckId);
}

// ──────────────────────────────────────────────────────────────
// BPM display (effective = base × pitch)
// ──────────────────────────────────────────────────────────────
function updateBpmDisplay(deckId) {
  const deck = decks[deckId];
  const bpmEl = document.querySelector(`#deck-${deckId} .stat-bpm`);
  if (!bpmEl) return;
  // Native (perceived) BPM of the track. Everything plays at master.bpm; this column
  // shows what the track "wants" to be at, so the user can see the warp ratio implicitly.
  const base = deck.meta?.perceived_bpm ?? deck.meta?.bpm;
  bpmEl.textContent = base ?? '—';
  bpmEl.title = base ? `Native ${base} → playing at master ${master.bpm} BPM` : '';
}

// ──────────────────────────────────────────────────────────────
// Transpose (semitones, drums excluded)
// ──────────────────────────────────────────────────────────────
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function setTranspose(deckId, semitones) {
  const deck = decks[deckId];
  semitones = Math.max(-12, Math.min(12, semitones));
  if (semitones === deck.transpose) return;
  // Silence active pitched notes so noteOffs at the new transpose don't mismatch
  for (const [key] of [...deck.activeNotes]) {
    const [oc, note] = key.split(':').map(Number);
    if (oc !== 9) {
      sendRaw(0x80 | oc, note, 0);
      deck.activeNotes.delete(key);
    }
  }
  deck.transpose = semitones;
  updateTransposeUI(deckId);
}

function updateTransposeUI(deckId) {
  const deck = decks[deckId];
  const root = document.querySelector(`#deck-${deckId}`);
  if (!root) return;
  const valEl = root.querySelector('.transpose-value');
  if (valEl) {
    const s = deck.transpose;
    valEl.textContent = s === 0 ? '0' : (s > 0 ? `+${s}` : `${s}`);
    valEl.classList.toggle('altered', s !== 0);
  }
  // Show shifted key on stats
  const keyEl = root.querySelector('.stat-key');
  if (keyEl && deck.meta?.key) {
    if (deck.transpose === 0) {
      keyEl.textContent = deck.meta.key;
    } else {
      const [tonic, mode] = deck.meta.key.split(' ');
      const tonicIdx = NOTE_NAMES.indexOf(tonic);
      if (tonicIdx >= 0) {
        const shifted = NOTE_NAMES[((tonicIdx + deck.transpose) % 12 + 12) % 12];
        keyEl.textContent = `${deck.meta.key}▸${shifted} ${mode}`;
      }
    }
  }
}

function updateLoopUI(deckId) {
  const deck = decks[deckId];
  const root = document.querySelector(`#deck-${deckId}`);
  if (!root) return;
  const activeBeats = deck.loop.active ? deck.loop.beats : null;
  const pending = deck.loop.pendingExit;
  root.querySelectorAll('.btn-loop-pad').forEach(b => {
    const isActive = parseInt(b.dataset.beats) === activeBeats;
    b.classList.toggle('active', isActive && !pending);
    b.classList.toggle('exiting', isActive && pending);
  });
}

function updatePosition(deckId, tick, ticksPerBeat, bpm) {
  const seconds = (tick / ticksPerBeat / bpm) * 60;
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  const el = document.querySelector(`#deck-${deckId} .stat-position`);
  if (el) el.textContent = `${min}:${String(sec).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────
// Browser (track library)
// ──────────────────────────────────────────────────────────────
function formatDuration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateDeckStats(deckId, meta) {
  const root = document.querySelector(`#deck-${deckId}`);
  if (!root) return;
  root.querySelector('.stat-bpm').textContent = meta?.bpm ?? '—';
  root.querySelector('.stat-key').textContent = meta?.key ?? '—';
  root.querySelector('.stat-duration').textContent = formatDuration(meta?.duration_sec);
  root.querySelector('.stat-position').textContent = '0:00';
  const meterEl = root.querySelector('.stat-meter');
  if (meterEl) {
    const m = meta?.meter ?? '—';
    meterEl.textContent = m + (meta?.meter_changes ? '*' : '');
    meterEl.title = meta?.meter_changes
      ? `Meter changes: ${meta.meters_unique.join(', ')}`
      : '';
  }
}

async function loadTrackIntoDeck(deckId, track) {
  try {
    const res = await fetch(track.path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();

    // Parsing happens off-thread; the playing deck's scheduler keeps ticking
    const { midi, rollData } = await parseInWorker(buffer);

    stopDeck(deckId);
    decks[deckId].midi = midi;
    decks[deckId].meta = track;
    decks[deckId].currentTick = 0;
    decks[deckId].loop = { in: null, out: null, active: false, beats: null, pendingExit: false };
    decks[deckId].transpose = 0;
    decks[deckId].outputMute = new Set();
    decks[deckId].rollView = { zoom: 1, offset: 0 };
    decks[deckId].rollData = rollData; // pre-computed in the worker
    cancelDrop(deckId);
    cancelPendingSeek(deckId);
    const nameEl = document.querySelector(`#deck-${deckId} .track-name`);
    nameEl.textContent = `${track.title} · ${track.game}`;
    nameEl.classList.remove('muted');
    updateDeckStats(deckId, track);
    if (!master.autoSet && track.perceived_bpm) {
      setMasterBpm(track.perceived_bpm);
      if (masterBpmSlider) masterBpmSlider.setValue(master.bpm);
      master.autoSet = true;
    }
    syncDeckToMaster(deckId);
    updateTransposeUI(deckId);
    buildRoutingUI(deckId, midi);
    updateLoopUI(deckId);
    // Paint a placeholder (background + playhead) immediately so the deck looks responsive
    paintRoll(deckId);
    // Defer the heavy offscreen render until the browser is idle, so audio scheduling
    // on the other deck gets priority. Falls back to a deferred setTimeout on browsers
    // without requestIdleCallback.
    deferRollRender(deckId);
  } catch (err) {
    console.error('Load failed', track.path, err);
    alert(`Failed to load: ${track.path}\n${err.message}`);
  }
}

let browserState = { search: '', games: new Set(), sort: 'game', dir: 1 };

const COLUMNS = [
  { key: 'title', label: 'title' },
  { key: 'game', label: 'game' },
  { key: 'bpm', label: 'bpm' },
  { key: 'key', label: 'key' },
  { key: 'meter', label: 'meter' },
  { key: 'duration_sec', label: 'len' },
];

function trackBpm(t) { return t.perceived_bpm ?? t.bpm ?? 0; }

function sortComparator(key) {
  if (key === 'game') return (a, b) => a.game.localeCompare(b.game) || a.title.localeCompare(b.title);
  if (key === 'title') return (a, b) => a.title.localeCompare(b.title);
  if (key === 'key') return (a, b) => (a.key ?? '').localeCompare(b.key ?? '');
  if (key === 'meter') return (a, b) => (a.meter ?? '').localeCompare(b.meter ?? '');
  if (key === 'bpm') return (a, b) => trackBpm(a) - trackBpm(b);
  // numeric fallback
  return (a, b) => (a[key] ?? 0) - (b[key] ?? 0);
}

function setSort(key) {
  if (browserState.sort === key) {
    browserState.dir = -browserState.dir;
  } else {
    browserState.sort = key;
    browserState.dir = 1;
  }
  renderBrowser();
}

function renderBrowser() {
  const { search, games: gameFilter, sort: sortKey, dir } = browserState;

  let filtered = trackLibrary.filter(t => {
    if (gameFilter.size > 0 && !gameFilter.has(t.game)) return false;
    if (!search) return true;
    return t.title.toLowerCase().includes(search) || t.game.toLowerCase().includes(search);
  });

  const cmp = sortComparator(sortKey);
  filtered.sort((a, b) => cmp(a, b) * dir);

  const list = document.getElementById('browser-list');
  list.innerHTML = '';
  document.getElementById('browser-count').textContent = `${filtered.length}/${trackLibrary.length}`;

  // Sticky, clickable header
  const header = document.createElement('div');
  header.className = 'track-row track-row-header';
  const arrow = dir > 0 ? '▴' : '▾';
  header.innerHTML = COLUMNS.map(c => {
    const active = c.key === sortKey ? 'active' : '';
    return `<span class="col ${active}" data-sort="${c.key}">${c.label}<span class="sort-ind">${c.key === sortKey ? arrow : '▴'}</span></span>`;
  }).join('') + '<span></span>';
  list.appendChild(header);

  header.querySelectorAll('.col').forEach(el => {
    el.addEventListener('click', () => setSort(el.dataset.sort));
  });

  const limit = Math.min(filtered.length, 500);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < limit; i++) {
    const t = filtered[i];
    const row = document.createElement('div');
    row.className = 'track-row';
    row.innerHTML = `
      <span class="t-title" title="${t.title}">${t.title}</span>
      <span class="t-game">${t.game}</span>
      <span class="t-bpm">${trackBpm(t) || '—'}</span>
      <span class="t-key">${t.key ?? '—'}</span>
      <span class="t-meter">${t.meter ?? '—'}${t.meter_changes ? '*' : ''}</span>
      <span class="t-len">${formatDuration(t.duration_sec)}</span>
      <span class="load-btns">
        <button class="to-a">A</button>
        <button class="to-b">B</button>
      </span>
    `;
    row.querySelector('.to-a').addEventListener('click', () => loadTrackIntoDeck('a', t));
    row.querySelector('.to-b').addEventListener('click', () => loadTrackIntoDeck('b', t));
    frag.appendChild(row);
  }
  list.appendChild(frag);
  if (filtered.length > limit) {
    const more = document.createElement('div');
    more.className = 'track-row muted';
    more.style.justifyContent = 'center';
    more.textContent = `…${filtered.length - limit} more — narrow search`;
    list.appendChild(more);
  }
}

function renderGameChips() {
  const root = document.getElementById('browser-games');
  if (!root) return;
  root.innerHTML = '';
  const games = [...new Set(trackLibrary.map(t => t.game))].sort();

  // "All" chip — clears the selection
  const allChip = document.createElement('button');
  allChip.className = 'game-chip all' + (browserState.games.size === 0 ? ' active' : '');
  allChip.type = 'button';
  allChip.textContent = 'all';
  allChip.addEventListener('click', () => {
    browserState.games.clear();
    renderGameChips();
    renderBrowser();
  });
  root.appendChild(allChip);

  for (const g of games) {
    const chip = document.createElement('button');
    chip.className = 'game-chip' + (browserState.games.has(g) ? ' active' : '');
    chip.type = 'button';
    chip.textContent = g;
    chip.addEventListener('click', () => {
      if (browserState.games.has(g)) browserState.games.delete(g);
      else browserState.games.add(g);
      renderGameChips();
      renderBrowser();
    });
    root.appendChild(chip);
  }
}

async function initBrowser() {
  try {
    const res = await fetch('tracks.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    trackLibrary = data.tracks;

    renderGameChips();
    const searchEl = document.getElementById('browser-search');
    const clearBtn = document.getElementById('browser-clear');
    searchEl.addEventListener('input', () => {
      browserState.search = searchEl.value.toLowerCase().trim();
      clearBtn.hidden = !searchEl.value;
      renderBrowser();
    });
    clearBtn.addEventListener('click', () => {
      searchEl.value = '';
      browserState.search = '';
      clearBtn.hidden = true;
      renderBrowser();
      searchEl.focus();
    });

    renderBrowser();
  } catch (err) {
    document.getElementById('browser-list').textContent = `Library load failed: ${err.message}`;
  }
}

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────
function init() {
  initMIDI();
  initBrowser();

  // Master BPM slider — the single source of truth; both decks warp to this
  masterBpmSlider = mountSlider(document.querySelector('.cslider[data-target="bpm"]'), {
    onInput: (v) => { setMasterBpm(v); },
  });

  // Master meter dropdown
  mountDropdown(document.getElementById('master-meter-mount'), {
    options: [2, 3, 4, 5, 6, 7, 8].map(n => ({ value: n, label: `${n}/4` })),
    value: master.meter,
    onChange: (v) => {
      master.meter = v;
      buildMasterBeatDots();
      lastShownBeat = -1;
      updateMasterBeatDots(true);
    },
  });

  buildMasterBeatDots();
  startMasterClock();

  document.getElementById('master-tap').addEventListener('click', masterTapTempo);
  document.getElementById('master-reset').addEventListener('click', masterReset);

  // Per-deck setup
  for (const deckId of ['a', 'b']) {
    // Volume
    const vol = document.querySelector(`.cslider[data-target="vol-${deckId}"]`);
    vol.classList.add('subtle');
    mountSlider(vol, { onInput: (v) => { decks[deckId].volume = v; } });

    // Transport
    document.querySelector(`.btn-play[data-deck="${deckId}"]`).addEventListener('click', () => {
      if (decks[deckId].dropPending) cancelDrop(deckId);
      if (decks[deckId].playing) {
        stopDeck(deckId);
      } else {
        const startTick = decks[deckId].currentTick || 0;
        anchorMasterToDeck(deckId, startTick);
        playDeck(deckId, startTick);
      }
    });
    document.querySelector(`.btn-cue[data-deck="${deckId}"]`).addEventListener('click', () => {
      setCue(deckId, cuedDeck !== deckId);
    });
    document.querySelector(`.btn-drop[data-deck="${deckId}"]`).addEventListener('click', () => {
      if (decks[deckId].dropPending) cancelDrop(deckId);
      else dropDeck(deckId);
    });

    // Loop pads (beat-length auto loops)
    document.querySelectorAll(`.btn-loop-pad[data-deck="${deckId}"]`).forEach(btn => {
      btn.addEventListener('click', () => setBeatLoop(deckId, parseInt(btn.dataset.beats)));
    });

    // Transpose ± buttons
    document.querySelectorAll(`.transpose-btn[data-deck="${deckId}"]`).forEach(btn => {
      btn.addEventListener('click', () => {
        setTranspose(deckId, decks[deckId].transpose + parseInt(btn.dataset.delta));
      });
    });

    // Piano roll
    bindPianoRoll(deckId);
  }

  // Stop all
  document.getElementById('btn-stop-all').addEventListener('click', () => {
    stopDeck('a'); stopDeck('b');
  });

  // Preview / test mode toggle
  mountToggle(document.getElementById('test-mode-toggle'), {
    initial: false,
    onChange: async (on) => {
      silenceAll();
      testMode = on;
      document.body.classList.toggle('test-mode', on);
      if (on) await unlockTestSynth();
    },
  });

  // Mix switch
  document.querySelectorAll('.mix-pos').forEach(btn => {
    btn.addEventListener('click', () => setMixState(btn.dataset.state));
  });
}

init();
