// VGM·DJ — Standalone previewer/editor
//
// Loads any MIDI file (from the library or via file picker), surfaces per-
// channel detail, lets the user audition with solo/mute, and persists output
// assignments back to a per-track override file.

// ──────────────────────────────────────────────────────────────
// Channel colour palette — matches main app for visual consistency
// ──────────────────────────────────────────────────────────────
const CHANNEL_COLORS = [
  '#5ce0d0', '#9b8cff', '#ffb86c', '#ff79c6',
  '#7dd87d', '#f1fa8c', '#8be9fd', '#bd93f9',
  '#50fa7b', '#7a8094',
  '#ffb86c', '#ff6e6e', '#9b8cff', '#5ce0d0', '#ff79c6', '#ffb86c',
];

// ──────────────────────────────────────────────────────────────
// Output channel taxonomy — must match SYNTHS in app.js
// ──────────────────────────────────────────────────────────────
const OUTPUTS = [
  { id: -1, name: 'Off' },
  { id: 0,  name: 'Juno 106' },
  { id: 1,  name: 'SH-01A (lead)' },
  { id: 2,  name: 'Bass Stn 2' },
  { id: 3,  name: 'Keytar' },
  { id: 9,  name: 'TR-08 (drums)' },
];

// ──────────────────────────────────────────────────────────────
// General MIDI patch table (same as the scan tool)
// ──────────────────────────────────────────────────────────────
const GM_PATCH_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'SynthStrings 1', 'SynthStrings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'SynthBrass 1', 'SynthBrass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

function patchName(program) {
  if (program == null) return null;
  return GM_PATCH_NAMES[program] ?? `Program ${program}`;
}

function patchCategory(program) {
  if (program == null) return 'unknown';
  if (program <= 7)   return 'piano';
  if (program <= 15)  return 'chrom-perc';
  if (program <= 23)  return 'organ';
  if (program <= 31)  return 'guitar';
  if (program <= 39)  return 'bass';
  if (program <= 47)  return 'strings';
  if (program <= 55)  return 'ensemble';
  if (program <= 63)  return 'brass';
  if (program <= 71)  return 'reed';
  if (program <= 79)  return 'pipe';
  if (program <= 87)  return 'synth-lead';
  if (program <= 95)  return 'synth-pad';
  if (program <= 103) return 'synth-fx';
  return 'other';
}

// ──────────────────────────────────────────────────────────────
// Worker plumbing — reuses docs/midi-worker.js
// ──────────────────────────────────────────────────────────────
let midiWorker = null;
let nextReqId = 0;
const pendingRequests = new Map();

function getWorker() {
  if (midiWorker) return midiWorker;
  midiWorker = new Worker('midi-worker.js');
  midiWorker.onmessage = (e) => {
    const { id, midi, rollData, error } = e.data;
    const req = pendingRequests.get(id);
    if (!req) return;
    pendingRequests.delete(id);
    if (error) req.reject(new Error(error));
    else req.resolve({ midi, rollData });
  };
  return midiWorker;
}

function parseInWorker(buffer, opts = {}) {
  const w = getWorker();
  const id = ++nextReqId;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    w.postMessage({ id, buffer, dropChannels: opts.dropChannels || [] }, [buffer]);
  });
}

// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────
const state = {
  tracksManifest: null,        // contents of tracks.json
  currentTrack: null,          // { path, title, game, file } from manifest, or { path: 'file', title, file } for picker
  midi: null,                  // { events, ticksPerBeat }
  channels: {},                // chId → { stats, programs, assignment, mute, solo }
  playing: false,
  startWallTime: 0,            // performance.now() when playback started
  startEventOffsetMs: 0,       // ms into the track at startWallTime
  durationMs: 0,
  schedulerInterval: null,
  scheduledUntilMs: 0,         // wall-clock ms watermark for what's already been scheduled
  eventIndex: 0,
  activeNotes: new Map(),      // key 'ch:note' → { stop } so we can mute mid-flight
  channelActivity: {},         // chId → last activity timestamp (for UI dot)
  masterVolume: 0.7,
  overrides: {},               // path → { routing: { srcCh: outCh } }
  soloAny: false,              // cached "any channel soloed"
  rollData: null,              // { notes, maxTick, minNote, maxNote }
  rollView: { zoom: 1, offset: 0 }, // visible window of the roll
  startOffsetMs: 0,            // playback offset into the track at startWallTime
};

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = ctx.createGain();
masterGain.gain.value = state.masterVolume;
masterGain.connect(ctx.destination);

const channelGain = {}; // chId → GainNode (per-channel mixer)

function getChannelGain(chId) {
  if (channelGain[chId]) return channelGain[chId];
  const g = ctx.createGain();
  g.gain.value = 0.8;
  g.connect(masterGain);
  channelGain[chId] = g;
  return g;
}

