// ──────────────────────────────────────────────────────────────
// Hardware outputs — channel index → display label
// Labels are role-first ("Drums", "Bass", "Lead", "Poly 1/2") so the
// routing pills line up column-for-column with the LCXL3 controller:
//   col 1 = Drums, col 2 = Bass, col 3 = Lead, col 4 = Poly 1, col 5 = Poly 2.
// The synth in parens is for disambiguation between the two polys.
// ──────────────────────────────────────────────────────────────
const SYNTHS = {
  0: 'Poly 1',
  1: 'Lead',
  2: 'Bass',
  3: 'Poly 2',
  9: 'Drums',
};

// Routing pill column order. Object.keys(SYNTHS) sorts numerically (0,1,2,3,9)
// so we need an explicit order to match the controller's left-to-right layout.
const OUTPUT_ORDER = [9, 2, 1, 0, 3];

// Representative GM patches used in preview mode for each hardware output.
// Channel 9 = GM drum kit (auto). Picks roughly match each synth's role.
const GM_PREVIEW_PATCH = {
  0: 89, // Warm Pad      — Juno 106 (pads/chords)
  1: 81, // Sawtooth Lead — SH-01A (leads/arps)
  2: 38, // Synth Bass 1  — Bass Station 2
  3: 80, // Square Lead   — Roland Keytar
};

// Hardware outputs that are physically monophonic. The dispatcher does two
// things for these:
//   (a) when same-tick noteOns target a mono output, only the policy-winner
//       is forwarded (e.g. chord through Lead → top note only). Without
//       this, the SH-01A re-triggers its envelope on every chord note and
//       you hear a stutter instead of a clean melodic line.
//   (b) for sequential noteOns, any prior sounding note on the mono outCh
//       is released before the new one fires (handled inside dispatchEvent).
const MONO_OUTPUTS = new Set([1, 2]); // Lead (SH-01A), Bass (Bass Stn 2)
const MONO_OUTPUT_POLICY = {
  1: 'highest',  // Lead — keep the top voice when a chord lands on SH-01A
  2: 'lowest',   // Bass — keep the root when a chord lands on Bass Station 2
};

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
  const vertical = el.dataset.orientation === 'vertical';
  let value = parseFloat(el.dataset.value ?? min);

  if (vertical) el.classList.add('vertical');
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
    if (vertical) {
      // Top of fader = max (high volume). Fill rises from bottom; thumb tracks.
      fill.style.height = `${pct}%`;
      thumb.style.bottom = `${pct}%`;
    } else {
      fill.style.width = `${pct}%`;
      thumb.style.left = `${pct}%`;
    }
  };

  const setFromPointer = (clientX, clientY) => {
    const rect = el.querySelector('.cslider-track').getBoundingClientRect();
    let pct;
    if (vertical) {
      pct = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    } else {
      pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }
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
    setFromPointer(e.clientX, e.clientY);
  });
  el.addEventListener('pointermove', (e) => {
    if (pointerId !== null) setFromPointer(e.clientX, e.clientY);
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

// Scroll-in-place selector. Tap ‹ / › to cycle, scroll wheel, or swipe
// horizontally on touch. Value stays anchored in the centre — no menu pops.
// options: [{ value, label, sublabel? }]
function mountSpinner(mountEl, { options, value, onChange, className = '' }) {
  const root = document.createElement('div');
  root.className = `cspinner ${className}`;
  const prev = document.createElement('button');
  prev.className = 'cspinner-prev';
  prev.type = 'button';
  prev.textContent = '‹';
  const valueWrap = document.createElement('div');
  valueWrap.className = 'cspinner-value';
  const labelEl = document.createElement('div');
  labelEl.className = 'cspinner-label';
  const subEl = document.createElement('div');
  subEl.className = 'cspinner-sublabel';
  valueWrap.append(labelEl, subEl);
  const next = document.createElement('button');
  next.className = 'cspinner-next';
  next.type = 'button';
  next.textContent = '›';
  root.append(prev, valueWrap, next);
  mountEl.replaceWith(root);
  root.id = mountEl.id;

  let idx = Math.max(0, options.findIndex(o => String(o.value) === String(value)));
  if (idx < 0) idx = 0;

  const render = () => {
    const o = options[idx];
    labelEl.textContent = o?.label ?? '';
    subEl.textContent = o?.sublabel ?? '';
    subEl.style.visibility = o?.sublabel ? 'visible' : 'hidden';
    prev.disabled = idx <= 0;
    next.disabled = idx >= options.length - 1;
  };

  const step = (delta) => {
    const nidx = Math.max(0, Math.min(options.length - 1, idx + delta));
    if (nidx === idx) return;
    idx = nidx;
    render();
    onChange?.(options[idx].value);
  };

  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(+1));

  // Mouse wheel: vertical or horizontal scroll cycles options
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    step(d > 0 ? 1 : -1);
  }, { passive: false });

  // Touch drag: horizontal swipe steps once per ~28px. Direction matches the
  // arrow keys — swipe RIGHT (toward the › button) advances to the next value,
  // swipe LEFT (toward ‹) goes to the previous. Same direction-sense as the
  // wheel handler above.
  let touchStartX = null;
  let touchAccum = 0;
  root.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchAccum = 0;
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (touchStartX == null) return;
    const dx = e.touches[0].clientX - touchStartX;
    const stepPx = 28;
    while (dx - touchAccum > stepPx) { touchAccum += stepPx; step(+1); }
    while (dx - touchAccum < -stepPx) { touchAccum -= stepPx; step(-1); }
  }, { passive: true });
  root.addEventListener('touchend', () => { touchStartX = null; touchAccum = 0; });

  render();
  return {
    getValue() { return options[idx]?.value; },
    setValue(v) {
      const i = options.findIndex(o => String(o.value) === String(v));
      if (i >= 0 && i !== idx) { idx = i; render(); }
    },
    setOptions(opts, newValue) {
      options = opts;
      const i = options.findIndex(o => String(o.value) === String(newValue ?? options[idx]?.value));
      idx = i >= 0 ? i : 0;
      render();
    },
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

// 'a' | 'both' | 'b' — channel selector (A / A+B / B), binary mute, no fade
let mixState = 'both';

// Tracks which deck (if any) is currently CUE-soloed
let cuedDeck = null;

const decks = {
  '1': makeDeckState('1'),
  '2': makeDeckState('2'),
};

function makeDeckState(id) {
  return {
    id, midi: null, playing: false, timer: null,
    channel: id === '1' ? 'a' : 'b', // routes against mixState (channel A or B)
    volume: 100, pitch: 1.0,
    transpose: 0, // semitones; drums (ch9) are skipped
    timeFold: 1, // 0.5 | 1 | 2 — half/normal/double-time relative to master
    // Independent flip state per swappable pair:
    //   leadBassFlipped — Lead (ch 1) ↔ Bass (ch 2)   (both monosynths)
    //   polyFlipped     — Poly 1 (ch 0) ↔ Poly 2 (ch 3) (Juno/Keytar)
    leadBassFlipped: false,
    polyFlipped: false,
    routing: {}, meta: null,
    activeNotes: new Map(), // key "outCh:note" → natural endTick (or null)
    tailTimers: new Map(),  // key → setTimeout id for deferred noteOff after loop wrap
    outputMute: new Set(),  // output channel indices currently muted
    outputActive: new Map(), // outCh → count of audibly-sounding notes (drives gated pill)
    dropTimer: null,
    dropPending: false,
    cutTimer: null,
    cutPending: false,
    autoAdvance: false,
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
    loop: { in: null, out: null, active: false, beats: 4, pendingExit: false },
    // When true, the next single-tap on the piano roll sets the cue/start
    // position; otherwise taps are absorbed so pinch/pan/zoom can't trip an
    // accidental scrub. Auto-disarms on commit and on track load.
    startArmed: false,
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
// Playlist store — curated, ordered sets of tracks with per-entry overrides
// (cue tick, loop in/out + armed-on-load, output mutes, transpose, time-fold,
// volume, note). Backed by localStorage so sets survive reloads. The catalog
// section has two modes: "library" (search/browse the full corpus) and
// "playlist" (ordered set, drag/reorder, capture-from-deck, drop with loop).
// ──────────────────────────────────────────────────────────────
const PLAYLIST_STORAGE_KEY = 'vgmDj.playlists.v1';
const PLAYLIST_CURRENT_KEY = 'vgmDj.currentPlaylistId.v1';
const PLAYLIST_MODE_KEY = 'vgmDj.catalogMode.v1';

const playlistStore = {
  playlists: [],
  currentId: null,
  mode: 'library',
};

function _uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadPlaylistStore() {
  try {
    const raw = localStorage.getItem(PLAYLIST_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) playlistStore.playlists = parsed;
    }
  } catch (e) { /* ignore corrupt storage */ }
  try { playlistStore.currentId = localStorage.getItem(PLAYLIST_CURRENT_KEY) || null; } catch (e) {}
  try { playlistStore.mode = localStorage.getItem(PLAYLIST_MODE_KEY) || 'library'; } catch (e) {}
  if (!playlistStore.playlists.find(p => p.id === playlistStore.currentId)) {
    playlistStore.currentId = playlistStore.playlists[0]?.id ?? null;
  }
}

let _playlistSaveTimer = null;
function savePlaylistStore() {
  if (_playlistSaveTimer) clearTimeout(_playlistSaveTimer);
  _playlistSaveTimer = setTimeout(() => {
    _playlistSaveTimer = null;
    try {
      localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlistStore.playlists));
      if (playlistStore.currentId) localStorage.setItem(PLAYLIST_CURRENT_KEY, playlistStore.currentId);
      else localStorage.removeItem(PLAYLIST_CURRENT_KEY);
      localStorage.setItem(PLAYLIST_MODE_KEY, playlistStore.mode);
    } catch (e) { console.warn('playlist save failed', e); }
  }, 200);
}

function getCurrentPlaylist() {
  return playlistStore.playlists.find(p => p.id === playlistStore.currentId) || null;
}

function createPlaylist(name) {
  const p = {
    id: _uid(),
    name: name || `Set ${playlistStore.playlists.length + 1}`,
    created: Date.now(),
    updated: Date.now(),
    entries: [],
  };
  playlistStore.playlists.push(p);
  playlistStore.currentId = p.id;
  savePlaylistStore();
  return p;
}

function deleteCurrentPlaylist() {
  const idx = playlistStore.playlists.findIndex(p => p.id === playlistStore.currentId);
  if (idx < 0) return;
  playlistStore.playlists.splice(idx, 1);
  playlistStore.currentId = playlistStore.playlists[Math.max(0, idx - 1)]?.id
                          ?? playlistStore.playlists[0]?.id
                          ?? null;
  savePlaylistStore();
}

function renameCurrentPlaylist(name) {
  const p = getCurrentPlaylist();
  if (!p || !name) return;
  p.name = name;
  p.updated = Date.now();
  savePlaylistStore();
}

function duplicateCurrentPlaylist() {
  const p = getCurrentPlaylist();
  if (!p) return;
  const copy = {
    id: _uid(),
    name: p.name + ' copy',
    created: Date.now(),
    updated: Date.now(),
    entries: p.entries.map(e => ({ ...e, id: _uid() })),
  };
  playlistStore.playlists.push(copy);
  playlistStore.currentId = copy.id;
  savePlaylistStore();
}

function setCurrentPlaylist(id) {
  if (!playlistStore.playlists.find(p => p.id === id)) return;
  playlistStore.currentId = id;
  savePlaylistStore();
}

// Append a library track to the current playlist (creating one if absent).
// Returns the freshly-created entry, or null if the track isn't found.
function addEntryToCurrentPlaylist(trackPath) {
  if (!trackPath) return null;
  let p = getCurrentPlaylist();
  if (!p) p = createPlaylist('Set 1');
  const entry = { id: _uid(), path: trackPath };
  p.entries.push(entry);
  p.updated = Date.now();
  savePlaylistStore();
  return entry;
}

function removeEntryFromCurrent(entryId) {
  const p = getCurrentPlaylist();
  if (!p) return;
  const idx = p.entries.findIndex(e => e.id === entryId);
  if (idx >= 0) {
    p.entries.splice(idx, 1);
    p.updated = Date.now();
    savePlaylistStore();
  }
}

function moveEntryInCurrent(entryId, delta) {
  const p = getCurrentPlaylist();
  if (!p) return;
  const idx = p.entries.findIndex(e => e.id === entryId);
  if (idx < 0) return;
  const newIdx = Math.max(0, Math.min(p.entries.length - 1, idx + delta));
  if (newIdx === idx) return;
  const [item] = p.entries.splice(idx, 1);
  p.entries.splice(newIdx, 0, item);
  p.updated = Date.now();
  savePlaylistStore();
}

function updateEntryInCurrent(entryId, patch) {
  const p = getCurrentPlaylist();
  if (!p) return;
  const entry = p.entries.find(e => e.id === entryId);
  if (!entry) return;
  Object.assign(entry, patch);
  p.updated = Date.now();
  savePlaylistStore();
}

// Snapshot a deck's current loop / mutes / transpose / time-fold / volume /
// cue tick into the given entry. The intended workflow: rehearse the move on
// the deck, then tap "capture A" or "capture B" to write that state into the
// playlist row so re-loading it later reproduces the move.
function captureDeckIntoEntry(deckId, entryId) {
  const deck = decks[deckId];
  if (!deck.midi) return false;
  const patch = {
    cueTick: deck.currentTick || 0,
    transpose: deck.transpose || 0,
    timeFold: deck.timeFold || 1,
    volume: typeof deck.volume === 'number' ? deck.volume : 100,
    outputMutes: [...deck.outputMute],
  };
  if (deck.loop.in != null && deck.loop.out != null) {
    patch.loop = {
      in: deck.loop.in,
      out: deck.loop.out,
      beats: deck.loop.beats || null,
      armed: !!deck.loop.active,
    };
  } else {
    patch.loop = null;
  }
  updateEntryInCurrent(entryId, patch);
  return true;
}

