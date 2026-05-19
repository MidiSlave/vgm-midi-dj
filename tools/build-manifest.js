import { readFileSync, writeFileSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIDI_DIR = join(ROOT, 'docs', 'midi-files');
const OUT = join(ROOT, 'docs', 'tracks.json');
const TEMPO_OVERRIDES = join(__dirname, 'tempo-overrides.json');

// Per-track corrections that override the auto-detected fields. Used for
// tracks the user has verified by ear (typically after beat-mapping in Logic).
// Path keys are relative to docs/midi-files/.
function loadTempoOverrides() {
  try {
    const raw = readFileSync(TEMPO_OVERRIDES, 'utf8');
    return JSON.parse(raw).tracks || {};
  } catch {
    return {};
  }
}

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl-Kessler key profiles
const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

function detectKey(pitchClasses) {
  let best = { score: -Infinity, key: 'C', mode: 'major' };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = pitchClasses.slice(tonic).concat(pitchClasses.slice(0, tonic));
    const maj = pearson(rotated, PROFILE_MAJOR);
    const min = pearson(rotated, PROFILE_MINOR);
    if (maj > best.score) best = { score: maj, key: KEY_NAMES[tonic], mode: 'major' };
    if (min > best.score) best = { score: min, key: KEY_NAMES[tonic], mode: 'minor' };
  }
  return `${best.key} ${best.mode}`;
}

// Detect perceived tempo from note onsets using an inter-onset-interval (IOI) histogram.
// Finds the dominant note duration, then octave-shifts into a typical musical range (80–160 BPM).
function detectPerceivedBpm(onsetTimes) {
  if (onsetTimes.length < 8) return null;

  const iois = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    const dt = onsetTimes[i] - onsetTimes[i - 1];
    if (dt > 0.04 && dt < 1.5) iois.push(dt);
  }
  if (iois.length < 5) return null;

  // 5ms-wide bins; smooth with 3-tap window so near-misses cluster
  const binWidth = 0.005;
  const counts = new Map();
  for (const ioi of iois) {
    const bin = Math.round(ioi / binWidth);
    counts.set(bin, (counts.get(bin) || 0) + 1);
  }
  let bestBin = 0, bestScore = 0;
  for (const [bin] of counts) {
    const score = (counts.get(bin - 1) || 0) + counts.get(bin) + (counts.get(bin + 1) || 0);
    if (score > bestScore) { bestScore = score; bestBin = bin; }
  }
  const peakIoi = bestBin * binWidth;
  if (peakIoi <= 0) return null;

  let bpm = 60 / peakIoi;
  while (bpm > 160) bpm /= 2;
  while (bpm < 80) bpm *= 2;
  return Math.round(bpm);
}

// Detect L/R duplicate channel pairs by comparing each channel's (tick, pitch)
// note set against every other channel's. When two channels have ≥90% overlap
// within a small tick tolerance, the higher-numbered one is marked as a drop
// candidate (the lower-numbered channel is kept as the "primary"). Returns a
// sorted array of channel IDs to drop on parse.
// Determine where the music actually ends in tick space. Some files have
// trailing meta events or "straggler" notes far past the bulk of the music
// (Yamaha XG "Xg" rips put 1-2% of notes 10×+ past the music's end). Trim
// trailing clusters that sit beyond a long silence and are a tiny fraction
// of the total — those reliably indicate junk, not legitimate outros.
function computeMusicalEnd(allNoteTicks, fallbackTick, ticksPerBeat, fileMaxTick) {
  if (!allNoteTicks || allNoteTicks.length === 0) {
    return fallbackTick > 0 ? fallbackTick : fileMaxTick;
  }
  const sorted = [...allNoteTicks].sort((a, b) => a - b);
  const GAP_BEATS = 32;       // silence longer than 32 beats marks a cluster boundary
  const MAX_TAIL_FRAC = 0.05; // ignore <5% trailing cluster past a long gap
  const gapTicks = GAP_BEATS * ticksPerBeat;
  let endIdx = sorted.length - 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > gapTicks) {
      const tailCount = sorted.length - i; // notes at or past the boundary
      if (tailCount < sorted.length * MAX_TAIL_FRAC) {
        endIdx = i - 1; // chop this trailing cluster; keep scanning
      } else {
        break; // the trailing region is too big to be junk
      }
    }
  }
  // Add a one-bar tail so a final ringing note doesn't get clipped visually.
  return sorted[endIdx] + ticksPerBeat * 4;
}