// ──────────────────────────────────────────────────────────────
// Channel stats — same logic as scan-library.js, run client-side
// ──────────────────────────────────────────────────────────────
function summariseChannels(midi) {
  // Walk events, accumulating per-channel notes and programs
  const per = {};
  const get = (c) => {
    if (!per[c]) per[c] = { notes: [], programs: [], openNotes: new Map() };
    return per[c];
  };
  for (const ev of midi.events) {
    if (ev.channel === undefined) continue;
    const ch = get(ev.channel);
    if (ev.type === 'noteOn') {
      ch.openNotes.set(ev.note, { tick: ev.tick, vel: ev.velocity });
    } else if (ev.type === 'noteOff') {
      const open = ch.openNotes.get(ev.note);
      if (open) {
        ch.notes.push({ tick: open.tick, endTick: ev.tick, pitch: ev.note, vel: open.vel });
        ch.openNotes.delete(ev.note);
      }
    }
  }

  // Close hanging notes at max tick
  let maxTick = 0;
  for (const ev of midi.events) if (ev.tick > maxTick) maxTick = ev.tick;
  for (const ch of Object.values(per)) {
    for (const [pitch, open] of ch.openNotes) {
      ch.notes.push({ tick: open.tick, endTick: maxTick, pitch, vel: open.vel });
    }
    delete ch.openNotes;
  }

  // Need duration in seconds, computed from tempo events
  const tempos = midi.events.filter(e => e.type === 'tempo').map(e => ({ tick: e.tick, bpm: e.bpm }));
  if (tempos.length === 0) tempos.push({ tick: 0, bpm: 120 });
  if (tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  let durSec = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : maxTick;
    durSec += ((end - start) / midi.ticksPerBeat) * (60 / tempos[i].bpm);
  }

  const summary = {};
  for (const [id, ch] of Object.entries(per)) {
    const notes = ch.notes;
    if (notes.length === 0) {
      summary[id] = {
        note_count: 0, mono: true,
        first_program: ch.programs[0]?.program ?? null,
        programs: ch.programs,
      };
      continue;
    }

    let sumP = 0, low = 127, high = 0;
    for (const n of notes) {
      sumP += n.pitch;
      if (n.pitch < low) low = n.pitch;
      if (n.pitch > high) high = n.pitch;
    }
    const events = [];
    for (const n of notes) {
      events.push({ tick: n.tick, type: 'on' });
      events.push({ tick: n.endTick, type: 'off' });
    }
    events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));
    let active = 0, maxActive = 0;
    let lastTick = events[0].tick;
    let polyTicks = 0, activeTicks = 0;
    for (const e of events) {
      if (e.tick > lastTick) {
        const span = e.tick - lastTick;
        if (active >= 1) activeTicks += span;
        if (active >= 2) polyTicks += span;
        lastTick = e.tick;
      }
      if (e.type === 'on') { active++; if (active > maxActive) maxActive = active; }
      else active--;
    }
    const pctPoly = activeTicks > 0 ? polyTicks / activeTicks : 0;
    const mono = maxActive <= 1 || pctPoly < 0.02;
    const program = ch.programs[0]?.program ?? null;

    summary[id] = {
      note_count: notes.length,
      pitch_low: low,
      pitch_high: high,
      pitch_avg: Math.round((sumP / notes.length) * 10) / 10,
      max_simultaneous: maxActive,
      pct_polyphonic: Math.round(pctPoly * 1000) / 1000,
      note_density: durSec > 0 ? Math.round((notes.length / durSec) * 10) / 10 : 0,
      mono,
      first_program: program,
      first_program_name: patchName(program),
      first_program_category: patchCategory(program),
      programs: ch.programs,
    };
  }

  return { summary, maxTick, durSec };
}

// Suggested role from the stats — informs the default output assignment
function suggestRole(stats, allStats, chId) {
  if (Number(chId) === 9) return 'drums';
  if (stats.note_count === 0) return 'other';
  const cat = stats.first_program_category;
  if (cat === 'bass') return 'bass';
  if (cat === 'synth-lead') return 'lead';
  if (cat === 'strings' || cat === 'ensemble') return 'strings';
  if (cat === 'synth-pad') return 'pad';
  if (cat === 'piano') return 'piano';

  // Untagged mono with low avg pitch → likely bass
  if (stats.mono && stats.pitch_avg <= 50) return 'bass';
  // Untagged mono with high pitch → likely lead
  if (stats.mono && stats.pitch_avg >= 72) return 'lead';
  return 'other';
}

function suggestOutput(role) {
  switch (role) {
    case 'bass':    return 2;   // Bass Stn 2
    case 'lead':    return 1;   // SH-01A
    case 'drums':   return 9;   // TR-08
    case 'pad':     return 0;   // Juno
    case 'strings': return 3;   // Keytar (placeholder — strings are the tricky case)
    case 'piano':   return 0;   // Juno
    default:        return 0;   // Juno fallback
  }
}