// Look up the next entry after a given one (for prefetch / auto-advance).
function getNextEntryAfter(entryId) {
  const p = getCurrentPlaylist();
  if (!p) return null;
  const idx = p.entries.findIndex(e => e.id === entryId);
  if (idx < 0 || idx >= p.entries.length - 1) return null;
  return p.entries[idx + 1];
}

// ──────────────────────────────────────────────────────────────
// Prefetch — eagerly fetch + worker-parse the next playlist entry so that
// loading it onto a deck is a state-assignment rather than a fetch+parse
// round-trip. Cache size = 1 (most recent prefetch wins). Stale entries
// (path changed before consumption) are dropped.
// ──────────────────────────────────────────────────────────────
const _prefetched = { path: null, midi: null, rollData: null, dropChannels: null };

function prefetchTrack(track) {
  if (!track || !track.path) return;
  if (_prefetched.path === track.path && _prefetched.midi) return;
  _prefetched.path = track.path;
  _prefetched.midi = null;
  _prefetched.rollData = null;
  _prefetched.dropChannels = track.drop_channels || [];
  (async () => {
    const requestedPath = track.path;
    try {
      const res = await fetch(requestedPath);
      if (!res.ok) throw new Error(`prefetch HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      const { midi, rollData } = await parseInWorker(buffer, { dropChannels: track.drop_channels });
      // Drop if a newer prefetch superseded ours mid-flight
      if (_prefetched.path !== requestedPath) return;
      _prefetched.midi = midi;
      _prefetched.rollData = rollData;
    } catch (e) {
      if (_prefetched.path === requestedPath) {
        _prefetched.path = null;
        _prefetched.midi = null;
        _prefetched.rollData = null;
      }
    }
  })();
}

function consumePrefetch(trackPath) {
  if (_prefetched.path !== trackPath || !_prefetched.midi) return null;
  const out = { midi: _prefetched.midi, rollData: _prefetched.rollData };
  _prefetched.path = null;
  _prefetched.midi = null;
  _prefetched.rollData = null;
  _prefetched.dropChannels = null;
  return out;
}

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
  for (const id of ['1', '2']) {
    syncDeckToMaster(id);
    const d = decks[id];
    if (!d.playing) continue;
    // Anchors (lastEventTick/WallTime + currentMsPerTick) still reflect the OLD
    // rate at this point — syncDeckToMaster only touched deck.pitch. Capture the
    // live tick under the OLD rate, then re-anchor under the NEW rate so the
    // in-flight setTimeout target (computed from startWallTime + cumulativeMs)
    // and the live-playhead interpolation stay consistent across the jump.
    const liveTick = getLivePlaybackTick(d);
    d.lastEventTick = liveTick;
    d.lastEventWallTime = performance.now();
    d.currentMsPerTick = (60000 / (master.bpm * d.pitch)) / getDeckTicksPerBeat(d);
  }
  document.getElementById('master-bpm-value').textContent = bpm;
  // Re-anchor beat-1 so it stays phase-locked: prefer the playing deck if there
  // is one (alignment to musical content), otherwise preserve the visual phase
  // so the master counter doesn't appear to jump.
  const playingId = decks['1'].playing ? '1' : (decks['2'].playing ? '2' : null);
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
    deck.pitch = deck.timeFold || 1;
    return;
  }
  // timeFold (½/1/2×) reduces the perceived BPM the ratio sees, which raises
  // pitch — so the deck plays N× faster relative to master without altering master.bpm.
  const effectivePerceivedBpm = deck.meta.perceived_bpm / (deck.timeFold || 1);
  deck.pitch = master.bpm / effectivePerceivedBpm;
  updateBpmDisplay(deckId);
}

function masterReset() {
  master.beatOneAt = performance.now();
  updateMasterBeatDots(true);
}

// When a deck starts playing and it's the only deck playing, slave master.meter
// to that deck's meter so DROP/CUT quantising, beat-dots and loop maths all
// follow the audible groove. Two-deck-different-meter case is left alone — the
// user resolves it with CUT (which has its own meter-swap logic).
function adoptDeckMeterIfSolo(deckId) {
  const deck = decks[deckId];
  if (!deck?.meta) return;
  const otherId = deckId === '1' ? '2' : '1';
  if (decks[otherId].playing) return;
  const m = parseMeterNum(deck.meta?.meter) || 4;
  if (m === master.meter) return;
  master.meter = m;
  buildMasterBeatDots();
  lastShownBeat = -1;
  updateMasterBeatDots(true);
  masterMeterSpinner?.setValue(m);
}

// Raw-tick offset where the file's audible beat-1 sits. Defaults to 0 for
// tracks without an override. All grid math is anchored to this, NOT raw tick 0.
function getDeckBeatOneTick(deck) {
  return Number.isFinite(deck?.meta?.beat_one_tick) ? deck.meta.beat_one_tick : 0;
}

// Anchor master beat-1 to a specific deck's tick position so the beat counter
// stays phase-locked to that deck's perceived beats. Called on play and drop.
function anchorMasterToDeck(deckId, deckTick) {
  const deck = decks[deckId];
  if (!deck.midi) return;
  const tpb = getDeckTicksPerBeat(deck);
  // Subtract beat-1 offset so phase 0 aligns with the music's audible downbeat,
  // not the file's raw tick 0 (which may include pickup, count-in, or silent pad).
  const beatsIntoTrack = (deckTick - getDeckBeatOneTick(deck)) / tpb;
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
let masterMeterSpinner = null;

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
    reanchorMasterToAnchorDeck();
    updateMasterBeatDots();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Continuously slave master.beatOneAt to the audible position of the sole
// playing deck, so the beat-dots / quantised-drop maths / loop maths can't
// drift away from what's actually playing — even when the file has tempo
// events that shift the deck's rate away from master.bpm. When two decks are
// playing the user owns the relationship (set on the most recent drop / CUT)
// and we mustn't yank it; idle frames also early-return.
function reanchorMasterToAnchorDeck() {
  const playingIds = ['1', '2'].filter(id => decks[id].playing);
  if (playingIds.length !== 1) return;
  const deck = decks[playingIds[0]];
  if (!deck.midi) return;
  anchorMasterToDeck(deck.id, getLivePlaybackTick(deck));
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
  // Apply persisted CUE channel routing now that the context exists.
  if (typeof applyCueChannelsRouting === 'function') {
    try { applyCueChannelsRouting(); } catch (e) { console.warn('CUE routing apply failed:', e); }
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
let midiAccess = null;
const SETTINGS_MIDI_PORT_KEY = 'vgmdj-midi-port-id';
async function initMIDI() {
  const port = document.getElementById('midi-port');
  const status = document.getElementById('midi-status');
  if (!navigator.requestMIDIAccess) {
    port.textContent = 'no Web MIDI';
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    const choose = () => {
      const outs = [...midiAccess.outputs.values()];
      if (!outs.length) {
        midiOutput = null;
        port.textContent = 'no midi out';
        status.classList.remove('ok');
        refreshSettingsMidiPortDropdown();
        return;
      }
      const preferredId = localStorage.getItem(SETTINGS_MIDI_PORT_KEY);
      const pick = outs.find(o => o.id === preferredId) ?? outs[0];
      midiOutput = pick;
      port.textContent = pick.name;
      status.classList.add('ok');
      refreshSettingsMidiPortDropdown();
    };
    choose();
    midiAccess.onstatechange = choose;
  } catch (err) {
    port.textContent = `err: ${err.message}`;
  }
}

function setMidiOutputById(id) {
  if (!midiAccess) return;
  const outs = [...midiAccess.outputs.values()];
  const pick = outs.find(o => o.id === id) ?? outs[0];
  if (!pick) return;
  midiOutput = pick;
  document.getElementById('midi-port').textContent = pick.name;
  localStorage.setItem(SETTINGS_MIDI_PORT_KEY, pick.id);
}

let settingsMidiDropdown = null;
function refreshSettingsMidiPortDropdown() {
  if (!midiAccess) return;
  const mount = document.getElementById('settings-midi-port-mount');
  if (!mount) return;
  const outs = [...midiAccess.outputs.values()].map(o => ({ value: o.id, label: o.name || o.id }));
  if (!outs.length) outs.push({ value: '', label: '(none available)' });
  const current = midiOutput?.id ?? outs[0].value;
  if (settingsMidiDropdown) {
    settingsMidiDropdown.setOptions(outs);
    settingsMidiDropdown.setValue(current);
  } else {
    settingsMidiDropdown = mountDropdown(mount, {
      options: outs,
      value: current,
      onChange: (id) => setMidiOutputById(id),
    });
  }
}

// Optional 4th arg: a DOMHighResTimeStamp (performance.now() domain) at which
// the receiving end should fire the message. Used by the scheduler to hand
// events off ahead of time so CoreMIDI (via the iOS polyfill) can dispatch
// with µs precision — main-thread setTimeout jitter under LOOKAHEAD_MS then
// becomes inaudible. Panic / silence / flip / mute paths omit it (= "now").
// testMode (WebAudioTinySynth) doesn't accept timestamps; we drop it there.
function sendRaw(status, data1, data2, timestamp) {
  const msg = data2 !== undefined ? [status, data1, data2] : [status, data1];
  if (testMode) {
    const synth = getTestSynth();
    if (synth) synth.send(msg);
  } else if (midiOutput) {
    if (timestamp != null) midiOutput.send(msg, timestamp);
    else midiOutput.send(msg);
  }
}

function setPillActive(deckId, outCh, on) {
  const pill = document.querySelector(`.routing-pill[data-deck="${deckId}"][data-out="${outCh}"]`);
  if (pill) pill.classList.toggle('active', on);
}

// Centralised note-on / note-off pairing: maintains an active-note counter per
// output so the routing pill lights while ANY note is still sounding on that
// output and dims when the last one ends. Every MIDI noteOn/noteOff to a
// hardware output must go through these wrappers so the gate stays accurate.
function dispatchNoteOn(deck, outCh, note, vel, timestamp) {
  sendRaw(0x90 | outCh, note, vel, timestamp);
  const count = (deck.outputActive.get(outCh) ?? 0) + 1;
  deck.outputActive.set(outCh, count);
  if (count === 1) setPillActive(deck.id, outCh, true);
}
function dispatchNoteOff(deck, outCh, note, timestamp) {
  sendRaw(0x80 | outCh, note, 0, timestamp);
  const count = (deck.outputActive.get(outCh) ?? 0) - 1;
  if (count <= 0) {
    deck.outputActive.delete(outCh);
    setPillActive(deck.id, outCh, false);
  } else {
    deck.outputActive.set(outCh, count);
  }
}
function clearOutputActive(deck) {
  for (const outCh of deck.outputActive.keys()) setPillActive(deck.id, outCh, false);
  deck.outputActive.clear();
}

// ──────────────────────────────────────────────────────────────
// Mix state — which decks are audible
// ──────────────────────────────────────────────────────────────
function deckAudible(deckId) {
  if (cuedDeck) return cuedDeck === deckId; // CUE solos
  if (mixState === 'both') return true;
  return mixState === decks[deckId].channel;
}

function setMixState(state) {
  if (state === mixState) return;
  const losingChannels = (mixState === 'both') ? [state === 'a' ? 'b' : 'a']
                       : (state === 'both') ? []
                       : [mixState];
  mixState = state;
  for (const deckId of ['1', '2']) {
    if (losingChannels.includes(decks[deckId].channel)) silenceDeck(deckId);
  }
  document.querySelectorAll('.mix-pos').forEach(b => {
    b.classList.toggle('active', b.dataset.state === state);
  });
}

function setCue(deckId, on) {
  if (on) {
    if (cuedDeck && cuedDeck !== deckId) silenceDeck(cuedDeck);
    cuedDeck = deckId;
    // Silence the OTHER deck while cued
    const other = deckId === '1' ? '2' : '1';
    silenceDeck(other);
  } else {
    if (cuedDeck === deckId) {
      cuedDeck = null;
      // Re-evaluate: silence anything no longer audible
      for (const d of ['1', '2']) if (!deckAudible(d)) silenceDeck(d);
    }
  }
  document.querySelectorAll('.btn-cue').forEach(b => {
    b.classList.toggle('cued', b.dataset.deck === cuedDeck);
  });
}

// ──────────────────────────────────────────────────────────────
// Note dispatch — applies routing + mix state + drum remap
// ──────────────────────────────────────────────────────────────
// Pre-filter a batch of same-tick events: when multiple noteOns land on a
// mono output in the same tick (a chord on Lead/Bass), keep the policy-
// winner and drop the rest. NoteOffs and all other event types pass
// through untouched, so the activeNotes bookkeeping in dispatchEvent stays
// consistent (the loser's noteOff at endTick will simply find no matching
// activeNote and no-op).
function filterMonoPolyphony(events, deck) {
  // First pass — pick the winner per mono outCh.
  const winners = new Map(); // outCh → event
  for (const e of events) {
    if (e.type !== 'noteOn' || e.channel === undefined) continue;
    const outCh = deck.routing[e.channel];
    const policy = MONO_OUTPUT_POLICY[outCh];
    if (!policy) continue;
    const cur = winners.get(outCh);
    if (!cur) {
      winners.set(outCh, e);
    } else if ((policy === 'highest' && e.note > cur.note) ||
               (policy === 'lowest'  && e.note < cur.note)) {
      winners.set(outCh, e);
    }
  }
  if (winners.size === 0) return events;
  // Second pass — keep everything except mono noteOns that aren't the winner.
  return events.filter(e => {
    if (e.type !== 'noteOn' || e.channel === undefined) return true;
    const outCh = deck.routing[e.channel];
    if (!MONO_OUTPUT_POLICY[outCh]) return true;
    return winners.get(outCh) === e;
  });
}

function dispatchEvent(ev, deck, timestamp) {
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
    // The pre-empt noteOff must land BEFORE the new noteOn — clamp its
    // timestamp to (newNote - 1ms) so CoreMIDI orders them correctly.
    if (MONO_OUTPUTS.has(outCh)) {
      const preTs = timestamp != null ? Math.max(0, timestamp - 1) : undefined;
      const prefix = `${outCh}:`;
      for (const activeKey of [...deck.activeNotes.keys()]) {
        if (activeKey.startsWith(prefix) && activeKey !== key) {
          const prevNote = Number(activeKey.slice(prefix.length));
          dispatchNoteOff(deck, outCh, prevNote, preTs);
          deck.activeNotes.delete(activeKey);
          const tail = deck.tailTimers.get(activeKey);
          if (tail) { clearTimeout(tail); deck.tailTimers.delete(activeKey); }
        }
      }
    }
    dispatchNoteOn(deck, outCh, note, vel, timestamp);
    deck.activeNotes.set(key, ev.endTick ?? null);
  } else if (ev.type === 'noteOff') {
    if (!testMode && outCh === 9) note = GM_TO_TR08[note] || note;
    if (deck.activeNotes.has(`${outCh}:${note}`)) {
      dispatchNoteOff(deck, outCh, note, timestamp);
      deck.activeNotes.delete(`${outCh}:${note}`);
    }
  }
  // programChange from the source is ignored — output patches are fixed per hardware target
}

// Stamp used by panic / silence / flip / mute paths. With a lookahead window
// active, the scheduler has already handed up to LOOKAHEAD_MS of future
// noteOns to CoreMIDI; a "now" noteOff would land BEFORE those scheduled
// noteOns and leave the note stuck. Stamping our kill just past that window
// guarantees CoreMIDI orders it after every in-flight scheduled event.
// Returns undefined when no lookahead is in effect (then sendRaw uses "now").
function panicStamp() {
  return LOOKAHEAD_MS ? performance.now() + LOOKAHEAD_MS + 1 : undefined;
}

function silenceDeck(deckId) {
  const deck = decks[deckId];
  const ts = panicStamp();
  for (const [key] of deck.activeNotes) {
    const [outCh, note] = key.split(':').map(Number);
    sendRaw(0x80 | outCh, note, 0, ts);
  }
  deck.activeNotes.clear();
  // Cancel any pending tail noteOffs from a prior loop wrap
  for (const t of deck.tailTimers.values()) clearTimeout(t);
  deck.tailTimers.clear();
  // All-notes-off CC on every output channel this deck uses — but skip any
  // channel the OTHER deck is currently sounding on, otherwise loading a
  // new track on this deck would cut sustaining notes on the other deck.
  const otherId = deckId === '1' ? '2' : '1';
  const otherChannels = new Set();
  for (const [key] of decks[otherId].activeNotes) {
    otherChannels.add(Number(key.slice(0, key.indexOf(':'))));
  }
  const outs = new Set(Object.values(deck.routing).filter(v => v >= 0));
  for (const ch of outs) {
    if (!otherChannels.has(ch)) sendRaw(0xb0 | ch, 123, 0, ts);
  }
  clearOutputActive(deck);
}

function silenceAll() {
  silenceDeck('1');
  silenceDeck('2');
  const ts = panicStamp();
  const all = testMode ? [0, 1, 2, 3, 9] : [0, 1, 2, 3, 9];
  for (const ch of all) sendRaw(0xb0 | ch, 123, 0, ts);
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

function parseInWorker(buffer, opts = {}) {
  const worker = getMidiWorker();
  const id = ++nextWorkerReqId;
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject });
    worker.postMessage({ id, buffer, dropChannels: opts.dropChannels || [] }, [buffer]);
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
  // Fresh track → fresh routing, so clear any flip carried from the prior track.
  deck.leadBassFlipped = false;
  deck.polyFlipped = false;
  renderRoutingPills(deckId);
}

// Swap the two channels of a flippable pair on this deck. Silences any active
// notes on those outputs first so a mid-flight noteOff doesn't go to the wrong
// box and leave a hung note on the other.
//   pair === 'leadBass' → ch 1 (Lead/SH-01A) ↔ ch 2 (Bass/Bass Stn 2)
//   pair === 'poly'     → ch 0 (Poly 1/Juno) ↔ ch 3 (Poly 2/Keytar)
function flipOutputs(deckId, pair = 'poly') {
  const deck = decks[deckId];
  const [a, b] = pair === 'leadBass' ? [1, 2] : [0, 3];
  const ts = panicStamp();
  for (const [key] of [...deck.activeNotes]) {
    const oc = Number(key.split(':')[0]);
    if (oc === a || oc === b) {
      const note = Number(key.split(':')[1]);
      dispatchNoteOff(deck, oc, note, ts);
      deck.activeNotes.delete(key);
      const tail = deck.tailTimers.get(key);
      if (tail) { clearTimeout(tail); deck.tailTimers.delete(key); }
    }
  }
  sendRaw(0xb0 | a, 123, 0, ts);
  sendRaw(0xb0 | b, 123, 0, ts);
  for (const src in deck.routing) {
    if (deck.routing[src] === a) deck.routing[src] = b;
    else if (deck.routing[src] === b) deck.routing[src] = a;
  }
  const flag = pair === 'leadBass' ? 'leadBassFlipped' : 'polyFlipped';
  deck[flag] = !deck[flag];
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

  // Render every hardware output, every time, in column order — Drums, Bass,
  // Lead, Poly 1, Poly 2 — so the pills line up with the LCXL3 controller and
  // muscle memory survives a track change. Outputs the loaded track doesn't
  // use are rendered dimmed and inert.
  for (const outCh of OUTPUT_ORDER) {
    const sources = groups[outCh];
    const hasSources = !!(sources && sources.length);
    const isMuted = hasSources && deck.outputMute.has(outCh);
    const isActive = hasSources && (deck.outputActive.get(outCh) ?? 0) > 0;
    const pill = document.createElement('button');
    pill.className = `routing-pill${!hasSources ? ' unused' : ''}${isMuted ? ' muted' : ''}${isActive ? ' active' : ''}`;
    pill.type = 'button';
    pill.dataset.deck = deckId;
    pill.dataset.out = outCh;
    pill.innerHTML = `
      <span class="pill-dot"></span>
      <span class="pill-name">${SYNTHS[outCh]}</span>
      <span class="pill-count">${hasSources ? sources.length : ''}</span>
    `;
    if (hasSources) {
      pill.addEventListener('click', () => toggleOutputMute(deckId, outCh));
    } else {
      pill.disabled = true;
    }
    container.appendChild(pill);
    // Two flip toggles, each rendered between the pair it swaps:
    //   Bass(col 2) ↔ Lead(col 3)   — after the Bass pill (outCh === 2)
    //   Poly 1(col 4) ↔ Poly 2(col 5) — after the Poly 1 pill (outCh === 0)
    if (outCh === 2) {
      container.appendChild(makeFlipPill(deckId, 'leadBass', deck.leadBassFlipped,
        'swap Lead ↔ Bass'));
    } else if (outCh === 0) {
      container.appendChild(makeFlipPill(deckId, 'poly', deck.polyFlipped,
        'swap Poly 1 ↔ Poly 2'));
    }
  }
}

function makeFlipPill(deckId, pair, active, title) {
  const flip = document.createElement('button');
  flip.className = `flip-pill${active ? ' active' : ''}`;
  flip.type = 'button';
  flip.dataset.deck = deckId;
  flip.dataset.pair = pair;
  flip.title = title;
  flip.innerHTML = '⇄';
  flip.addEventListener('click', () => flipOutputs(deckId, pair));
  return flip;
}

function toggleOutputMute(deckId, outCh) {
  const deck = decks[deckId];
  if (deck.outputMute.has(outCh)) {
    deck.outputMute.delete(outCh);
  } else {
    deck.outputMute.add(outCh);
    // Silence any active notes on this output
    const ts = panicStamp();
    for (const [key] of [...deck.activeNotes]) {
      const [oc, note] = key.split(':').map(Number);
      if (oc === outCh) {
        dispatchNoteOff(deck, oc, note, ts);
        deck.activeNotes.delete(key);
      }
    }
    sendRaw(0xb0 | outCh, 123, 0, ts); // belt + braces: all-notes-off CC
  }
  renderRoutingPills(deckId);
}

// ──────────────────────────────────────────────────────────────
// Playback
// ──────────────────────────────────────────────────────────────
// Lookahead window. The scheduler fires each event's setTimeout this many ms
// before the audible target, then hands the event to the output with the
// future timestamp. Web MIDI / CoreMIDI dispatches at the exact stamp, so
// main-thread jitter under LOOKAHEAD_MS becomes inaudible. Only enabled in
// the native iOS shell (where the polyfill forwards stamps to CoreMIDI) —
// elsewhere we keep zero-lookahead "fire now" so testMode (WebAudioTinySynth,
// no timestamp arg) and unverified desktop Web MIDI implementations stay on
// the existing path.
const LOOKAHEAD_MS = (typeof window !== 'undefined' && window.__vgmDjNativeShell) ? 40 : 0;

// When true, the scheduler ignores file-internal tempo events and pins each
// deck's rate entirely to master.bpm * deck.pitch. This is the primary defence
// against drift between decks and between deck and master clock — without it,
// a file with tempo events (Castlevania's "lying tempo" etc.) walks its own
// rate while master and the other deck don't follow, and they fan out over
// time. Tradeoff: rubato curves authored into the file get flattened. The
// "unstable" library badge already marks tempo-heavy tracks; for DJ-mixing,
// flat-to-master is the wanted behaviour. Flip to false in console to A/B.
const LOCK_DECK_RATE_TO_MASTER = true;

// `startWallTime`, when supplied, anchors the scheduler's `startWallTime` to a
// caller-provided wallclock moment instead of `performance.now()`. Used by
// `handleLoopWrap` so the new iteration's first events align exactly with the
// audible loop.out tick, not LOOKAHEAD_MS earlier — otherwise the lookahead
// window flams the wrap on percussive material.
function playDeck(deckId, startTick = 0, startWallTime) {
  const deck = decks[deckId];
  if (!deck.midi) return;

  // If already playing, treat this as a seek
  if (deck.playing) {
    deck.playing = false;
    if (deck.timer) { clearTimeout(deck.timer); deck.timer = null; }
    silenceDeck(deckId);
  }

  adoptDeckMeterIfSolo(deckId);

  deck.playing = true;
  const btn = document.querySelector(`.btn-play[data-deck="${deckId}"]`);
  if (btn) { btn.classList.add('playing'); btn.textContent = '■'; }

  const { events, ticksPerBeat } = deck.midi;
  // Initial tempo: prefer the file's authored tempo (bpm_initial from manifest)
  // so the pre-first-tempo-event window plays at the right ms-per-tick.
  // Falling back to master.bpm produced a transient rate jump when the file's
  // first tempo event landed and bpm_initial differed from master.bpm —
  // especially audible on lying-tempo files (Doom, Castlevania) where pitch
  // is significantly != 1.
  let currentBPM = deck.meta?.bpm_initial ?? master.bpm;
  let eventIndex = 0;
  // Fast-forward to startTick, picking up the active tempo (only when honouring
  // file tempo events; otherwise currentBPM stays at bpm_initial forever and
  // the deck plays at strict master.bpm * deck.pitch).
  while (eventIndex < events.length && events[eventIndex].tick < startTick) {
    if (!LOCK_DECK_RATE_TO_MASTER && events[eventIndex].type === 'tempo') {
      currentBPM = events[eventIndex].bpm;
    }
    eventIndex++;
  }
  let currentTick = startTick;
  deck.currentTick = currentTick;
  deck.currentBPM = currentBPM;

  // Absolute-time scheduling: every event targets a wall-clock time computed
  // from startWallTime + cumulativeMs. The accumulator advances using the
  // current msPerTick on each segment, so pitch changes and tempo events flow
  // through naturally — but the lateness of any individual setTimeout fire
  // can't propagate forward, because the *next* event's setTimeout duration
  // is computed against an absolute target, not relative to the prior fire.
  deck.startWallTime = (startWallTime != null) ? startWallTime : performance.now();
  let cumulativeMs = 0;

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
    if (!ev && !deck.loop.active) {
      stopDeck(deckId);
      if (deck.autoAdvance) advanceToNextTrack(deckId);
      return;
    }

    let nextTick = ev ? ev.tick : Infinity;
    let isLoopJump = false;
    let isPendingExitBar = false;

    // If loop end falls before the next event, schedule either the wrap-jump or
    // a clean exit at that exact tick. With pendingExit we land on loop.out then
    // the next step() iteration disables the loop and resumes forward playback.
    if (deck.loop.active && deck.loop.out != null && deck.loop.out < nextTick) {
      nextTick = deck.loop.out;
      isLoopJump = !deck.loop.pendingExit;
    }

    // pendingExit honours the *next bar boundary* regardless of where the
    // playhead is relative to the loop region — so a user-armed exit fires
    // promptly even when playback is before, after, or outside the loop.
    if (deck.loop.active && deck.loop.pendingExit) {
      const tpb = getDeckTicksPerBeat(deck);
      const meterNum = parseMeterNum(deck.meta?.meter) || 4;
      const ticksPerBar = tpb * meterNum;
      const nextBarTick = Math.ceil((currentTick + 1) / ticksPerBar) * ticksPerBar;
      if (nextBarTick < nextTick) {
        nextTick = nextBarTick;
        isLoopJump = false;
        isPendingExitBar = true;
      }
    }

    cumulativeMs += (nextTick - currentTick) * msPerTick();
    const targetWallTime = deck.startWallTime + cumulativeMs;
    deck.currentMsPerTick = msPerTick();

    deck.timer = setTimeout(() => {
      currentTick = nextTick;
      deck.currentTick = currentTick;
      // Anchor live-playhead interpolation to the *intended* fire time rather
      // than performance.now() — otherwise setTimeout jitter (5–100ms) leaks
      // into every read of getLivePlaybackTick.
      deck.lastEventWallTime = targetWallTime;
      deck.lastEventTick = currentTick;
      if (isLoopJump) {
        // Pass the audible loop.out wallclock through so handleLoopWrap can
        // stamp tail noteOffs and anchor the new iteration's startWallTime
        // exactly to the loop boundary — otherwise the lookahead window pulls
        // the new iter LOOKAHEAD_MS earlier than the old iter's tail-end
        // events, flamming percussive material at the wrap.
        handleLoopWrap(deckId, targetWallTime);
        return;
      }
      if (isPendingExitBar) {
        deck.loop.active = false;
        deck.loop.pendingExit = false;
        updateLoopUI(deckId);
        updatePosition(deckId, currentTick, ticksPerBeat, currentBPM);
        step();
        return;
      }
      // Gather every event at this tick, filter chords routed to mono
      // outputs, then dispatch in original order.
      const tickEvents = [];
      while (eventIndex < events.length && events[eventIndex].tick === currentTick) {
        tickEvents.push(events[eventIndex]);
        eventIndex++;
      }
      for (const e of filterMonoPolyphony(tickEvents, deck)) {
        if (e.type === 'tempo') {
          if (!LOCK_DECK_RATE_TO_MASTER) {
            currentBPM = e.bpm;
            deck.currentBPM = currentBPM;
          }
        } else {
          dispatchEvent(e, deck, LOOKAHEAD_MS ? targetWallTime : undefined);
        }
      }
      updatePosition(deckId, currentTick, ticksPerBeat, currentBPM);
      step();
    }, Math.max(0, targetWallTime - performance.now() - LOOKAHEAD_MS));
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
  // Respect any cue position the user has scrubbed to. If a playlist entry
  // armed a loop on load, the drop should land at the loop's in-point so the
  // first wrap fires at loop.out — that's "drop into a loop". Otherwise:
  // honour the cue tick the user has scrubbed/captured to; failing that, fall
  // back to the music's audible beat-1 (raw tick 0 may include count-in).
  let startTick;
  if (deck.loop.active && Number.isFinite(deck.loop.in)) {
    startTick = deck.loop.in;
  } else {
    startTick = deck.currentTick || getDeckBeatOneTick(deck);
  }
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

// All hardware-output channel indices. Used as the universe for inverse-mute.
const ALL_OUTPUTS = Object.keys(SYNTHS).map(Number);

// Find the deck assigned to the opposite channel from `sourceId`. Returns the
// deck id or null when both decks share a channel (in which case Transition
// has no valid target).
function findOppositeChannelDeck(sourceId) {
  const source = decks[sourceId];
  const otherChannel = source.channel === 'a' ? 'b' : 'a';
  for (const id of ['1', '2']) {
    if (id !== sourceId && decks[id].channel === otherChannel) return id;
  }
  return null;
}

function flashButton(btn, cls = 'flash', ms = 250) {
  if (!btn) return;
  btn.classList.add(cls);
  setTimeout(() => btn.classList.remove(cls), ms);
}

// Transition: copy the source deck's mute set onto the opposite-channel deck
// in inverted form (anything unmuted on source becomes muted on target, and
// vice versa) — so the two decks together cover the full output set with no
// overlap. If the target isn't already playing, drop it at the next master bar.
function transitionDeck(sourceId) {
  const source = decks[sourceId];
  if (!source.midi) return;
  const targetId = findOppositeChannelDeck(sourceId);
  if (!targetId) {
    flashButton(document.querySelector(`.btn-trans[data-deck="${sourceId}"]`), 'flash-warn', 400);
    return;
  }
  const target = decks[targetId];
  if (!target.midi) {
    flashButton(document.querySelector(`.btn-trans[data-deck="${sourceId}"]`), 'flash-warn', 400);
    return;
  }
  target.outputMute = new Set();
  for (const out of ALL_OUTPUTS) {
    if (!source.outputMute.has(out)) target.outputMute.add(out);
  }
  // Silence any currently sounding notes on outputs that just became muted
  const ts = panicStamp();
  for (const [key] of [...target.activeNotes]) {
    const [oc, note] = key.split(':').map(Number);
    if (target.outputMute.has(oc)) {
      dispatchNoteOff(target, oc, note, ts);
      target.activeNotes.delete(key);
    }
  }
  renderRoutingPills(targetId);
  if (!target.playing) dropDeck(targetId);
}

// CUT: hard swap to the other deck at the next master bar. Stops this deck
// (if playing) AND drops the other deck (if loaded and not already playing).
// Tapping it again while pending cancels both halves.
function cutDeck(deckId) {
  const deck = decks[deckId];
  if (deck.cutPending) {
    clearTimeout(deck.cutTimer);
    deck.cutTimer = null;
    deck.cutPending = false;
    updateCutUI(deckId);
    return;
  }
  const otherId = deckId === '1' ? '2' : '1';
  const other = decks[otherId];
  const willStop = deck.playing;
  const willStart = other.midi && !other.playing;
  if (!willStop && !willStart) return; // nothing to do
  const msUntil = msUntilNextDownbeat();
  deck.cutPending = true;
  updateCutUI(deckId);
  deck.cutTimer = setTimeout(() => {
    deck.cutPending = false;
    deck.cutTimer = null;
    updateCutUI(deckId);
    if (willStop) stopDeck(deckId);
    if (willStart) {
      // Incoming deck arrives fully audible: unmute any pill-muted outputs
      // right at the swap moment so the muted outputs don't sneak back in
      // audibly before the deck actually drops.
      if (other.outputMute.size) {
        other.outputMute.clear();
        renderRoutingPills(otherId);
      }
      // Adopt the incoming deck's meter so the beat-dot clock, DROP quantising,
      // and loop-bar maths all follow what's now playing.
      const incomingMeter = parseMeterNum(other.meta?.meter) || 4;
      if (incomingMeter !== master.meter) {
        master.meter = incomingMeter;
        buildMasterBeatDots();
        lastShownBeat = -1;
        updateMasterBeatDots(true);
        masterMeterSpinner?.setValue(incomingMeter);
      }
      const startTick = other.currentTick || getDeckBeatOneTick(other);
      anchorMasterToDeck(otherId, startTick);
      playDeck(otherId, startTick);
    }
  }, Math.max(0, msUntil));
}

function updateCutUI(deckId) {
  const btn = document.querySelector(`.btn-cut[data-deck="${deckId}"]`);
  if (!btn) return;
  btn.classList.toggle('pending', decks[deckId].cutPending);
}

// Load the next track in browser order onto this deck and drop it at the
// next master bar. Inherits the deck's current routing, output mute set,
// and transpose — so a transition's part-muting carries into the next
// track without the user having to set it up again.
async function advanceToNextTrack(deckId) {
  const deck = decks[deckId];
  const currentPath = deck.meta?.path;
  if (!currentPath) return;
  const next = findNextTrackAfter(currentPath);
  if (!next || next.path === currentPath) return;
  // Snapshot inheritable state before loadTrackIntoDeck resets it
  const inheritedRouting = { ...deck.routing };
  const inheritedMute = new Set(deck.outputMute);
  const inheritedTranspose = deck.transpose;
  await loadTrackIntoDeck(deckId, next);
  // Restore inheritable state (only the parts loadTrackIntoDeck cleared)
  decks[deckId].outputMute = inheritedMute;
  decks[deckId].transpose = inheritedTranspose;
  // Routing assignments per source channel: keep the inherited target for any
  // channel that exists in the new track too; new channels keep the freshly-
  // assigned default from buildRoutingUI.
  for (const src of Object.keys(decks[deckId].routing)) {
    if (src in inheritedRouting) decks[deckId].routing[src] = inheritedRouting[src];
  }
  renderRoutingPills(deckId);
  updateTransposeUI(deckId);
  dropDeck(deckId);
}

function toggleAutoAdvance(deckId) {
  const deck = decks[deckId];
  deck.autoAdvance = !deck.autoAdvance;
  updateAutoAdvanceUI(deckId);
}

function updateAutoAdvanceUI(deckId) {
  const btn = document.querySelector(`.btn-auto[data-deck="${deckId}"]`);
  if (!btn) return;
  btn.classList.toggle('active', decks[deckId].autoAdvance);
}

function unmuteAllOutputs(deckId) {
  const deck = decks[deckId];
  if (!deck.outputMute.size) return;
  deck.outputMute.clear();
  renderRoutingPills(deckId);
}

function flipDeckChannel(deckId) {
  const deck = decks[deckId];
  deck.channel = deck.channel === 'a' ? 'b' : 'a';
  // If the flip just moved this deck off the audible channel, silence it
  if (!deckAudible(deckId)) silenceDeck(deckId);
  updateChannelToggleUI(deckId);
}

// Subtle per-deck background skin. Probes docs/img/games/<game>.{webp,jpg,png}
// in order; first hit wins. If no file exists for the loaded track's game,
// the skin stays invisible. Drop image files in docs/img/games/ to enable —
// the loader is silent on misses (no console errors).
let manifestVersion = '';
const _skinCache = new Map(); // game → resolved url, or null when not found
// Per-franchise display fonts applied to the .game-name child of
// .track-name. The .track-title child always renders in the default UI
// font.  Add a key here only when a font file ships in docs/fonts/.
const GAME_FONT_CLASS = {
  'castlevania':     'font-castlevania',
  'mario':           'font-mario',
  'zelda':           'font-zelda',
  'mega-man':        'font-mega-man',
  'tetris':          'font-tetris',
  'doom':            'font-doom',
  'contra':          'font-contra',
  'metroid':         'font-metroid',
  'final-fantasy':   'font-final-fantasy',
  'earthbound':      'font-earthbound',
};

// Franchises that don't have a bespoke font yet — render in a generic
// pixel font so they still feel 8-bit rather than Helvetica.
const PIXEL_DEFAULT_GAMES = new Set(['chrono-trigger', 'golden-axe']);

// Franchises whose "logo" comes from one or more SVG assets rather than a
// text font. Value may be a single path string OR an array of paths
// (rendered side-by-side on a single line).
const GAME_LOGO_SVG = {
  'donkey-kong':    ['img/SVG/Donkey.svg', 'img/SVG/Kong.svg'],
  'sonic':          ['img/SVG/Sonic.svg'],
  'street-fighter': ['img/SVG/StreetFighter.svg'],
};

// Display overrides. Keys whose franchise reads more naturally with the
// hyphen preserved (rather than the default hyphen→space substitution)
// land here. Multi-line lockups would go here too.
const GAME_NAME_OVERRIDE = {
  'golden-axe':     'golden-axe',
  'mega-man':       'mega-man',
  'chrono-trigger': 'chrono-trigger',
};

function applyGameFontToTrackName(nameEl, track) {
  nameEl.innerHTML = '';
  if (!track) return;

  const game = track.game || '';
  const title = track.title || '';

  // Game-name / logo element
  if (game && GAME_LOGO_SVG[game]) {
    const paths = [].concat(GAME_LOGO_SVG[game]);
    const wrap = document.createElement('span');
    wrap.className = 'game-logo-row';
    for (const p of paths) {
      const logo = document.createElement('img');
      logo.className = 'game-logo-img';
      logo.src = p;
      logo.alt = game;
      wrap.appendChild(logo);
    }
    nameEl.appendChild(wrap);
  } else if (game) {
    const g = document.createElement('span');
    g.className = 'game-name';
    if (GAME_FONT_CLASS[game]) {
      g.classList.add(GAME_FONT_CLASS[game]);
    } else if (PIXEL_DEFAULT_GAMES.has(game)) {
      g.classList.add('font-pixel-default');
    }
    // Either an explicit override (e.g. two-line title) or the manifest's
    // hyphenated game key with hyphens stripped.
    g.textContent = GAME_NAME_OVERRIDE[game] || game.replace(/-/g, ' ');
    nameEl.appendChild(g);
  }

  // Track-title element always in the default UI font.
  if (title) {
    const t = document.createElement('span');
    t.className = 'track-title';
    t.textContent = title;
    nameEl.appendChild(t);
  }
}

function updateDeckSkin(deckId, game) {
  const skin = document.querySelector(`.deck-skin[data-deck="${deckId}"]`);
  if (!skin) return;
  const apply = (url) => {
    if (url) {
      skin.style.backgroundImage = `url("${url}")`;
      skin.classList.add('loaded');
    } else {
      skin.style.backgroundImage = '';
      skin.classList.remove('loaded');
    }
  };
  if (!game) return apply(null);
  if (_skinCache.has(game)) return apply(_skinCache.get(game));
  const exts = ['webp', 'jpg', 'png'];
  const bust = manifestVersion ? `?v=${encodeURIComponent(manifestVersion)}` : '';
  (function tryNext(i) {
    if (i >= exts.length) { _skinCache.set(game, null); apply(null); return; }
    const url = `img/games/${game}.${exts[i]}${bust}`;
    const img = new Image();
    img.onload = () => { _skinCache.set(game, url); apply(url); };
    img.onerror = () => tryNext(i + 1);
    img.src = url;
  })(0);
}

function updateChannelToggleUI(deckId) {
  const btn = document.querySelector(`.btn-channel[data-deck="${deckId}"]`);
  if (!btn) return;
  const ch = decks[deckId].channel;
  btn.textContent = ch.toUpperCase();
  btn.dataset.channel = ch;
}

function updateDropUI(deckId) {
  const btn = document.querySelector(`.btn-drop[data-deck="${deckId}"]`);
  if (!btn) return;
  btn.classList.toggle('pending', decks[deckId].dropPending);
}

// Loop wrap — defer noteOff for any active note whose natural end falls past loop.out,
// so the tail rings out into the next loop iteration instead of being cut.
// `audibleLoopOutTime` is the wallclock moment at which the loop.out tick
// should sound — passed by the scheduler so we can align tail noteOffs and
// the next iteration's first events to the audible boundary regardless of
// the LOOKAHEAD_MS window. Falls back to "now" for legacy callers (the
// re-entry guard at the top of step()).
function handleLoopWrap(deckId, audibleLoopOutTime) {
  const deck = decks[deckId];
  const msPerTickNow = deck.currentMsPerTick || 4;
  const audibleOut = (audibleLoopOutTime != null && LOOKAHEAD_MS)
    ? audibleLoopOutTime
    : null;
  for (const [key, endTick] of deck.activeNotes) {
    const [outCh, note] = key.split(':').map(Number);
    if (endTick != null && endTick > deck.loop.out) {
      const tailMs = (endTick - deck.loop.out) * msPerTickNow;
      if (audibleOut != null) {
        // CoreMIDI can schedule the tail noteOff with µs precision — hand it
        // off immediately with the audible end stamp, no setTimeout needed.
        dispatchNoteOff(deck, outCh, note, audibleOut + tailMs);
      } else {
        const t = setTimeout(() => {
          dispatchNoteOff(deck, outCh, note);
          deck.tailTimers.delete(key);
        }, Math.max(0, tailMs));
        deck.tailTimers.set(key, t);
      }
    } else {
      // Notes that don't carry past loop.out: stamp at the audible boundary
      // so they land flush with the wrap, not LOOKAHEAD_MS early.
      dispatchNoteOff(deck, outCh, note, audibleOut != null ? audibleOut : undefined);
    }
  }
  deck.activeNotes.clear();
  // Re-arm without the full silenceDeck (which would kill the tails we just scheduled)
  deck.playing = false;
  if (deck.timer) { clearTimeout(deck.timer); deck.timer = null; }
  // Re-anchor master to this deck's loop-in so phase error doesn't accumulate
  // across long loops. Only when this deck is the solo reference — otherwise
  // the other deck owns the grid and we mustn't yank it.
  const otherId = deckId === '1' ? '2' : '1';
  if (!decks[otherId].playing) {
    anchorMasterToDeck(deckId, deck.loop.in);
  }
  // Anchor the new iteration's startWallTime to the audible loop.out so the
  // first event(s) of the wrap land at the boundary itself, not LOOKAHEAD_MS
  // earlier. That's what kills the loop-wrap flam on drums.
  playDeck(deckId, deck.loop.in, audibleOut != null ? audibleOut : undefined);
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

// Returns [{ tick, bar }, …] for the whole track, walking deck.meta.meter_changes
// when the file has signature changes (Castlevania IV intro etc). bar is 1-indexed
// from the start of the track. Cached on the deck until the next track loads.
function computeBarMarks(deck) {
  if (deck._barMarks) return deck._barMarks;
  const tpb = getDeckTicksPerBeat(deck);
  const maxTick = (deck.rollData?.maxTick) || 0;
  const marks = [];
  const changes = deck.meta?.meter_changes;
  if (!changes || !changes.length) {
    const meterNum = parseMeterNum(deck.meta?.meter) || 4;
    const ticksPerBar = tpb * meterNum;
    let bar = 1;
    for (let t = 0; t <= maxTick + ticksPerBar; t += ticksPerBar) {
      marks.push({ tick: t, bar: bar++ });
    }
  } else {
    let bar = 1;
    for (let i = 0; i < changes.length; i++) {
      const segStart = changes[i].tick;
      const ticksPerBar = tpb * (parseMeterNum(changes[i].sig) || 4);
      const segEnd = (i + 1 < changes.length) ? changes[i + 1].tick : maxTick + ticksPerBar;
      for (let t = segStart; t < segEnd; t += ticksPerBar) {
        marks.push({ tick: t, bar: bar++ });
      }
    }
  }
  deck._barMarks = marks;
  return marks;
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

  // Beat + downbeat grid. Walks meter_changes when present so bars line up
  // through signature changes, and numbers each bar 1, 2, 3, … from the
  // start of the track.
  const tpb = getDeckTicksPerBeat(deck);
  const barMarks = computeBarMarks(deck);

  // Faint per-beat ticks (uniform — tpb doesn't change with meter)
  const firstBeat = Math.ceil(startTick / tpb);
  const lastBeat = Math.floor(endTick / tpb);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let b = firstBeat; b <= lastBeat; b++) {
    const x = tickToX(b * tpb);
    ctx.beginPath(); ctx.moveTo(x, pitchedH); ctx.lineTo(x, h); ctx.stroke();
  }
  // Brighter downbeat lines + bar number
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  const labelBars = zoomedEnough(deck);
  ctx.font = '9px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  for (const m of barMarks) {
    if (m.tick < startTick || m.tick > endTick) continue;
    const x = tickToX(m.tick);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    if (labelBars) ctx.fillText(String(m.bar), x + 2, 9);
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
    // Drag handles — chevrons at top/bottom of each boundary line. Visible
    // but unobtrusive; hit zone (in bindPianoRoll) is wider than the glyph.
    const handleFill = deck.loop.active ? '#66d68a' : 'rgba(102,214,138,0.7)';
    const sz = 6 * dpr;
    ctx.fillStyle = handleFill;
    const drawHandle = (x, pointRight) => {
      // Top chevron pointing inward
      ctx.beginPath();
      if (pointRight) {
        ctx.moveTo(x, 0); ctx.lineTo(x + sz, 0); ctx.lineTo(x, sz);
      } else {
        ctx.moveTo(x, 0); ctx.lineTo(x - sz, 0); ctx.lineTo(x, sz);
      }
      ctx.closePath(); ctx.fill();
      // Bottom chevron
      ctx.beginPath();
      if (pointRight) {
        ctx.moveTo(x, h); ctx.lineTo(x + sz, h); ctx.lineTo(x, h - sz);
      } else {
        ctx.moveTo(x, h); ctx.lineTo(x - sz, h); ctx.lineTo(x, h - sz);
      }
      ctx.closePath(); ctx.fill();
    };
    drawHandle(x1, true);
    if (deck.loop.out != null) drawHandle(x2, false);
  }

  // Pending seek marker (dashed, deck colour) — where playhead will jump at next bar
  if (deck.seekPending != null && deck.seekPending >= startTick && deck.seekPending <= endTick) {
    const px = tickToX(deck.seekPending);
    ctx.save();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = deckId === '1' ? 'rgba(92,224,208,0.7)' : 'rgba(255,122,138,0.7)';
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
    ctx.strokeStyle = deckId === '1' ? '#5ce0d0' : '#ff7a8a';
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
    ctx.fillStyle = deckId === '1' ? '#5ce0d0' : '#ff7a8a';
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
    maybeFollowPlayhead('1');
    maybeFollowPlayhead('2');
    paintRoll('1');
    paintRoll('2');
    if (decks['1'].playing || decks['2'].playing) {
      requestAnimationFrame(frame);
    } else {
      rollAnimating = false;
    }
  };
  requestAnimationFrame(frame);
}

// If follow is on and the deck is playing, scroll the view so the playhead
// stays at FOLLOW_ANCHOR_FRAC of the visible window. Re-render the offscreen
// only when offset has shifted ≥ 1 canvas pixel — keeps cost negligible.
const FOLLOW_ANCHOR_FRAC = 0.25;
function toggleFollow(deckId) {
  const deck = decks[deckId];
  if (!deck.rollView) deck.rollView = { zoom: 1, offset: 0, follow: false };
  deck.rollView.follow = !deck.rollView.follow;
  updateFollowUI(deckId);
  if (deck.rollView.follow && !rollAnimating) startRollAnimation();
}
function setFollow(deckId, on) {
  const deck = decks[deckId];
  if (!deck.rollView) return;
  if (deck.rollView.follow === on) return;
  deck.rollView.follow = on;
  updateFollowUI(deckId);
}

// "Start" arming — only when this is on does a single tap on the piano roll
// set the deck's cue/start position. Off by default so pinch/pan/zoom can't
// trip a scrub. Auto-disarms when a seek commits, and on track load.
function toggleStartArmed(deckId) {
  setStartArmed(deckId, !decks[deckId].startArmed);
}
function setStartArmed(deckId, on) {
  const deck = decks[deckId];
  if (deck.startArmed === on) return;
  deck.startArmed = on;
  updateStartArmedUI(deckId);
}
function updateStartArmedUI(deckId) {
  const btn = document.querySelector(`.btn-start[data-deck="${deckId}"]`);
  if (!btn) return;
  btn.classList.toggle('active', !!decks[deckId].startArmed);
}
function updateFollowUI(deckId) {
  const btn = document.querySelector(`.btn-follow[data-deck="${deckId}"]`);
  if (!btn) return;
  btn.classList.toggle('active', !!decks[deckId].rollView?.follow);
}
function maybeFollowPlayhead(deckId) {
  const deck = decks[deckId];
  if (!deck.rollView?.follow || !deck.playing || !deck.rollData) return;
  const z = deck.rollView.zoom;
  if (z <= 1) return; // whole track is on-screen — nothing to follow
  const max = deck.rollData.maxTick || 1;
  const visibleTicks = max / z;
  const targetOffset = Math.max(0, Math.min(1 - 1 / z,
    (deck.currentTick - visibleTicks * FOLLOW_ANCHOR_FRAC) / max
  ));
  const canvas = document.querySelector(`.piano-roll[data-deck="${deckId}"]`);
  const cssW = canvas?.clientWidth || 600;
  const pxShift = Math.abs(targetOffset - deck.rollView.offset) * z * cssW;
  if (pxShift >= 1) {
    deck.rollView.offset = targetOffset;
    renderRollOffscreen(deckId);
  }
}

function bindPianoRoll(deckId) {
  const canvas = document.querySelector(`.piano-roll[data-deck="${deckId}"]`);
  if (!canvas) return;
  // Prevent default page-scroll/zoom inside the canvas
  canvas.style.touchAction = 'none';

  const pointers = new Map(); // pointerId → {x, y}
  let dragMode = null;        // 'scrub' | 'pan' | 'pinch' | 'loopIn' | 'loopOut' | 'loopRegion' | null
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let pinchStartMidFrac = 0.5;  // midpoint as fraction of canvas at pinch start
  let pinchStartWorldX = 0;     // world fraction (0..1) under the midpoint at pinch start
  let panStartX = 0;
  let panStartOffset = 0;
  let loopRegionStartTick = 0;  // tick under cursor when loop-region drag began
  let loopRegionStartIn = 0;
  let loopRegionStartOut = 0;
  // First-finger seek is deferred for SCRUB_GRACE_MS so an incoming
  // second finger can promote the gesture to a pinch without triggering
  // an accidental cue point. Tap-to-seek still works: pointerup before
  // the grace fires the pending seek.
  const SCRUB_GRACE_MS = 90;
  let scrubPendingTimer = null;
  let scrubPendingX = null;
  const cancelPendingScrub = () => {
    if (scrubPendingTimer) { clearTimeout(scrubPendingTimer); scrubPendingTimer = null; }
    scrubPendingX = null;
  };
  const commitPendingScrub = () => {
    if (scrubPendingX != null) seekDeck(deckId, xToTick(scrubPendingX));
    cancelPendingScrub();
    // Single-shot: arming the Start button only buys you ONE seek, then it
    // disarms so the next free-form pinch/pan can't accidentally re-seek.
    setStartArmed(deckId, false);
  };

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

  // Beat-snap helper for loop-handle drag. Distinct from xToTick because we
  // want beat granularity regardless of zoom, and no clamp to view window.
  const xToTickForLoop = (x, snap) => {
    const deck = decks[deckId];
    const rect = canvas.getBoundingClientRect();
    const frac = (x - rect.left) / rect.width;
    const { startTick, endTick } = getRollViewWindow(deck);
    let t = startTick + frac * (endTick - startTick);
    if (snap) {
      const tpb = getDeckTicksPerBeat(deck);
      t = Math.round(t / tpb) * tpb;
    }
    return Math.max(0, Math.round(t));
  };

  // Hit-test a loop handle. Returns 'loopIn' / 'loopOut' / 'loopRegion' / null.
  // Handles win when within 14px of either marker; otherwise a click inside
  // the loop band itself returns 'loopRegion' so the whole loop can be slid.
  const hitTestLoopHandle = (clientX) => {
    const deck = decks[deckId];
    if (deck.loop.in == null || deck.loop.out == null) return null;
    const rect = canvas.getBoundingClientRect();
    const { startTick, endTick } = getRollViewWindow(deck);
    const span = endTick - startTick;
    const tickToCssX = (t) => rect.left + ((t - startTick) / span) * rect.width;
    const HIT = 14;
    const xIn = tickToCssX(deck.loop.in);
    const xOut = tickToCssX(deck.loop.out);
    const dIn = Math.abs(clientX - xIn);
    const dOut = Math.abs(clientX - xOut);
    if (dIn <= HIT && dIn <= dOut) return 'loopIn';
    if (dOut <= HIT) return 'loopOut';
    if (clientX > xIn && clientX < xOut) return 'loopRegion';
    return null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);

    if (pointers.size === 2) {
      // Two-finger gesture: combined pinch-zoom + pan
      cancelPendingScrub();  // first finger's seek never fires
      setFollow(deckId, false);  // user is taking the view manually
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

    // Loop-handle / loop-region drag takes priority over scrub, but only when not shift-panning.
    if (!e.shiftKey) {
      const hit = hitTestLoopHandle(e.clientX);
      if (hit) {
        dragMode = hit;
        if (hit === 'loopRegion') {
          const deck = decks[deckId];
          loopRegionStartTick = xToTickForLoop(e.clientX, false);
          loopRegionStartIn = deck.loop.in;
          loopRegionStartOut = deck.loop.out;
        }
        return;
      }
    }

    panStartX = e.clientX;
    panStartOffset = decks[deckId].rollView.offset;
    if (e.shiftKey) {
      dragMode = 'pan';
      setFollow(deckId, false);
    } else if (decks[deckId].startArmed) {
      dragMode = 'scrub';
      // Defer the seek so a pinch starting milliseconds later can cancel it.
      scrubPendingX = e.clientX;
      scrubPendingTimer = setTimeout(() => {
        scrubPendingTimer = null;
        if (dragMode === 'scrub') commitPendingScrub();
      }, SCRUB_GRACE_MS);
    } else {
      // Roll is view-only unless Start is armed. Absorb the touch so it
      // doesn't fall through; pinch/loop-handle/loop-region drags above
      // remain reachable on multi-finger or specific-target gestures.
      dragMode = null;
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
      // First move commits the pending tap-seek and switches to live scrub.
      cancelPendingScrub();
      seekDeck(deckId, xToTick(e.clientX, !e.shiftKey));
      return;
    }

    if (dragMode === 'loopRegion') {
      const deck = decks[deckId];
      const tpb = getDeckTicksPerBeat(deck);
      const curTick = xToTickForLoop(e.clientX, false);
      let delta = curTick - loopRegionStartTick;
      if (!e.shiftKey && tpb > 0) delta = Math.round(delta / tpb) * tpb;
      let newIn = loopRegionStartIn + delta;
      let newOut = loopRegionStartOut + delta;
      if (newIn < 0) { newOut -= newIn; newIn = 0; }
      deck.loop.in = newIn;
      deck.loop.out = newOut;
      paintRoll(deckId);
      return;
    }

    if (dragMode === 'loopIn' || dragMode === 'loopOut') {
      const deck = decks[deckId];
      const tpb = getDeckTicksPerBeat(deck);
      const minLen = tpb; // one beat
      let t = xToTickForLoop(e.clientX, !e.shiftKey);
      if (dragMode === 'loopIn') {
        // Guard: don't cross/overlap the out marker — clamp to one beat below it
        if (deck.loop.out != null && t > deck.loop.out - minLen) t = deck.loop.out - minLen;
        if (t < 0) t = 0;
        deck.loop.in = t;
      } else {
        if (deck.loop.in != null && t < deck.loop.in + minLen) t = deck.loop.in + minLen;
        deck.loop.out = t;
      }
      // Keep beat count in sync so the length spinner reflects manual drags
      if (deck.loop.in != null && deck.loop.out != null && tpb > 0) {
        deck.loop.beats = (deck.loop.out - deck.loop.in) / tpb;
      }
      paintRoll(deckId);
      return;
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      // Tap (no move, finger lifted before grace expires) → commit seek.
      if (dragMode === 'scrub') commitPendingScrub();
      cancelPendingScrub();
      dragMode = null;
    } else if (pointers.size === 1) {
      dragMode = 'scrub';
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Wheel: vertical scroll = zoom (mouse wheel, trackpad pinch arriving as
  // wheel+ctrlKey, cmd+wheel). Shift+wheel or a horizontal-dominant trackpad
  // swipe = pan.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const deck = decks[deckId];
    if (!deck.rollData) return;
    setFollow(deckId, false);  // wheel = manual view control
    const rect = canvas.getBoundingClientRect();
    const anchorFrac = (e.clientX - rect.left) / rect.width;
    const isHorizontalSwipe = !e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (e.shiftKey || isHorizontalSwipe) {
      const primary = e.deltaX || e.deltaY;
      const panAmount = primary / 600;
      setRollOffset(deckId, deck.rollView.offset + panAmount / deck.rollView.zoom);
    } else {
      const zoomFactor = Math.exp(-e.deltaY * 0.005);
      setRollZoom(deckId, deck.rollView.zoom * zoomFactor, anchorFrac);
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

// Change the staged loop length. If a loop is currently active, re-length it
// live (keep loop.in, recompute loop.out). If inactive, just stash the value
// for the next engage. Driven by the per-deck length spinner.
// 27-entry loop-length list using music-theory bars (1 bar = 4 beats in 4/4).
// Half-beat increments through the sub-bar zone keep their "beat" labels;
// whole multiples of a bar use the "bar" label with the beat count as
// sublabel so the conversion is always visible.
const LOOP_LENGTHS = [
  { value: 0.125, label: '1/8 beat' },
  { value: 0.25,  label: '1/4 beat' },
  { value: 0.5,   label: '1/2 beat' },
  { value: 1,     label: '1 beat'   },
  { value: 1.5,   label: '1.5 beat' },
  { value: 2,     label: '2 beat'   },
  { value: 2.5,   label: '2.5 beat' },
  { value: 3,     label: '3 beat'   },
  { value: 3.5,   label: '3.5 beat' },
  { value: 4,     label: '1 bar',   sublabel: '4 beat'   },
  { value: 4.5,   label: '4.5 beat' },
  { value: 5,     label: '5 beat'   },
  { value: 5.5,   label: '5.5 beat' },
  { value: 6,     label: '1.5 bar', sublabel: '6 beat'   },
  { value: 6.5,   label: '6.5 beat' },
  { value: 7,     label: '7 beat'   },
  { value: 7.5,   label: '7.5 beat' },
  { value: 8,     label: '2 bar',   sublabel: '8 beat'   },
  { value: 12,    label: '3 bar',   sublabel: '12 beat'  },
  { value: 16,    label: '4 bar',   sublabel: '16 beat'  },
  { value: 24,    label: '6 bar',   sublabel: '24 beat'  },
  { value: 32,    label: '8 bar',   sublabel: '32 beat'  },
  { value: 48,    label: '12 bar',  sublabel: '48 beat'  },
  { value: 64,    label: '16 bar',  sublabel: '64 beat'  },
  { value: 96,    label: '24 bar',  sublabel: '96 beat'  },
  { value: 128,   label: '32 bar',  sublabel: '128 beat' },
  { value: 256,   label: '64 bar',  sublabel: '256 beat' },
];
const DEFAULT_LOOP_BEATS = 4;

function setLoopLength(deckId, beats) {
  const deck = decks[deckId];
  if (!deck.midi) return;
  deck.loop.beats = beats;
  if (deck.loop.active && deck.loop.in != null) {
    const tpb = getDeckTicksPerBeat(deck);
    deck.loop.out = deck.loop.in + beats * tpb;
    paintRoll(deckId);
  }
  updateLoopUI(deckId);
}

// Engage a loop at the current staged length, or — if already looping — arm
// the exit so it plays out to loop.out then continues. Driven by the Loop btn.
function toggleLoop(deckId) {
  const deck = decks[deckId];
  if (!deck.midi || !deck.loop.beats) return;
  if (deck.loop.active) {
    deck.loop.pendingExit = !deck.loop.pendingExit;
    updateLoopUI(deckId);
    return;
  }
  setBeatLoop(deckId, deck.loop.beats);
}

function setBeatLoop(deckId, beats) {
  const deck = decks[deckId];
  if (!deck.midi) return;
  const tpb = getDeckTicksPerBeat(deck);
  const live = getLivePlaybackTick(deck);
  // Quantise loop start: sub-beat loops snap to their own length, whole-beat
  // loops snap to the perceived beat grid.
  const snapUnit = Math.min(beats, 1) * tpb;
  const startTick = Math.round(live / snapUnit) * snapUnit;
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
  if (base) {
    const fold = deck.timeFold || 1;
    const foldNote = fold === 1 ? '' : ` × ${fold === 0.5 ? '½' : '2'} fold`;
    bpmEl.title = `Native ${base} → playing at master ${master.bpm} BPM${foldNote}`;
  } else {
    bpmEl.title = '';
  }
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
  const ts = panicStamp();
  for (const [key] of [...deck.activeNotes]) {
    const [oc, note] = key.split(':').map(Number);
    if (oc !== 9) {
      dispatchNoteOff(deck, oc, note, ts);
      deck.activeNotes.delete(key);
    }
  }
  deck.transpose = semitones;
  updateTransposeUI(deckId);
}

// Time-fold (½×/1×/2×) — multiplies playback rate against master without
// changing master.bpm. Implemented entirely through deck.pitch (see
// syncDeckToMaster); raw-tick beat math is unchanged.
const TIME_FOLDS = [0.5, 1, 2];
const TIME_FOLD_LABELS = { 0.5: '½×', 1: '1×', 2: '2×' };

function setTimeFold(deckId, fold) {
  const deck = decks[deckId];
  if (!TIME_FOLDS.includes(fold) || fold === deck.timeFold) return;
  deck.timeFold = fold;
  syncDeckToMaster(deckId);
  updateTimeFoldUI(deckId);
  // Mid-playback fold changes: silence + resume from the live tick so the new
  // rate takes effect immediately and no notes hang at the old msPerTick.
  if (deck.playing) {
    const liveTick = Math.round(getLivePlaybackTick(deck));
    playDeck(deckId, liveTick);
  }
}

function updateTimeFoldUI(deckId) {
  const deck = decks[deckId];
  const root = document.querySelector(`#deck-${deckId} .time-fold`);
  if (!root) return;
  root.querySelectorAll('.time-fold-btn').forEach(btn => {
    const v = parseFloat(btn.dataset.fold);
    btn.classList.toggle('active', v === deck.timeFold);
  });
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
      keyEl.textContent = formatKey(deck.meta.key);
    } else {
      const [tonic, mode] = deck.meta.key.split(' ');
      const tonicIdx = NOTE_NAMES.indexOf(tonic);
      if (tonicIdx >= 0) {
        const shifted = NOTE_NAMES[((tonicIdx + deck.transpose) % 12 + 12) % 12];
        keyEl.textContent = `${formatKey(deck.meta.key)}▸${formatKey(`${shifted} ${mode}`)}`;
      }
    }
  }
}

function updateLoopUI(deckId) {
  const deck = decks[deckId];
  const root = document.querySelector(`#deck-${deckId}`);
  if (!root) return;
  const btn = root.querySelector('.btn-loop-toggle');
  if (btn) {
    btn.classList.toggle('active', deck.loop.active && !deck.loop.pendingExit);
    btn.classList.toggle('exiting', deck.loop.active && deck.loop.pendingExit);
  }
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

// Compact jazz-style key labels: "C major" → "C△", "A minor" → "A-".
function formatKey(k) {
  if (!k) return '—';
  const [tonic, mode] = k.split(' ');
  if (mode === 'minor') return `${tonic}-`;
  if (mode === 'major') return `${tonic}△`;
  return k;
}

function updateDeckStats(deckId, meta) {
  const root = document.querySelector(`#deck-${deckId}`);
  if (!root) return;
  root.querySelector('.stat-bpm').textContent = meta?.bpm ?? '—';
  root.querySelector('.stat-key').textContent = formatKey(meta?.key);
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

// `entry`, when provided, is a playlist entry whose overrides (cue tick, loop
// in/out + armed-on-load, output mutes, transpose, time-fold, volume) are
// applied to the deck after the track parses. Plain library loads pass no
// entry. Pre-fetched MIDI is consumed transparently when available.
async function loadTrackIntoDeck(deckId, track, entry) {
  try {
    let midi, rollData;
    const cached = consumePrefetch(track.path);
    if (cached) {
      midi = cached.midi;
      rollData = cached.rollData;
    } else {
      const res = await fetch(track.path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      // Parsing happens off-thread; the playing deck's scheduler keeps ticking
      ({ midi, rollData } = await parseInWorker(buffer, { dropChannels: track.drop_channels }));
    }

    stopDeck(deckId);
    decks[deckId].midi = midi;
    decks[deckId].meta = track;
    decks[deckId].currentTick = 0;
    // Preserve the loop length the user has dialled on the spinner; only
    // clear the active loop's anchors / state on track load.
    const keptBeats = decks[deckId].loop?.beats ?? DEFAULT_LOOP_BEATS;
    decks[deckId].loop = { in: null, out: null, active: false, beats: keptBeats, pendingExit: false };
    decks[deckId].transpose = 0;
    decks[deckId].timeFold = 1;
    decks[deckId].outputMute = new Set();
    decks[deckId].rollView = { zoom: 1, offset: 0, follow: decks[deckId].rollView?.follow || false };
    decks[deckId].rollData = rollData; // pre-computed in the worker
    decks[deckId]._barMarks = null;    // invalidate cached bar marks
    cancelDrop(deckId);
    cancelPendingSeek(deckId);
    setStartArmed(deckId, false);
    const nameEl = document.querySelector(`#deck-${deckId} .track-name`);
    applyGameFontToTrackName(nameEl, track);
    updateDeckSkin(deckId, track.game);
    nameEl.classList.remove('muted');
    updateDeckStats(deckId, track);
    if (!master.autoSet && track.perceived_bpm) {
      setMasterBpm(track.perceived_bpm);
      if (masterBpmSlider) masterBpmSlider.setValue(master.bpm);
      master.autoSet = true;
    }
    syncDeckToMaster(deckId);
    updateTransposeUI(deckId);
    updateTimeFoldUI(deckId);
    buildRoutingUI(deckId, midi);

    // Apply playlist entry overrides last, so they win over the resets above.
    if (entry) applyEntryOverridesToDeck(deckId, entry);

    updateLoopUI(deckId);
    // Paint a placeholder (background + playhead) immediately so the deck looks responsive
    paintRoll(deckId);
    // Defer the heavy offscreen render until the browser is idle, so audio scheduling
    // on the other deck gets priority. Falls back to a deferred setTimeout on browsers
    // without requestIdleCallback.
    deferRollRender(deckId);

    // Eagerly prefetch the next entry from the playlist so the next swap is
    // a state-assignment instead of a fetch+parse round-trip.
    if (entry) {
      const next = getNextEntryAfter(entry.id);
      if (next) {
        const nextTrack = trackLibrary.find(t => t.path === next.path);
        if (nextTrack) prefetchTrack(nextTrack);
      }
    }
  } catch (err) {
    console.error('Load failed', track.path, err);
    alert(`Failed to load: ${track.path}\n${err.message}`);
  }
}

// Apply playlist-entry overrides to a freshly-loaded deck. Anything missing
// from the entry is left at its post-load default, so a sparse entry only
// touches what it explicitly sets.
function applyEntryOverridesToDeck(deckId, entry) {
  const deck = decks[deckId];
  if (Number.isFinite(entry.cueTick)) {
    deck.currentTick = Math.max(0, Math.floor(entry.cueTick));
  }
  if (Number.isFinite(entry.transpose)) deck.transpose = entry.transpose;
  if (Number.isFinite(entry.timeFold)) deck.timeFold = entry.timeFold;
  if (Number.isFinite(entry.volume)) deck.volume = entry.volume;
  if (Array.isArray(entry.outputMutes)) deck.outputMute = new Set(entry.outputMutes);
  if (entry.loop && Number.isFinite(entry.loop.in) && Number.isFinite(entry.loop.out)) {
    deck.loop.in = entry.loop.in;
    deck.loop.out = entry.loop.out;
    if (Number.isFinite(entry.loop.beats)) deck.loop.beats = entry.loop.beats;
    deck.loop.active = !!entry.loop.armed;
  }
  syncDeckToMaster(deckId);
  updateTransposeUI(deckId);
  updateTimeFoldUI(deckId);
  renderRoutingPills(deckId);
}

let browserState = { search: '', games: new Set(), sort: 'game', dir: 1 };

const COLUMNS = [
  { key: 'title', label: 'title' },
  { key: 'game', label: 'game' },
  { key: 'release', label: 'release' },
  { key: 'bpm', label: 'bpm' },
  { key: 'key', label: 'key' },
  { key: 'meter', label: 'meter' },
  { key: 'tags', label: 'tags' },
  { key: 'duration_sec', label: 'len' },
];

const TAG_ORDER = ['drums', 'bass', 'chords', 'lead'];

function tagSortKey(t) {
  // Stable string: drums/bass/chords/lead as ones/zeros — full band sorts first
  return TAG_ORDER.map(tag => (t.tags ?? []).includes(tag) ? '1' : '0').join('');
}

function trackBpm(t) { return t.perceived_bpm ?? t.bpm ?? 0; }

function sortComparator(key) {
  if (key === 'game') return (a, b) => a.game.localeCompare(b.game) || (a.release ?? '').localeCompare(b.release ?? '') || a.title.localeCompare(b.title);
  if (key === 'release') return (a, b) => (a.release ?? '').localeCompare(b.release ?? '') || a.game.localeCompare(b.game) || a.title.localeCompare(b.title);
  if (key === 'title') return (a, b) => a.title.localeCompare(b.title);
  if (key === 'key') return (a, b) => (a.key ?? '').localeCompare(b.key ?? '');
  if (key === 'meter') return (a, b) => (a.meter ?? '').localeCompare(b.meter ?? '');
  if (key === 'bpm') return (a, b) => trackBpm(a) - trackBpm(b);
  if (key === 'tags') return (a, b) => tagSortKey(b).localeCompare(tagSortKey(a)) || a.title.localeCompare(b.title);
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

// Current browser order (filter + sort applied). Shared between the visible
// browser list and the auto-advance "what plays next?" lookup.
function getBrowserOrder() {
  const { search, games: gameFilter, sort: sortKey, dir } = browserState;
  let filtered = trackLibrary.filter(t => {
    if (gameFilter.size > 0 && !gameFilter.has(t.game)) return false;
    if (!search) return true;
    return t.title.toLowerCase().includes(search) || t.game.toLowerCase().includes(search);
  });
  const cmp = sortComparator(sortKey);
  filtered.sort((a, b) => cmp(a, b) * dir);
  return filtered;
}

function findNextTrackAfter(currentPath) {
  const order = getBrowserOrder();
  if (!order.length) return null;
  const idx = order.findIndex(t => t.path === currentPath);
  // Wrap around if currentPath isn't in the filtered set (browser narrowed since load)
  if (idx < 0) return order[0];
  return order[(idx + 1) % order.length];
}

function renderBrowser() {
  const filtered = getBrowserOrder();
  const { sort: sortKey, dir } = browserState;

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

  const frag = document.createDocumentFragment();
  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i];
    const row = document.createElement('div');
    // Mark heavily tempo-mapped / rubato tracks as unstable so the eye skips
    // past them when looking for mix-friendly material on stage.
    const unstable = (t.tempo_changes ?? 0) > 3;
    row.className = `track-row${unstable ? ' unstable' : ''}`;
    if (unstable) row.title = `${t.tempo_changes} tempo events — likely rubato / not mix-friendly`;
    const tagsHtml = (t.tags ?? []).map(tag =>
      `<span class="t-tag t-tag-${tag}">${tag}</span>`
    ).join('');
    row.innerHTML = `
      <span class="t-title" title="${t.title}">${t.title}</span>
      <span class="t-game">${t.game}</span>
      <span class="t-release" title="${t.release ?? ''}">${t.release ?? '—'}</span>
      <span class="t-bpm">${trackBpm(t) || '—'}</span>
      <span class="t-key">${formatKey(t.key)}</span>
      <span class="t-meter">${t.meter ?? '—'}${t.meter_changes ? '*' : ''}</span>
      <span class="t-tags">${tagsHtml}</span>
      <span class="t-len">${formatDuration(t.duration_sec)}</span>
      <span class="load-btns">
        <button class="to-a">1</button>
        <button class="to-b">2</button>
        <button class="to-pl" title="add to current playlist">+pl</button>
      </span>
    `;
    row.querySelector('.to-a').addEventListener('click', () => loadTrackIntoDeck('1', t));
    row.querySelector('.to-b').addEventListener('click', () => loadTrackIntoDeck('2', t));
    row.querySelector('.to-pl').addEventListener('click', () => {
      addEntryToCurrentPlaylist(t.path);
      // Re-render the playlist pane in case it's visible alongside (and to
      // refresh the playlist-select dropdown contents).
      renderPlaylistPane();
      flashButton(row.querySelector('.to-pl'), 'flash', 200);
    });
    frag.appendChild(row);
  }
  list.appendChild(frag);
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

// ──────────────────────────────────────────────────────────────
// Playlist pane — render + interactions
// ──────────────────────────────────────────────────────────────
function setCatalogMode(mode) {
  if (mode !== 'library' && mode !== 'playlist') return;
  playlistStore.mode = mode;
  savePlaylistStore();
  document.querySelectorAll('.cat-mode').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const lib = document.getElementById('library-pane');
  const pl  = document.getElementById('playlist-pane');
  if (lib) lib.hidden = mode !== 'library';
  if (pl)  pl.hidden  = mode !== 'playlist';
  if (mode === 'playlist') renderPlaylistPane();
}

function renderPlaylistSelect() {
  const sel = document.getElementById('playlist-select');
  if (!sel) return;
  sel.innerHTML = '';
  if (!playlistStore.playlists.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no playlists —';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const p of playlistStore.playlists) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.entries.length})`;
    if (p.id === playlistStore.currentId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderPlaylistPane() {
  renderPlaylistSelect();
  const list = document.getElementById('playlist-entries');
  const count = document.getElementById('playlist-count');
  if (!list) return;
  list.innerHTML = '';
  const p = getCurrentPlaylist();
  if (count) count.textContent = p ? `${p.entries.length} entries` : '';
  if (!p) {
    const empty = document.createElement('div');
    empty.className = 'pl-row empty';
    empty.textContent = 'No playlist selected. Tap "+ new" to create one, then switch to library and use "+pl" on any row to add tracks.';
    list.appendChild(empty);
    return;
  }
  if (!p.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'pl-row empty';
    empty.textContent = 'Empty playlist. Switch to library and tap "+pl" on a track row to add it.';
    list.appendChild(empty);
    return;
  }

  // Column-header strip so users can read what each column is without
  // hovering for tooltips on mobile.
  const header = document.createElement('div');
  header.className = 'pl-header';
  header.innerHTML = `
    <span>#</span>
    <span></span>
    <span>title — game</span>
    <span>bpm</span>
    <span>key</span>
    <span>meter</span>
    <span>len</span>
    <span>parts</span>
    <span>saved</span>
    <span></span>
    <span>load</span>
    <span>save from</span>
    <span></span>
  `;
  list.appendChild(header);

  const deck1Path = decks['1']?.meta?.path ?? null;
  const deck2Path = decks['2']?.meta?.path ?? null;

  const frag = document.createDocumentFragment();
  p.entries.forEach((entry, i) => {
    const track = trackLibrary.find(t => t.path === entry.path);
    const row = document.createElement('div');
    row.className = 'pl-row';
    row.dataset.entryId = entry.id;
    if (!track) row.classList.add('missing');
    const unstable = track && (track.tempo_changes ?? 0) > 3;
    if (unstable) row.classList.add('unstable');

    // On-deck indicator: this entry's track currently loaded on deck 1 / 2
    const on1 = track && deck1Path === track.path;
    const on2 = track && deck2Path === track.path;
    const dotClass = on1 && on2 ? 'on-both' : on1 ? 'on-1' : on2 ? 'on-2' : '';

    // Captured-state badges — show exactly which overrides this entry stores
    const caps = [];
    if (Number.isFinite(entry.cueTick) && entry.cueTick > 0) caps.push('cue');
    if (entry.loop && Number.isFinite(entry.loop.in) && Number.isFinite(entry.loop.out)) {
      caps.push(entry.loop.armed ? 'loop★' : 'loop');
    }
    if (Array.isArray(entry.outputMutes) && entry.outputMutes.length) caps.push('mute');
    if (Number.isFinite(entry.transpose) && entry.transpose !== 0) {
      caps.push(`${entry.transpose > 0 ? '+' : ''}${entry.transpose}`);
    }
    if (Number.isFinite(entry.timeFold) && entry.timeFold !== 1) caps.push(`${entry.timeFold}×`);

    const tagsHtml = track ? (track.tags ?? []).map(tag =>
      `<span class="t-tag t-tag-${tag}">${tag}</span>`
    ).join('') : '';

    const title = track ? track.title : '(missing — track removed from library)';
    const game = track ? track.game : entry.path;
    const bpm = track ? (track.perceived_bpm ?? track.bpm ?? '—') : '—';
    const keyDisp = track ? (formatKey(track.key) ?? '—') : '—';
    const meterDisp = track
      ? `${track.meter ?? '—'}${track.meter_changes ? '*' : ''}`
      : '—';
    const lenDisp = track ? formatDuration(track.duration_sec) : '—';

    row.innerHTML = `
      <span class="pl-idx">${i + 1}</span>
      <span class="pl-on-deck ${dotClass}" title="${on1 && on2 ? 'on both decks' : on1 ? 'on deck 1' : on2 ? 'on deck 2' : 'not loaded'}"></span>
      <span class="pl-title" title="${title} — ${game}">
        ${title}<span class="pl-game">— ${game}</span>
      </span>
      <span class="pl-bpm">${bpm}</span>
      <span class="pl-key">${keyDisp}</span>
      <span class="pl-meter">${meterDisp}</span>
      <span class="pl-len">${lenDisp}</span>
      <span class="pl-tags">${tagsHtml}</span>
      <span class="pl-caps">${
        caps.length
          ? caps.map(c => `<span class="pl-cap-badge">${c}</span>`).join('')
          : '<span class="pl-fresh">fresh</span>'
      }</span>
      <span class="pl-move-stack">
        <button class="pl-move pl-up" title="move up">▴</button>
        <button class="pl-move pl-down" title="move down">▾</button>
      </span>
      <span class="pl-loads">
        <button class="pl-load-a" title="load on deck 1 with this entry's saved settings">1</button>
        <button class="pl-load-b" title="load on deck 2 with this entry's saved settings">2</button>
      </span>
      <span class="pl-caps-btns">
        <button class="pl-cap-a" title="snapshot deck 1's current cue/loop/mutes/transpose into this entry">←1</button>
        <button class="pl-cap-b" title="snapshot deck 2's current cue/loop/mutes/transpose into this entry">←2</button>
      </span>
      <button class="pl-remove" title="remove from playlist">×</button>
    `;
    const refreshAfterMutate = () => { renderPlaylistPane(); };
    row.querySelector('.pl-up').addEventListener('click', () => { moveEntryInCurrent(entry.id, -1); refreshAfterMutate(); });
    row.querySelector('.pl-down').addEventListener('click', () => { moveEntryInCurrent(entry.id, +1); refreshAfterMutate(); });
    row.querySelector('.pl-load-a').addEventListener('click', () => {
      if (track) loadTrackIntoDeck('1', track, entry).then(refreshAfterMutate);
    });
    row.querySelector('.pl-load-b').addEventListener('click', () => {
      if (track) loadTrackIntoDeck('2', track, entry).then(refreshAfterMutate);
    });
    row.querySelector('.pl-cap-a').addEventListener('click', () => {
      if (captureDeckIntoEntry('1', entry.id)) refreshAfterMutate();
    });
    row.querySelector('.pl-cap-b').addEventListener('click', () => {
      if (captureDeckIntoEntry('2', entry.id)) refreshAfterMutate();
    });
    row.querySelector('.pl-remove').addEventListener('click', () => {
      removeEntryFromCurrent(entry.id);
      refreshAfterMutate();
    });
    frag.appendChild(row);
  });
  list.appendChild(frag);
}

function wirePlaylistPaneControls() {
  document.querySelectorAll('.cat-mode').forEach(btn => {
    btn.addEventListener('click', () => setCatalogMode(btn.dataset.mode));
  });
  const sel = document.getElementById('playlist-select');
  if (sel) sel.addEventListener('change', () => {
    if (sel.value) { setCurrentPlaylist(sel.value); renderPlaylistPane(); }
  });
  document.getElementById('playlist-new')?.addEventListener('click', () => {
    const name = (prompt('Playlist name', `Set ${playlistStore.playlists.length + 1}`) || '').trim();
    if (!name) return;
    createPlaylist(name);
    renderPlaylistPane();
  });
  document.getElementById('playlist-rename')?.addEventListener('click', () => {
    const p = getCurrentPlaylist();
    if (!p) return;
    const name = (prompt('Rename playlist', p.name) || '').trim();
    if (!name) return;
    renameCurrentPlaylist(name);
    renderPlaylistPane();
  });
  document.getElementById('playlist-duplicate')?.addEventListener('click', () => {
    duplicateCurrentPlaylist();
    renderPlaylistPane();
  });
  document.getElementById('playlist-delete')?.addEventListener('click', () => {
    const p = getCurrentPlaylist();
    if (!p) return;
    if (!confirm(`Delete playlist "${p.name}"? This can't be undone.`)) return;
    deleteCurrentPlaylist();
    renderPlaylistPane();
  });
}

async function initBrowser() {
  try {
    const res = await fetch('tracks.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    trackLibrary = data.tracks;
    // Used as a cache-buster on per-deck skin image URLs so a manifest regen
    // (which only happens when the user runs `npm run manifest` — typically
    // after replacing midi-files or image assets) forces a fresh fetch.
    manifestVersion = data.generated || '';

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
    // Playlist pane is rendered lazily when its mode is selected, but the
    // current mode might already be 'playlist' from a prior session.
    renderPlaylistPane();
  } catch (err) {
    document.getElementById('browser-list').textContent = `Library load failed: ${err.message}`;
  }
}

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────
function init() {
  initMIDI();
  loadPlaylistStore();
  wirePlaylistPaneControls();
  // Restore the catalog mode the user left in (library or playlist).
  setCatalogMode(playlistStore.mode);
  initBrowser();

  // Master BPM slider — the single source of truth; both decks warp to this
  masterBpmSlider = mountSlider(document.querySelector('.cslider[data-target="bpm"]'), {
    onInput: (v) => { setMasterBpm(v); },
  });

  // Master meter spinner
  masterMeterSpinner = mountSpinner(document.getElementById('master-meter-mount'), {
    options: [2, 3, 4, 5, 6, 7, 8].map(n => ({ value: n, label: `${n}/4` })),
    value: master.meter,
    className: 'compact',
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
  for (const deckId of ['1', '2']) {
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
        const startTick = decks[deckId].currentTick || getDeckBeatOneTick(decks[deckId]);
        anchorMasterToDeck(deckId, startTick);
        playDeck(deckId, startTick);
      }
    });
    document.querySelector(`.btn-cue[data-deck="${deckId}"]`).addEventListener('click', () => {
      setCue(deckId, cuedDeck !== deckId);
    });
    document.querySelector(`.btn-follow[data-deck="${deckId}"]`).addEventListener('click', () => toggleFollow(deckId));
    updateFollowUI(deckId);
    document.querySelector(`.btn-start[data-deck="${deckId}"]`).addEventListener('click', () => toggleStartArmed(deckId));
    updateStartArmedUI(deckId);
    document.querySelector(`.btn-drop[data-deck="${deckId}"]`).addEventListener('click', () => {
      if (decks[deckId].dropPending) cancelDrop(deckId);
      else dropDeck(deckId);
    });
    document.querySelector(`.btn-trans[data-deck="${deckId}"]`).addEventListener('click', () => transitionDeck(deckId));
    document.querySelector(`.btn-cut[data-deck="${deckId}"]`).addEventListener('click', () => cutDeck(deckId));
    document.querySelector(`.btn-channel[data-deck="${deckId}"]`).addEventListener('click', () => flipDeckChannel(deckId));
    document.querySelector(`.btn-unmute-all[data-deck="${deckId}"]`).addEventListener('click', () => unmuteAllOutputs(deckId));
    document.querySelector(`.btn-auto[data-deck="${deckId}"]`).addEventListener('click', () => toggleAutoAdvance(deckId));
    updateChannelToggleUI(deckId);
    updateAutoAdvanceUI(deckId);

    // Loop: toggle button + length spinner
    document.querySelector(`.btn-loop-toggle[data-deck="${deckId}"]`).addEventListener('click', () => toggleLoop(deckId));
    mountSpinner(document.querySelector(`.loop-length-mount[data-deck="${deckId}"]`), {
      options: LOOP_LENGTHS,
      value: DEFAULT_LOOP_BEATS,
      className: 'compact',
      onChange: (v) => setLoopLength(deckId, v),
    });
    decks[deckId].loop.beats = DEFAULT_LOOP_BEATS;

    // Transpose ± buttons
    document.querySelectorAll(`.transpose-btn[data-deck="${deckId}"]`).forEach(btn => {
      btn.addEventListener('click', () => {
        setTranspose(deckId, decks[deckId].transpose + parseInt(btn.dataset.delta));
      });
    });

    // Time-fold (½/1/2×) segmented buttons
    document.querySelectorAll(`#deck-${deckId} .time-fold-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        setTimeFold(deckId, parseFloat(btn.dataset.fold));
      });
    });
    updateTimeFoldUI(deckId);

    // Piano roll
    bindPianoRoll(deckId);
  }

  // Stop all
  document.getElementById('btn-stop-all').addEventListener('click', () => {
    stopDeck('1'); stopDeck('2');
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

  initSettingsModal();
}

const SETTINGS_SKIN_KEY = 'vgmdj-skin-on';
function readSkinSetting() {
  const v = localStorage.getItem(SETTINGS_SKIN_KEY);
  return v == null ? true : v === '1';
}
function applySkinSetting(on) {
  document.body.classList.toggle('skin-off', !on);
  localStorage.setItem(SETTINGS_SKIN_KEY, on ? '1' : '0');
}

// CUE output channel pair — which device output channels the cue-preview
// audio routes to. Stored as a comma-separated pair like "2,3" (zero-indexed
// to match Web Audio channel numbering; 0,1 = main stereo; 2,3 = ch 3/4).
const SETTINGS_CUE_CHANNELS_KEY = 'vgmdj-cue-channels';
let cueChannelsSelected = null;     // [leftIdx, rightIdx]
let cueChannelsDropdown = null;

function readCueChannelsSetting() {
  const raw = localStorage.getItem(SETTINGS_CUE_CHANNELS_KEY);
  if (raw) {
    const parts = raw.split(',').map(n => parseInt(n, 10)).filter(n => Number.isFinite(n));
    if (parts.length === 2) return parts;
  }
  return null;
}
function writeCueChannelsSetting(pair) {
  localStorage.setItem(SETTINGS_CUE_CHANNELS_KEY, pair.join(','));
}

function maxOutputChannels() {
  const synth = getTestSynth?.();
  const ctx = synth?._ctx;
  if (ctx && ctx.destination) {
    return Math.max(2, ctx.destination.maxChannelCount || 2);
  }
  return 2;
}

function buildCuePairOptions(maxCh) {
  // Generate stereo pairs: (1/2), (3/4), (5/6), ... up to the device max.
  const opts = [];
  for (let i = 0; i < maxCh; i += 2) {
    if (i + 1 >= maxCh) break;
    const label = `${i + 1} / ${i + 2}` + (i === 0 ? '  (main)' : '');
    opts.push({ id: `${i},${i + 1}`, label });
  }
  return opts;
}

function applyCueChannelsRouting() {
  // Reroute the preview synth's audio output through a ChannelMergerNode
  // targeting the chosen output channels. Best-effort: if multi-channel
  // isn't supported on this device, silently stays on the main pair.
  const synth = getTestSynth?.();
  const ctx = synth?._ctx;
  if (!ctx || !synth || typeof synth.setAudioContext !== 'function') return;
  const [L, R] = cueChannelsSelected || [0, 1];
  const maxCh = maxOutputChannels();
  if (L < 0 || R < 0 || L >= maxCh || R >= maxCh) {
    synth.setAudioContext(ctx, ctx.destination);
    return;
  }
  try {
    ctx.destination.channelCount = Math.max(ctx.destination.channelCount || 2, R + 1, L + 1);
    ctx.destination.channelInterpretation = 'discrete';
  } catch (e) { /* device may not allow it */ }
  // Route synth → splitter (stereo) → merger → destination, sending L/R to chosen channels.
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(Math.max(2, R + 1, L + 1));
  splitter.connect(merger, 0, L);
  splitter.connect(merger, 1, R);
  merger.connect(ctx.destination);
  // Re-target the synth's destination node to our splitter.
  try { synth.setAudioContext(ctx, splitter); } catch (e) { /* swallow */ }
}

function refreshCueChannelsDropdown() {
  const mount = document.getElementById('settings-cue-channels-mount');
  if (!mount) return;
  const maxCh = maxOutputChannels();
  const opts = buildCuePairOptions(maxCh);
  // Default: 3/4 if available, else 1/2.
  if (!cueChannelsSelected) {
    cueChannelsSelected = readCueChannelsSetting()
      || (maxCh >= 4 ? [2, 3] : [0, 1]);
  }
  // Clamp if user previously chose a pair that's no longer available.
  const [L, R] = cueChannelsSelected;
  if (L >= maxCh || R >= maxCh) cueChannelsSelected = (maxCh >= 4 ? [2, 3] : [0, 1]);
  const currentId = cueChannelsSelected.join(',');

  const hint = document.getElementById('settings-cue-hint');
  if (hint) {
    hint.textContent = maxCh >= 4
      ? `This device exposes ${maxCh} output channels. Pick the pair your headphones (or AUM headphone bus) live on.`
      : 'Only stereo output detected. Connect a multi-channel audio interface (or route via AUM with extra outs) to enable headphone cueing on a separate pair.';
  }

  if (cueChannelsDropdown) {
    cueChannelsDropdown.setOptions(opts);
    cueChannelsDropdown.setValue(currentId);
    return;
  }
  cueChannelsDropdown = mountDropdown(mount, {
    options: opts,
    value: currentId,
    placeholder: 'channel pair',
    onChange: (id) => {
      const pair = id.split(',').map(n => parseInt(n, 10));
      if (pair.length !== 2) return;
      cueChannelsSelected = pair;
      writeCueChannelsSetting(pair);
      applyCueChannelsRouting();
    }
  });
}

function initSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const open = () => {
    modal.hidden = false;
    refreshSettingsMidiPortDropdown();
    refreshCueChannelsDropdown();
  };
  const close = () => { modal.hidden = true; };
  document.getElementById('settings-btn').addEventListener('click', open);
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  // Skin toggle (persisted)
  applySkinSetting(readSkinSetting());
  mountToggle(document.getElementById('settings-skin-toggle'), {
    initial: readSkinSetting(),
    onChange: (on) => applySkinSetting(on),
  });

  // CUE channels: read persisted choice; routing applies once the test
  // synth's AudioContext exists (lazy — on first preview-mode unlock).
  cueChannelsSelected = readCueChannelsSetting();
}

init();

// Surface a narrow handle for the LCXL3 integration module (lcxl3-integration.js).
// app.js itself is non-module; the LCXL3 driver is. This namespace is the only
// agreed contract between the two.
window.vgmdj = {
  decks,
  master,
  SYNTHS,
  OUTPUT_ORDER,
  setMasterBpm,
  toggleOutputMute,
  flipOutputs,
  silenceAll,
  // Push a single CC to whatever output is currently selected. Used by the
  // LCXL3 integration to rebroadcast its controls as mapping-friendly
  // absolute values on the VGM DJ virtual source. Channel is 0-indexed
  // (i.e. MIDI channel 16 is `15`).
  sendCC(channel, cc, value) {
    sendRaw(0xB0 | (channel & 0x0F), cc & 0x7F, value & 0x7F);
  },
};