// Classify a non-drum channel into a role tag based on pitch range and
// polyphony. Returns one of: 'bass', 'lead', 'chords', or null when the
// channel is too sparse to commit to. Polyphony is measured by sweeping
// on/off events and counting tick-time spent at ≥2 simultaneous notes.
function classifyChannel(notes, ticksPerBeat) {
  if (!notes || notes.length < 4) return null;
  const events = [];
  for (const n of notes) {
    events.push({ tick: n.tick, type: 'on' });
    if (n.endTick != null) events.push({ tick: n.endTick, type: 'off' });
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
  const pctPolyphonic = activeTicks > 0 ? polyTicks / activeTicks : 0;
  const mono = maxActive <= 1 || pctPolyphonic < 0.02;
  const avgPitch = notes.reduce((s, n) => s + n.pitch, 0) / notes.length;
  // Bass: monophonic AND mostly below C4 (MIDI 60).
  if (mono && avgPitch < 56) return 'bass';
  // Chord-bearing: anything substantially polyphonic.
  if (pctPolyphonic >= 0.15) return 'chords';
  // Lead: mono pitched line above bass register.
  if (mono) return 'lead';
  // Light polyphony (e.g. occasional dyads) — treat as lead for tagging.
  return 'lead';
}

function detectTrackTags(channelNotes, hasDrums, ticksPerBeat) {
  const tags = new Set();
  if (hasDrums) tags.add('drums');
  for (const [ch, notes] of Object.entries(channelNotes)) {
    if (Number(ch) === 9) continue;
    const role = classifyChannel(notes, ticksPerBeat);
    if (role) tags.add(role);
  }
  // Stable, predictable order
  const order = ['drums', 'bass', 'chords', 'lead'];
  return order.filter(t => tags.has(t));
}

function detectDropChannels(channelNotes) {
  const TICK_TOL = 5;
  const channelIds = Object.keys(channelNotes)
    .map(Number)
    .filter(c => c !== 9 && channelNotes[c].length > 0)
    .sort((a, b) => a - b);

  const drop = new Set();
  for (let i = 0; i < channelIds.length; i++) {
    if (drop.has(channelIds[i])) continue;
    for (let j = i + 1; j < channelIds.length; j++) {
      if (drop.has(channelIds[j])) continue;
      const a = channelNotes[channelIds[i]];
      const b = channelNotes[channelIds[j]];
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
      if (m / a.length >= 0.9) drop.add(channelIds[j]);
    }
  }

  // Second pass: catch L/R copies that the tick-bucket scan misses (different
  // velocities, slightly offset ticks). If two channels have identical note
  // count, pitch range, and average pitch they're almost certainly duplicates.
  const stats = {};
  for (const id of channelIds) {
    const notes = channelNotes[id];
    let low = 127, high = 0, sum = 0;
    for (const n of notes) {
      if (n.pitch < low) low = n.pitch;
      if (n.pitch > high) high = n.pitch;
      sum += n.pitch;
    }
    stats[id] = { count: notes.length, low, high, avg: sum / notes.length };
  }
  for (let i = 0; i < channelIds.length; i++) {
    if (drop.has(channelIds[i])) continue;
    for (let j = i + 1; j < channelIds.length; j++) {
      if (drop.has(channelIds[j])) continue;
      const a = stats[channelIds[i]], b = stats[channelIds[j]];
      if (a.count === b.count && a.low === b.low && a.high === b.high
          && Math.abs(a.avg - b.avg) < 0.05) {
        drop.add(channelIds[j]);
      }
    }
  }
  return [...drop].sort((a, b) => a - b);
}

function parseMidi(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 0;

  const readStr = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(buffer[pos++]); return s; };
  const readU32 = () => { const v = view.getUint32(pos); pos += 4; return v; };
  const readU16 = () => { const v = view.getUint16(pos); pos += 2; return v; };
  const readVarLen = () => {
    let val = 0, byte;
    do { byte = buffer[pos++]; val = (val << 7) | (byte & 0x7f); } while (byte & 0x80);
    return val;
  };

  if (readStr(4) !== 'MThd') throw new Error('Not a MIDI file');
  readU32();
  const format = readU16();
  const numTracks = readU16();
  const ticksPerBeat = readU16();

  const tempos = []; // {tick, bpm}
  const meters = []; // {tick, numerator, denominator}
  const channels = new Set();
  const pitchClasses = new Array(12).fill(0);
  const onsets = []; // {tick, channel}
  const channelNotes = {}; // ch → [{tick, pitch, endTick}]  — for dupe detect + tag classification
  const pendingNotes = {}; // `${ch}:${pitch}` → index into channelNotes[ch] of the open note
  let totalNotes = 0;
  let maxTick = 0;
  // End-of-music tick. Some files have stray events (tempo, EOT, sysex, CC)
  // long after the last note; using maxTick for duration inflates it. We
  // bound duration_sec by the last note-on / note-off instead, AND trim
  // straggler notes that sit past a long silence (FF "Xg" rips put 1-2% of
  // notes 10×+ past the bulk — Jenova Absolute had 21 notes after the music's
  // real end, blowing duration up from 2:01 to 26:07).
  let lastNoteEventTick = 0;
  const allNoteTicks = []; // for straggler trim
  let trackName = null;
  let copyrightOrText = null;
  const programs = {};

  for (let t = 0; t < numTracks; t++) {
    if (readStr(4) !== 'MTrk') break;
    const trackLen = readU32();
    const trackEnd = pos + trackLen;
    let tick = 0;
    let runningStatus = 0;

    while (pos < trackEnd) {
      const delta = readVarLen();
      tick += delta;
      if (tick > maxTick) maxTick = tick;

      let status = buffer[pos];
      if (status < 0x80) status = runningStatus;
      else { pos++; if (status < 0xf0) runningStatus = status; }

      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        const metaType = buffer[pos++];
        const len = readVarLen();
        if (metaType === 0x51) {
          const tempo = (buffer[pos] << 16) | (buffer[pos + 1] << 8) | buffer[pos + 2];
          tempos.push({ tick, bpm: 60000000 / tempo });
        } else if (metaType === 0x58 && len >= 2) {
          // Time signature: numerator, denominator (as power of 2), clocks/click, 32nds/quarter
          meters.push({ tick, numerator: buffer[pos], denominator: 1 << buffer[pos + 1] });
        } else if (metaType === 0x03 && !trackName) {
          trackName = String.fromCharCode(...buffer.slice(pos, pos + len)).trim();
        } else if ((metaType === 0x01 || metaType === 0x02) && !copyrightOrText) {
          copyrightOrText = String.fromCharCode(...buffer.slice(pos, pos + len)).trim();
        }
        pos += len;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readVarLen();
      } else if (type === 0x90) {
        const note = buffer[pos++];
        const vel = buffer[pos++];
        if (vel > 0) {
          channels.add(channel);
          totalNotes++;
          if (tick > lastNoteEventTick) lastNoteEventTick = tick;
          allNoteTicks.push(tick);
          if (channel !== 9) {
            pitchClasses[note % 12] += vel;
            onsets.push({ tick, channel });
            const arr = (channelNotes[channel] ||= []);
            arr.push({ tick, pitch: note, endTick: null });
            pendingNotes[`${channel}:${note}`] = arr.length - 1;
          }
        } else {
          if (tick > lastNoteEventTick) lastNoteEventTick = tick; // velocity-0 noteOn = noteOff
          if (channel !== 9) {
            const key = `${channel}:${note}`;
            const idx = pendingNotes[key];
            if (idx != null && channelNotes[channel]?.[idx]?.endTick == null) {
              channelNotes[channel][idx].endTick = tick;
            }
            delete pendingNotes[key];
          }
        }
      } else if (type === 0x80) {
        if (tick > lastNoteEventTick) lastNoteEventTick = tick;
        const note = buffer[pos++];
        pos++; // skip velocity
        if (channel !== 9) {
          const key = `${channel}:${note}`;
          const idx = pendingNotes[key];
          if (idx != null && channelNotes[channel]?.[idx]?.endTick == null) {
            channelNotes[channel][idx].endTick = tick;
          }
          delete pendingNotes[key];
        }
      } else if (type === 0xc0) {
        const program = buffer[pos++];
        if (!(channel in programs)) programs[channel] = program;
      } else if (type === 0xb0 || type === 0xe0 || type === 0xa0) {
        pos += 2;
      } else if (type === 0xd0) {
        pos += 1;
      } else {
        break;
      }
    }
    pos = trackEnd;
  }

  // Duration & BPM-weighting use the musical end-tick. Two passes:
  //   1) bound by last note-on/off (not last event of any kind)
  //   2) trim straggler note clusters separated by a long silence
  const musicalEndTick = computeMusicalEnd(allNoteTicks, lastNoteEventTick, ticksPerBeat, maxTick);
  let duration_sec = 0;
  if (tempos.length === 0) tempos.push({ tick: 0, bpm: 120 });
  if (tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    if (start >= musicalEndTick) break;
    const nextTick = i + 1 < tempos.length ? tempos[i + 1].tick : musicalEndTick;
    const end = Math.min(nextTick, musicalEndTick);
    const beats = (end - start) / ticksPerBeat;
    duration_sec += (beats / tempos[i].bpm) * 60;
  }

  // Average BPM weighted by tick duration (over musical span only)
  let weightedBpm = 0, totalTicks = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    if (start >= musicalEndTick) break;
    const nextTick = i + 1 < tempos.length ? tempos[i + 1].tick : musicalEndTick;
    const end = Math.min(nextTick, musicalEndTick);
    const ticks = Math.max(1, end - start);
    weightedBpm += tempos[i].bpm * ticks;
    totalTicks += ticks;
  }
  const avgBpm = totalTicks > 0 ? weightedBpm / totalTicks : tempos[0].bpm;

  const key = totalNotes > 0 && pitchClasses.some(v => v > 0) ? detectKey(pitchClasses) : null;

  // Convert onset ticks to seconds, respecting tempo events
  const onsetTimes = [];
  if (onsets.length) {
    let segIdx = 0;
    let segStartSec = 0;
    for (const o of onsets) {
      while (segIdx + 1 < tempos.length && tempos[segIdx + 1].tick <= o.tick) {
        const dt = tempos[segIdx + 1].tick - tempos[segIdx].tick;
        segStartSec += (dt / ticksPerBeat) * (60 / tempos[segIdx].bpm);
        segIdx++;
      }
      const dt = o.tick - tempos[segIdx].tick;
      onsetTimes.push(segStartSec + (dt / ticksPerBeat) * (60 / tempos[segIdx].bpm));
    }
  }
  const heuristicBpm = detectPerceivedBpm(onsetTimes);
  // Prefer the file's own tempo when it's in a plausible listening range
  // (50–220 BPM). The IOI heuristic is a rescue only for files at extreme
  // tempos that almost certainly lie (e.g. 25 BPM "long-note" rips, 240+
  // "double-time" rips). Files authored at 60 BPM are common and honest; the
  // narrower 70–200 window was treating them as suspect and replacing with
  // IOI-guessed values that were often wrong (Doom level3-8 came out at
  // 125/91/120/81/150/91 when Logic confirms they're all 60).
  let perceivedBpm;
  if (avgBpm >= 50 && avgBpm <= 220) {
    perceivedBpm = Math.round(avgBpm * 100) / 100;
  } else {
    perceivedBpm = heuristicBpm;
  }
  // Ratio of perceived-to-metadata BPM informs ticks-per-perceived-beat used by loops
  const metaBpm = avgBpm;
  const perceivedTicksPerBeat = perceivedBpm
    ? Math.round((metaBpm / perceivedBpm) * ticksPerBeat)
    : ticksPerBeat;

  const drop_channels = detectDropChannels(channelNotes);
  const tags = detectTrackTags(channelNotes, channels.has(9), ticksPerBeat);

  return {
    format, numTracks, ticksPerBeat,
    drop_channels,
    tags,
    bpm: Math.round(avgBpm * 100) / 100,
    bpm_initial: Math.round(tempos[0].bpm * 100) / 100,
    perceived_bpm: perceivedBpm,
    perceived_ticks_per_beat: perceivedTicksPerBeat,
    meter: meters.length ? `${meters[0].numerator}/${meters[0].denominator}` : '4/4',
    meter_changes: meters.length > 1 ? meters.map(m => ({
      tick: m.tick,
      sig: `${m.numerator}/${m.denominator}`,
    })) : null,
    meters_unique: meters.length
      ? [...new Set(meters.map(m => `${m.numerator}/${m.denominator}`))]
      : ['4/4'],
    tempo_changes: tempos.length,
    duration_sec: Math.round(duration_sec * 10) / 10,
    channels: [...channels].sort((a, b) => a - b),
    note_count: totalNotes,
    key,
    track_name: trackName,
    text: copyrightOrText,
    programs,
    has_drums: channels.has(9),
  };
}