// ──────────────────────────────────────────────────────────────
// Stereo duplicate detection — same algorithm as scan-library.js
// ──────────────────────────────────────────────────────────────
function detectDuplicates(midi) {
  // Rebuild per-channel note tick/pitch lists
  const per = {};
  const open = new Map();
  for (const ev of midi.events) {
    if (ev.channel === undefined) continue;
    if (ev.type === 'noteOn') {
      open.set(`${ev.channel}:${ev.note}`, ev.tick);
    } else if (ev.type === 'noteOff') {
      const k = `${ev.channel}:${ev.note}`;
      const startTick = open.get(k);
      if (startTick != null) {
        if (!per[ev.channel]) per[ev.channel] = [];
        per[ev.channel].push({ tick: startTick, pitch: ev.note });
        open.delete(k);
      }
    }
  }
  const TICK_TOL = 5;
  const pairs = {};
  const channels = Object.keys(per).map(Number).filter(c => c !== 9);
  for (let i = 0; i < channels.length; i++) {
    for (let j = i + 1; j < channels.length; j++) {
      const a = per[channels[i]], b = per[channels[j]];
      if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.85) continue;
      const idx = new Map();
      for (const n of b) {
        const bucket = Math.round(n.tick / TICK_TOL);
        if (!idx.has(bucket)) idx.set(bucket, new Set());
        idx.get(bucket).add(n.pitch);
      }
      let m = 0;
      for (const n of a) {
        const bucket = Math.round(n.tick / TICK_TOL);
        for (let off = -1; off <= 1; off++) {
          const s = idx.get(bucket + off);
          if (s && s.has(n.pitch)) { m++; break; }
        }
      }
      if (m / a.length >= 0.9) {
        pairs[channels[i]] = channels[j];
        pairs[channels[j]] = channels[i];
      }
    }
  }
  return pairs; // chId → its partner chId (if any)
}

// ──────────────────────────────────────────────────────────────
// Inline WebAudio GM-ish synth
// Picks a waveform + envelope per patch category. Drums are short noise
// bursts shaped per GM drum note. Good enough for AB-ing channels, not for
// real performance — that's what the actual hardware rig is for.
// ──────────────────────────────────────────────────────────────
function noteToFreq(n) { return 440 * Math.pow(2, (n - 69) / 12); }

function patchVoiceConfig(category) {
  switch (category) {
    case 'bass':       return { wave: 'sawtooth', attack: 0.005, release: 0.10, gain: 0.45, filterFreq: 1400 };
    case 'synth-lead': return { wave: 'sawtooth', attack: 0.01,  release: 0.15, gain: 0.40, filterFreq: 2800, detune: 8 };
    case 'piano':      return { wave: 'triangle', attack: 0.002, release: 0.30, gain: 0.45 };
    case 'strings':
    case 'ensemble':   return { wave: 'sawtooth', attack: 0.05,  release: 0.30, gain: 0.25, filterFreq: 2000 };
    case 'brass':      return { wave: 'square',   attack: 0.02,  release: 0.18, gain: 0.30, filterFreq: 2400 };
    case 'reed':
    case 'pipe':       return { wave: 'triangle', attack: 0.03,  release: 0.20, gain: 0.35 };
    case 'organ':      return { wave: 'square',   attack: 0.005, release: 0.05, gain: 0.30 };
    case 'guitar':     return { wave: 'sawtooth', attack: 0.005, release: 0.20, gain: 0.30, filterFreq: 2200 };
    case 'synth-pad':  return { wave: 'triangle', attack: 0.20,  release: 0.50, gain: 0.30 };
    case 'chrom-perc': return { wave: 'sine',     attack: 0.002, release: 0.40, gain: 0.45 };
    default:           return { wave: 'triangle', attack: 0.01,  release: 0.20, gain: 0.35 };
  }
}

function playNote(chId, midiNote, velocity, startTime, durationSec) {
  const isDrum = Number(chId) === 9;
  const chGain = getChannelGain(chId);
  const vel = velocity / 127;

  if (isDrum) {
    // Noise burst, frequency-shaped by drum note
    const noise = ctx.createBufferSource();
    const len = 0.18;
    const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    // Kick-ish for low notes, hat-ish for high
    if (midiNote <= 38)      { filter.type = 'lowpass';  filter.frequency.value = 120; }
    else if (midiNote <= 45) { filter.type = 'bandpass'; filter.frequency.value = 200; }
    else if (midiNote <= 50) { filter.type = 'bandpass'; filter.frequency.value = 400; }
    else                     { filter.type = 'highpass'; filter.frequency.value = 4000; }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.6 * vel, startTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.18);
    noise.connect(filter).connect(gain).connect(chGain);
    noise.start(startTime);
    noise.stop(startTime + 0.2);
    return { stop: (t) => { try { noise.stop(t); } catch(e){} } };
  }

  const stats = state.channels[chId]?.stats;
  const cfg = patchVoiceConfig(stats?.first_program_category ?? 'other');
  const osc = ctx.createOscillator();
  osc.type = cfg.wave;
  osc.frequency.value = noteToFreq(midiNote);
  let endNode = osc;
  if (cfg.filterFreq) {
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = cfg.filterFreq;
    osc.connect(filt);
    endNode = filt;
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const peak = cfg.gain * vel;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peak, startTime + cfg.attack);
  // Sustain
  gain.gain.setValueAtTime(peak, startTime + Math.max(cfg.attack, durationSec - 0.005));
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec + cfg.release);
  endNode.connect(gain).connect(chGain);
  osc.start(startTime);
  const stopAt = startTime + durationSec + cfg.release + 0.05;
  osc.stop(stopAt);
  return { stop: (t) => { try { osc.stop(t); } catch(e){} } };
}

