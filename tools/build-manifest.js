import { readFileSync, writeFileSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIDI_DIR = join(ROOT, 'midi-files');
const OUT = join(ROOT, 'public', 'tracks.json');

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
  let totalNotes = 0;
  let maxTick = 0;
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
          if (channel !== 9) {
            pitchClasses[note % 12] += vel;
            onsets.push({ tick, channel });
          }
        }
      } else if (type === 0x80) {
        pos += 2;
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

  // Duration calculation across tempo changes
  let duration_sec = 0;
  if (tempos.length === 0) tempos.push({ tick: 0, bpm: 120 });
  if (tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : maxTick;
    const beats = (end - start) / ticksPerBeat;
    duration_sec += (beats / tempos[i].bpm) * 60;
  }

  // Average BPM weighted by tick duration
  let weightedBpm = 0, totalTicks = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : maxTick;
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
  const perceivedBpm = detectPerceivedBpm(onsetTimes);
  // Ratio of perceived-to-metadata BPM informs ticks-per-perceived-beat used by loops
  const metaBpm = avgBpm;
  const perceivedTicksPerBeat = perceivedBpm
    ? Math.round((metaBpm / perceivedBpm) * ticksPerBeat)
    : ticksPerBeat;

  return {
    format, numTracks, ticksPerBeat,
    bpm: Math.round(avgBpm),
    bpm_initial: Math.round(tempos[0].bpm),
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

async function main() {
  const files = await walk(MIDI_DIR);
  console.log(`Found ${files.length} MIDI files`);

  const tracks = [];
  let failed = 0;
  for (const file of files) {
    const fromMidiDir = relative(MIDI_DIR, file).split('/').join('/');
    const rel = `midi-files/${fromMidiDir}`; // served via symlink in public/
    const gameDir = relative(MIDI_DIR, file).split('/')[0];
    try {
      const buffer = readFileSync(file);
      const info = parseMidi(buffer);
      const size = statSync(file).size;
      const filename = file.split('/').pop();
      const cleanName = info.track_name && /^[\x20-\x7e]+$/.test(info.track_name) ? info.track_name.trim() : null;
      tracks.push({
        path: rel, // relative to public/ for fetch
        file: filename,
        title: prettyTitle(filename),
        embedded_name: cleanName,
        game: gameDir,
        bpm: info.bpm,
        bpm_initial: info.bpm_initial,
        perceived_bpm: info.perceived_bpm,
        perceived_ticks_per_beat: info.perceived_ticks_per_beat,
        meter: info.meter,
        meter_changes: info.meter_changes,
        meters_unique: info.meters_unique,
        key: info.key,
        duration_sec: info.duration_sec,
        channels: info.channels,
        note_count: info.note_count,
        has_drums: info.has_drums,
        tempo_changes: info.tempo_changes,
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

  console.log(`Wrote ${tracks.length} tracks → ${OUT} (${failed} failed)`);
}

main().catch(e => { console.error(e); process.exit(1); });