async function walk(dir, results = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, results);
    else if (/\.(mid|midi)$/i.test(e.name)) results.push(full);
  }
  return results;
}

function prettyTitle(filename) {
  return filename
    .replace(/\.(mid|midi)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Per-game release classifiers — applied when a file sits at the top of its
// game directory (no subdirectory). When a file IS in a subdirectory, the
// subdirectory name is used as the release directly (preferred convention).
// Each classifier takes the bare filename and returns a release label
// (e.g. "A Link to the Past") or null when uncertain.
const RELEASE_CLASSIFIERS = {
  zelda(filename) {
    const f = filename;
    if (/^\d{1,2}[a-z]? - /.test(f)) return 'A Link to the Past';
    if (/windfish/i.test(f)) return "Link's Awakening";
    if (/outset|forest_haven|great_sea|king_of_hyrule|makar|earth_gods/i.test(f)) return 'Wind Waker';
    if (/termina|clock_town|clock_tower|bremen|snowhead|stone_tower|deku_palace|great_bay|awakening_of_zelda/i.test(f)) return "Majora's Mask";
    return 'Legend of Zelda (NES)';
  },
};

function classifyRelease(gameDir, subPath, filename) {
  // subPath is the path between gameDir and filename (empty if file is at top)
  if (subPath) return subPath.split('/')[0];
  const fn = RELEASE_CLASSIFIERS[gameDir];
  return fn ? fn(filename) : '';
}

async function main() {
  const files = await walk(MIDI_DIR);
  console.log(`Found ${files.length} MIDI files`);

  const overrides = loadTempoOverrides();
  const overrideKeys = new Set(Object.keys(overrides));
  let overridesApplied = 0;

  const tracks = [];
  let failed = 0;
  for (const file of files) {
    const fromMidiDir = relative(MIDI_DIR, file).split('/').join('/');
    const rel = `midi-files/${fromMidiDir}`; // served via symlink in public/
    const segments = relative(MIDI_DIR, file).split('/');
    const gameDir = segments[0];
    // Release = subdirectory under the game dir, OR a per-game classifier
    // applied to the bare filename when the file sits at the top.
    const subPath = segments.slice(1, -1).join('/');
    const release = classifyRelease(gameDir, subPath, segments[segments.length - 1]);
    try {
      const buffer = readFileSync(file);
      const info = parseMidi(buffer);
      const size = statSync(file).size;
      const filename = file.split('/').pop();
      const cleanName = info.track_name && /^[\x20-\x7e]+$/.test(info.track_name) ? info.track_name.trim() : null;
      // Apply per-track overrides. Recompute perceived_ticks_per_beat so the
      // loop math stays consistent with the corrected perceived_bpm.
      const overrideKey = relative(MIDI_DIR, file);
      const ov = overrides[overrideKey];
      let perceivedBpm = info.perceived_bpm;
      let perceivedTpb = info.perceived_ticks_per_beat;
      let meter = info.meter;
      let beatOneTick = 0;
      let overrideHit = false;
      if (ov && ov.perceived_bpm) {
        perceivedBpm = ov.perceived_bpm;
        perceivedTpb = Math.round((info.bpm / perceivedBpm) * info.ticksPerBeat);
        overrideHit = true;
      }
      if (ov && ov.meter) {
        meter = ov.meter;
        overrideHit = true;
      }
      if (ov && Number.isFinite(ov.beat_one_tick)) {
        beatOneTick = Math.max(0, Math.round(ov.beat_one_tick));
        overrideHit = true;
      }
      if (overrideHit) overridesApplied++;
      tracks.push({
        path: rel, // relative to public/ for fetch
        file: filename,
        title: prettyTitle(filename),
        embedded_name: cleanName,
        game: gameDir,
        release,
        bpm: info.bpm,
        bpm_initial: info.bpm_initial,
        perceived_bpm: perceivedBpm,
        perceived_bpm_auto: info.perceived_bpm,
        perceived_ticks_per_beat: perceivedTpb,
        beat_one_tick: beatOneTick,
        meter,
        meter_auto: info.meter,
        meter_changes: info.meter_changes,
        meters_unique: info.meters_unique,
        key: info.key,
        duration_sec: info.duration_sec,
        channels: info.channels,
        note_count: info.note_count,
        has_drums: info.has_drums,
        tempo_changes: info.tempo_changes,
        drop_channels: info.drop_channels,
        tags: info.tags,
        size,
      });
    } catch (err) {
      failed++;
      console.warn(`  skip ${rel}: ${err.message}`);
    }
  }

  tracks.sort((a, b) => a.game.localeCompare(b.game) || a.title.localeCompare(b.title));

  writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    count: tracks.length,
    tracks,
  }, null, 2));

  const unmatched = [...overrideKeys].filter(k => !tracks.some(t => relative(MIDI_DIR, join(MIDI_DIR, k)) === k && t.path.endsWith(k)));
  console.log(`Wrote ${tracks.length} tracks → ${OUT} (${failed} failed, ${overridesApplied} overrides applied)`);
  if (unmatched.length) console.log(`  override keys with no matching track: ${unmatched.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