// ──────────────────────────────────────────────────────────────
// Playback scheduler — converts MIDI ticks to absolute wall time and
// schedules events 100ms ahead using AudioContext clock. No drift.
// ──────────────────────────────────────────────────────────────
function precomputeEventTimes(midi) {
  // Walk events and assign each its absolute time (ms) from start
  const tempos = []; // {tick, bpm, msAtTick}
  let curBpm = 120;
  let lastTick = 0;
  let elapsedMs = 0;
  const tpb = midi.ticksPerBeat;
  const eventsWithTime = [];
  for (const ev of midi.events) {
    if (ev.tick > lastTick) {
      elapsedMs += (ev.tick - lastTick) * (60000 / (curBpm * tpb));
      lastTick = ev.tick;
    }
    if (ev.type === 'tempo') curBpm = ev.bpm;
    eventsWithTime.push({ ...ev, ms: elapsedMs });
  }
  // Append a final tail marker so the duration is known
  let maxTick = 0;
  for (const ev of midi.events) if (ev.tick > maxTick) maxTick = ev.tick;
  if (maxTick > lastTick) elapsedMs += (maxTick - lastTick) * (60000 / (curBpm * tpb));
  return { eventsWithTime, totalMs: elapsedMs };
}

function pausePlayback() {
  if (!state.playing) return;
  state.startOffsetMs = (performance.now() - state.startWallTime) + state.startOffsetMs;
  stopPlayback(false);
}

function stopPlayback(resetToStart = true) {
  state.playing = false;
  if (state.schedulerInterval) {
    clearInterval(state.schedulerInterval);
    state.schedulerInterval = null;
  }
  for (const [k, h] of state.activeNotes) {
    h.stop(ctx.currentTime);
  }
  state.activeNotes.clear();
  document.getElementById('prev-play').classList.remove('playing');
  document.getElementById('prev-play').textContent = '▶ Play';
  if (resetToStart) {
    state.startOffsetMs = 0;
    paintRoll();
    updateTimeDisplay();
  }
}

function startPlayback() {
  if (!state.midi) return;
  if (ctx.state === 'suspended') ctx.resume();
  state.playing = true;
  state.startWallTime = performance.now();
  // Find the first event at or past startOffsetMs (seek-aware)
  state.eventIndex = 0;
  while (state.eventIndex < state.eventsWithTime.length &&
         state.eventsWithTime[state.eventIndex].ms < state.startOffsetMs) {
    state.eventIndex++;
  }
  state.scheduledUntilMs = state.startOffsetMs;
  document.getElementById('prev-play').classList.add('playing');
  document.getElementById('prev-play').textContent = '❚❚ Pause';
  scheduleAhead();
  state.schedulerInterval = setInterval(() => {
    scheduleAhead();
    updateTimeDisplay();
    decayActivityDots();
    if (state.eventIndex >= state.eventsWithTime.length && state.activeNotes.size === 0) {
      // Reached the end
      stopPlayback();
    }
  }, 25);
}

function scheduleAhead() {
  const LOOKAHEAD_MS = 120;
  const nowMs = (performance.now() - state.startWallTime) + state.startOffsetMs;
  const upTo = nowMs + LOOKAHEAD_MS;

  const evs = state.eventsWithTime;
  const ctxNow = ctx.currentTime;
  while (state.eventIndex < evs.length && evs[state.eventIndex].ms <= upTo) {
    const ev = evs[state.eventIndex++];
    if (ev.type === 'tempo') continue;
    if (ev.channel === undefined) continue;
    if (ev.type !== 'noteOn') continue;
    if (ev.velocity === 0) continue;
    const chId = ev.channel;
    // Apply mute/solo
    const channelState = state.channels[chId];
    if (!channelState) continue;
    if (channelState.mute) continue;
    if (state.soloAny && !channelState.solo) continue;
    // Schedule at audio context time = ctxNow + (ev.ms - nowMs) / 1000
    const startTime = ctxNow + Math.max(0, (ev.ms - nowMs)) / 1000;
    const durMs = (ev.endTick != null)
      ? (state.eventsWithTime[lookupEventByTick(ev.endTick, chId, ev.note)]?.ms ?? ev.ms + 200) - ev.ms
      : 200;
    const handle = playNote(chId, ev.note, ev.velocity, startTime, Math.max(0.04, durMs / 1000));
    const key = `${chId}:${ev.note}:${state.eventIndex}`;
    state.activeNotes.set(key, handle);
    state.channelActivity[chId] = performance.now();
    // Auto-clear when the note's natural end has passed
    const clearAt = startTime + Math.max(0.04, durMs / 1000) + 0.6;
    setTimeout(() => state.activeNotes.delete(key), Math.max(0, (clearAt - ctxNow) * 1000));
  }
}

// Helper: find the noteOff event for a given pending noteOn so we can compute
// the natural duration. Linear scan from current index forward — cheap because
// noteOff usually arrives within a handful of events.
function lookupEventByTick(endTick, channel, note) {
  const evs = state.eventsWithTime;
  for (let i = state.eventIndex; i < evs.length; i++) {
    const e = evs[i];
    if (e.tick > endTick) return null;
    if (e.tick === endTick && e.channel === channel && e.note === note &&
        (e.type === 'noteOff' || (e.type === 'noteOn' && e.velocity === 0))) {
      return i;
    }
  }
  return null;
}

function currentPlayMs() {
  if (state.playing) return (performance.now() - state.startWallTime) + state.startOffsetMs;
  return state.startOffsetMs;
}

function updateTimeDisplay() {
  const elapsed = currentPlayMs() / 1000;
  const total = state.durationMs / 1000;
  document.getElementById('prev-time-cur').textContent = fmtTime(elapsed);
  document.getElementById('prev-time-end').textContent = fmtTime(total);
  const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
  document.getElementById('prev-progress').style.width = pct + '%';
  paintRoll();
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function decayActivityDots() {
  const now = performance.now();
  for (const chId of Object.keys(state.channelActivity)) {
    const dot = document.querySelector(`.activity-dot[data-ch="${chId}"]`);
    if (!dot) continue;
    if (now - state.channelActivity[chId] < 120) dot.classList.add('on');
    else dot.classList.remove('on');
  }
}

// ──────────────────────────────────────────────────────────────
// Piano roll — ported & simplified from app.js renderRollOffscreen/paintRoll.
// Renders all notes from rollData, dims notes for muted/non-soloed channels,
// draws bar+beat grid, draws playhead. Click to seek. Wheel to zoom. Shift+
// drag to pan.
// ──────────────────────────────────────────────────────────────
let rollOffscreen = null;
let rollOffscreenSig = null;

function getRollWindow() {
  const max = state.rollData?.maxTick || 1;
  const z = state.rollView.zoom;
  const visible = max / z;
  const start = state.rollView.offset * max;
  return { startTick: start, endTick: start + visible, max };
}

function renderRoll() {
  if (!state.rollData) return;
  const canvas = document.getElementById('prev-roll');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 260;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;

  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const c = off.getContext('2d');
  c.scale(dpr, dpr);
  const w = cssW, h = cssH;

  c.fillStyle = '#0d0f14';
  c.fillRect(0, 0, w, h);

  const { notes, minNote, maxNote } = state.rollData;
  const { startTick, endTick } = getRollWindow();
  const span = endTick - startTick;
  const tickToX = (t) => ((t - startTick) / span) * w;

  const drumLaneH = 10;
  const pitchedH = h - drumLaneH;
  const noteRange = Math.max(12, maxNote - minNote);
  const noteH = pitchedH / noteRange;

  // Octave grid
  c.strokeStyle = 'rgba(255,255,255,0.05)';
  c.lineWidth = 1;
  for (let n = Math.ceil(minNote / 12) * 12; n <= maxNote; n += 12) {
    const y = pitchedH - (n - minNote) * noteH;
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
  }
  c.strokeStyle = 'rgba(255,255,255,0.10)';
  c.beginPath(); c.moveTo(0, pitchedH); c.lineTo(w, pitchedH); c.stroke();

  // Beat + downbeat grid using ticksPerBeat from the file. Meter assumed 4/4
  // (previewer doesn't currently parse meter changes — easy to add later).
  const tpb = state.midi?.ticksPerBeat || 480;
  const meterNum = 4;
  const ticksPerBar = tpb * meterNum;

  const firstBeat = Math.ceil(startTick / tpb);
  const lastBeat = Math.floor(endTick / tpb);
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let b = firstBeat; b <= lastBeat; b++) {
    const x = tickToX(b * tpb);
    c.beginPath(); c.moveTo(x, pitchedH); c.lineTo(x, h); c.stroke();
  }
  c.strokeStyle = 'rgba(255,255,255,0.16)';
  const firstBar = Math.ceil(startTick / ticksPerBar);
  const lastBar = Math.floor(endTick / ticksPerBar);
  for (let b = firstBar; b <= lastBar; b++) {
    const x = tickToX(b * ticksPerBar);
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
  }

  // Notes — visible window only, dimmed if muted or non-soloed
  for (const n of notes) {
    if (n.endTick < startTick || n.startTick > endTick) continue;
    const chState = state.channels[n.channel];
    let alpha = 1;
    if (chState) {
      if (chState.mute) alpha = 0.10;
      else if (state.soloAny && !chState.solo) alpha = 0.12;
    }
    const x1 = tickToX(n.startTick);
    const x2 = tickToX(n.endTick);
    const width = Math.max(1, x2 - x1);
    c.fillStyle = CHANNEL_COLORS[n.channel] || '#888';
    if (n.channel === 9) {
      c.globalAlpha = alpha * (0.5 + Math.min(0.5, n.velocity / 254));
      c.fillRect(x1, pitchedH + 2, Math.max(1.5, width), drumLaneH - 4);
    } else {
      const y = pitchedH - (n.note - minNote + 1) * noteH;
      c.globalAlpha = alpha * (0.35 + Math.min(0.65, n.velocity / 200));
      c.fillRect(x1, y, width, Math.max(1, noteH - 0.5));
    }
  }
  c.globalAlpha = 1;

  rollOffscreen = off;
  paintRoll();
}

function paintRoll() {
  const canvas = document.getElementById('prev-roll');
  if (!canvas) return;
  const c = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  if (rollOffscreen) c.drawImage(rollOffscreen, 0, 0);
  else { c.fillStyle = '#0d0f14'; c.fillRect(0, 0, w, h); return; }

  if (!state.rollData) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const { startTick, endTick, max } = getRollWindow();
  // Convert current play ms → current tick (linear interpolation through tempo map)
  const playTick = msToTick(currentPlayMs());
  if (playTick != null && playTick >= startTick && playTick <= endTick) {
    const x = ((playTick - startTick) / (endTick - startTick)) * cssW * dpr;
    c.strokeStyle = 'rgba(255,140,140,0.85)';
    c.lineWidth = 2 * dpr;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, canvas.height); c.stroke();
  }
}

// Convert a wall-clock ms (since track start) to MIDI tick.
function msToTick(ms) {
  if (!state.eventsWithTime || state.eventsWithTime.length === 0) return null;
  // Binary search would be faster but the array is small enough for linear
  const arr = state.eventsWithTime;
  if (ms <= 0) return 0;
  if (ms >= state.durationMs) return state.rollData?.maxTick ?? 0;
  // Find the last event with ms <= target
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].ms <= ms) lo = mid; else hi = mid - 1;
  }
  const e = arr[lo];
  // Interpolate from this event to the next using current tempo
  const next = arr[lo + 1];
  if (!next) return e.tick;
  const segMs = next.ms - e.ms;
  if (segMs <= 0) return e.tick;
  const frac = (ms - e.ms) / segMs;
  return e.tick + frac * (next.tick - e.tick);
}

function tickToMs(tick) {
  if (!state.eventsWithTime || state.eventsWithTime.length === 0) return 0;
  const arr = state.eventsWithTime;
  if (tick <= 0) return 0;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].tick <= tick) lo = mid; else hi = mid - 1;
  }
  const e = arr[lo];
  const next = arr[lo + 1];
  if (!next) return e.ms;
  const segTicks = next.tick - e.tick;
  if (segTicks <= 0) return e.ms;
  const frac = (tick - e.tick) / segTicks;
  return e.ms + frac * (next.ms - e.ms);
}

function setRollZoom(newZoom, anchorFrac) {
  const z = Math.max(1, Math.min(50, newZoom));
  if (z === state.rollView.zoom) return;
  const { startTick, max } = getRollWindow();
  const anchorTick = startTick + anchorFrac * (max / state.rollView.zoom);
  state.rollView.zoom = z;
  const newVisible = max / z;
  let newOffsetTick = anchorTick - anchorFrac * newVisible;
  newOffsetTick = Math.max(0, Math.min(max - newVisible, newOffsetTick));
  state.rollView.offset = newOffsetTick / max;
  renderRoll();
}

function setRollOffset(newOffset) {
  const max = 1 - 1 / state.rollView.zoom;
  state.rollView.offset = Math.max(0, Math.min(max, newOffset));
  renderRoll();
}

function bindRoll() {
  const canvas = document.getElementById('prev-roll');
  if (!canvas) return;
  let dragging = false;
  let panStartX = 0;
  let panStartOffset = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.shiftKey) {
      dragging = true;
      panStartX = e.clientX;
      panStartOffset = state.rollView.offset;
    } else {
      // Click to seek
      seekToClientX(e.clientX);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - panStartX) / rect.width;
    setRollOffset(panStartOffset - dx / state.rollView.zoom);
  });
  const endDrag = (e) => { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch(_){} };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.rollData) return;
    const rect = canvas.getBoundingClientRect();
    const anchorFrac = (e.clientX - rect.left) / rect.width;
    const isHorizontalSwipe = !e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (e.shiftKey || isHorizontalSwipe) {
      const primary = e.deltaX || e.deltaY;
      setRollOffset(state.rollView.offset + (primary / 600) / state.rollView.zoom);
    } else {
      const zoomFactor = Math.exp(-e.deltaY * 0.005);
      setRollZoom(state.rollView.zoom * zoomFactor, anchorFrac);
    }
  }, { passive: false });

  // Repaint on resize so the roll fills the container
  const ro = new ResizeObserver(() => { if (state.rollData) renderRoll(); });
  ro.observe(canvas);
}

function seekToClientX(clientX) {
  if (!state.rollData) return;
  const canvas = document.getElementById('prev-roll');
  const rect = canvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const { startTick, endTick } = getRollWindow();
  const targetTick = startTick + frac * (endTick - startTick);
  const targetMs = tickToMs(targetTick);
  if (state.playing) {
    // Hot-seek: stop current, set offset, restart
    stopPlayback(false);
    state.startOffsetMs = targetMs;
    startPlayback();
  } else {
    state.startOffsetMs = targetMs;
    paintRoll();
    updateTimeDisplay();
  }
}

// ──────────────────────────────────────────────────────────────
// Library picker — uses tracks.json
// ──────────────────────────────────────────────────────────────
async function loadManifest() {
  const res = await fetch('tracks.json');
  state.tracksManifest = await res.json();
  populateGames();
}

function populateGames() {
  const games = [...new Set(state.tracksManifest.tracks.map(t => t.game))].sort();
  const sel = document.getElementById('prev-game');
  sel.innerHTML = '';
  for (const g of games) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    sel.appendChild(opt);
  }
  populateTracksForGame(games[0]);
}

function populateTracksForGame(game) {
  const sel = document.getElementById('prev-track');
  sel.innerHTML = '';
  const tracks = state.tracksManifest.tracks.filter(t => t.game === game);
  tracks.sort((a, b) => a.title.localeCompare(b.title));
  for (const t of tracks) {
    const opt = document.createElement('option');
    opt.value = t.path;
    opt.textContent = t.title;
    sel.appendChild(opt);
  }
}

async function loadTrackByPath(path, displayInfo) {
  document.getElementById('prev-load-status').textContent = 'Loading…';
  stopPlayback();
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // Look up the track in the manifest for drop_channels (skip dedup-loaded channels)
    const manifestEntry = state.tracksManifest?.tracks?.find(t => t.path === path);
    const dropChannels = manifestEntry?.drop_channels || [];
    const { midi, rollData } = await parseInWorker(buf, { dropChannels });
    applyLoadedMidi(midi, rollData, { ...displayInfo, drop_channels: dropChannels });
    document.getElementById('prev-load-status').textContent = `loaded (${displayInfo.title})`;
  } catch (err) {
    document.getElementById('prev-load-status').textContent = `error: ${err.message}`;
    console.error(err);
  }
}

async function loadTrackFromFile(file) {
  document.getElementById('prev-load-status').textContent = 'Loading…';
  stopPlayback();
  try {
    const buf = await file.arrayBuffer();
    const { midi, rollData } = await parseInWorker(buf);
    applyLoadedMidi(midi, rollData, { path: 'file:' + file.name, title: file.name, game: 'file' });
    document.getElementById('prev-load-status').textContent = `loaded (${file.name})`;
  } catch (err) {
    document.getElementById('prev-load-status').textContent = `error: ${err.message}`;
    console.error(err);
  }
}

function applyLoadedMidi(midi, rollData, displayInfo) {
  state.midi = midi;
  state.rollData = rollData;
  state.currentTrack = displayInfo;
  state.rollView = { zoom: 1, offset: 0 };
  state.startOffsetMs = 0;
  const { summary, maxTick, durSec } = summariseChannels(midi);
  const dupes = detectDuplicates(midi);
  const { eventsWithTime, totalMs } = precomputeEventTimes(midi);
  state.eventsWithTime = eventsWithTime;
  state.durationMs = totalMs;

  // Build per-channel state
  state.channels = {};
  for (const [id, stats] of Object.entries(summary)) {
    const role = suggestRole(stats, summary, id);
    const autoOutput = suggestOutput(role);
    // If there's a saved override for this track, use it
    const overrideOut = state.overrides[displayInfo.path]?.routing?.[id];
    const finalOutput = overrideOut != null ? overrideOut : autoOutput;
    state.channels[id] = {
      id,
      stats,
      role,
      output: finalOutput,
      autoOutput,
      mute: false,
      solo: false,
      dupeOf: dupes[id] ?? null,
    };
    // Reset channel gain to 1.0
    getChannelGain(id).gain.value = 1.0;
  }

  // Update info panel
  document.getElementById('info-title').textContent = displayInfo.title;
  document.getElementById('info-game').textContent = displayInfo.game ?? '—';
  const avgBpm = computeAvgBpm(midi, maxTick);
  document.getElementById('info-bpm').textContent = avgBpm;
  document.getElementById('info-duration').textContent = fmtTime(durSec);
  document.getElementById('info-channels').textContent = Object.keys(summary).filter(k => summary[k].note_count > 0).length;
  document.getElementById('info-tempos').textContent = midi.events.filter(e => e.type === 'tempo').length;

  renderChannelRows();
  document.getElementById('prev-time-cur').textContent = '0:00';
  document.getElementById('prev-time-end').textContent = fmtTime(durSec);
  document.getElementById('prev-progress').style.width = '0%';
  renderRoll();
}

function computeAvgBpm(midi, maxTick) {
  const tempos = midi.events.filter(e => e.type === 'tempo').map(e => ({ tick: e.tick, bpm: e.bpm }));
  if (tempos.length === 0) return 120;
  if (tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  let w = 0, t = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : maxTick;
    const ticks = Math.max(1, end - start);
    w += tempos[i].bpm * ticks;
    t += ticks;
  }
  return Math.round(t > 0 ? w / t : tempos[0].bpm);
}

// ──────────────────────────────────────────────────────────────
// Channel rows UI
// ──────────────────────────────────────────────────────────────
function renderChannelRows() {
  const body = document.getElementById('prev-channel-body');
  body.innerHTML = '';
  const chIds = Object.keys(state.channels).map(Number).sort((a, b) => a - b);
  for (const chId of chIds) {
    const c = state.channels[chId];
    const tr = document.createElement('tr');
    if (c.stats.note_count === 0) tr.classList.add('dim');
    tr.innerHTML = `
      <td><strong>${chId}</strong></td>
      <td>${c.stats.first_program_name ?? '—'}${c.dupeOf != null ? `<span class="dupe-badge">≈ ch ${c.dupeOf}</span>` : ''}</td>
      <td>${c.stats.note_count}</td>
      <td>${c.stats.note_count > 0 ? `${c.stats.pitch_low}–${c.stats.pitch_high}` : '—'}</td>
      <td>${c.stats.note_count > 0 ? c.stats.pitch_avg : '—'}</td>
      <td>${c.stats.note_count > 0 ? Math.round(c.stats.pct_polyphonic * 100) + '%' : '—'}</td>
      <td>${c.stats.note_count > 0 ? c.stats.max_simultaneous : '—'}</td>
      <td>${c.stats.note_count > 0 ? `<span class="ch-tag ch-tag-${c.stats.mono ? 'mono' : 'poly'}">${c.stats.mono ? 'mono' : 'poly'}</span>` : '—'}</td>
      <td>${c.stats.note_count > 0 ? `<span class="role-tag role-${c.role}">${c.role}</span>` : '—'}</td>
      <td>
        <select class="chan-output-select" data-ch="${chId}">
          ${OUTPUTS.map(o => `<option value="${o.id}" ${o.id === c.output ? 'selected' : ''}>${o.name}</option>`).join('')}
        </select>
      </td>
      <td><button class="chan-toggle solo${c.solo ? ' on' : ''}" data-ch="${chId}" data-action="solo">solo</button></td>
      <td><button class="chan-toggle${c.mute ? ' on' : ''}" data-ch="${chId}" data-action="mute">mute</button></td>
      <td><span class="activity-dot" data-ch="${chId}"></span></td>
    `;
    body.appendChild(tr);
  }
  bindChannelControls();
}

function bindChannelControls() {
  document.querySelectorAll('.chan-output-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const chId = e.target.dataset.ch;
      const outId = Number(e.target.value);
      state.channels[chId].output = outId;
    });
  });
  document.querySelectorAll('.chan-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const chId = e.target.dataset.ch;
      const action = e.target.dataset.action;
      const c = state.channels[chId];
      if (action === 'mute') {
        c.mute = !c.mute;
        e.target.classList.toggle('on', c.mute);
      } else {
        c.solo = !c.solo;
        e.target.classList.toggle('on', c.solo);
      }
      state.soloAny = Object.values(state.channels).some(c => c.solo);
      renderRoll();
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Overrides — persistence
// ──────────────────────────────────────────────────────────────
const OVERRIDES_KEY = 'previewer-overrides-v1';

function loadOverrides() {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    state.overrides = raw ? JSON.parse(raw) : {};
  } catch (e) {
    state.overrides = {};
  }
}

function saveCurrentOverride() {
  if (!state.currentTrack) return;
  const routing = {};
  for (const [id, c] of Object.entries(state.channels)) {
    routing[id] = c.output;
  }
  state.overrides[state.currentTrack.path] = { routing };
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(state.overrides));
  const status = document.getElementById('prev-save-status');
  status.textContent = `saved ${state.currentTrack.title}`;
  setTimeout(() => status.textContent = '', 2500);
}

function downloadOverrides() {
  const blob = new Blob([JSON.stringify(state.overrides, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'overrides.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function clearOverrides() {
  if (!confirm('Clear all saved per-track overrides? This cannot be undone.')) return;
  state.overrides = {};
  localStorage.removeItem(OVERRIDES_KEY);
  const status = document.getElementById('prev-save-status');
  status.textContent = 'overrides cleared';
  setTimeout(() => status.textContent = '', 2500);
}

// ──────────────────────────────────────────────────────────────
// Wiring
// ──────────────────────────────────────────────────────────────
function init() {
  loadOverrides();
  loadManifest();

  const loadFromSelection = () => {
    const game = document.getElementById('prev-game').value;
    const sel = document.getElementById('prev-track');
    const path = sel.value;
    if (!path) return;
    const title = sel.selectedOptions[0]?.textContent ?? path;
    loadTrackByPath(path, { path, title, game });
  };
  document.getElementById('prev-game').addEventListener('change', (e) => {
    populateTracksForGame(e.target.value);
    loadFromSelection(); // load first track of new game automatically
  });
  document.getElementById('prev-track').addEventListener('change', loadFromSelection);
  document.getElementById('prev-load').addEventListener('click', loadFromSelection);
  document.getElementById('prev-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadTrackFromFile(f);
  });
  document.getElementById('prev-play').addEventListener('click', () => {
    if (state.playing) pausePlayback();
    else startPlayback();
  });
  document.getElementById('prev-stop').addEventListener('click', () => stopPlayback(true));
  bindRoll();
  document.getElementById('prev-volume').addEventListener('input', (e) => {
    state.masterVolume = e.target.value / 100;
    masterGain.gain.value = state.masterVolume;
  });
  document.getElementById('prev-save').addEventListener('click', saveCurrentOverride);
  document.getElementById('prev-download').addEventListener('click', downloadOverrides);
  document.getElementById('prev-clear-overrides').addEventListener('click', clearOverrides);
}

init();
