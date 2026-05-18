// Library scan — walks every MIDI file under docs/midi-files/ and produces
// per-channel statistics, per-game aggregates, and stereo-duplicate detection.
// Writes docs/library-report.json (full machine-readable) and
// docs/library-report.md (skimmable summary).
//
// Goal: see what's actually in the library so we can design a deterministic
// routing policy from data instead of guesses.

import { readFileSync, writeFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIDI_DIR = join(ROOT, 'docs', 'midi-files');
const OUT_JSON = join(ROOT, 'docs', 'library-report.json');
const OUT_MD = join(ROOT, 'docs', 'library-report.md');

// General MIDI patch names. Index = program number (0-127).
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

const PATCH_CATEGORIES = [
  { name: 'Piano',         range: [0, 7] },
  { name: 'Chrom. Perc.',  range: [8, 15] },
  { name: 'Organ',         range: [16, 23] },
  { name: 'Guitar',        range: [24, 31] },
  { name: 'Bass',          range: [32, 39] },
  { name: 'Strings',       range: [40, 47] },
  { name: 'Ensemble',      range: [48, 55] },
  { name: 'Brass',         range: [56, 63] },
  { name: 'Reed',          range: [64, 71] },
  { name: 'Pipe',          range: [72, 79] },
  { name: 'Synth Lead',    range: [80, 87] },
  { name: 'Synth Pad',     range: [88, 95] },
  { name: 'Synth FX',      range: [96, 103] },
  { name: 'Ethnic',        range: [104, 111] },
  { name: 'Percussive',    range: [112, 119] },
  { name: 'SFX',           range: [120, 127] },
];

function patchCategory(program) {
  if (program == null) return 'Unknown';
  for (const cat of PATCH_CATEGORIES) {
    if (program >= cat.range[0] && program <= cat.range[1]) return cat.name;
  }
  return 'Unknown';
}

function patchName(program) {
  if (program == null) return null;
  return GM_PATCH_NAMES[program] ?? `Program ${program}`;
}

// ──────────────────────────────────────────────────────────────
// MIDI parser — produces a per-channel detailed view of the file.
// Returns: { ticksPerBeat, avgBpm, duration_sec, channels: { N: {...} } }
// where each channel entry has note list, pitch range, polyphony stats,
// programChange history, etc.
// ──────────────────────────────────────────────────────────────
function parseDetail(buffer) {
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
  readU16(); // format
  const numTracks = readU16();
  const ticksPerBeat = readU16();

  // Per-channel state being assembled
  const channels = {}; // ch → {notes:[{tick,endTick,pitch,vel}], programs:[{tick,program}], lowestVel, ...}
  const getCh = (n) => {
    if (!channels[n]) channels[n] = { notes: [], programs: [], openNotes: new Map() };
    return channels[n];
  };

  const tempos = []; // {tick, bpm}
  let maxTick = 0;

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
        }
        pos += len;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readVarLen();
      } else if (type === 0x90) {
        const note = buffer[pos++];
        const vel = buffer[pos++];
        const ch = getCh(channel);
        if (vel > 0) {
          // New noteOn — open
          ch.openNotes.set(note, { tick, vel });
        } else {
          // noteOn vel 0 = noteOff
          const open = ch.openNotes.get(note);
          if (open) {
            ch.notes.push({ tick: open.tick, endTick: tick, pitch: note, vel: open.vel });
            ch.openNotes.delete(note);
          }
        }
      } else if (type === 0x80) {
        const note = buffer[pos++]; pos++; // skip vel
        const ch = getCh(channel);
        const open = ch.openNotes.get(note);
        if (open) {
          ch.notes.push({ tick: open.tick, endTick: tick, pitch: note, vel: open.vel });
          ch.openNotes.delete(note);
        }
      } else if (type === 0xc0) {
        const program = buffer[pos++];
        getCh(channel).programs.push({ tick, program });
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

  // Close any open notes at maxTick
  for (const ch of Object.values(channels)) {
    for (const [pitch, open] of ch.openNotes) {
      ch.notes.push({ tick: open.tick, endTick: maxTick, pitch, vel: open.vel });
    }
    delete ch.openNotes;
  }

  // Compute duration_sec via tempo map
  if (tempos.length === 0) tempos.push({ tick: 0, bpm: 120 });
  if (tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  let duration_sec = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : maxTick;
    duration_sec += ((end - start) / ticksPerBeat) * (60 / tempos[i].bpm);
  }
  let weighted = 0, total = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : maxTick;
    const ticks = Math.max(1, end - start);
    weighted += tempos[i].bpm * ticks;
    total += ticks;
  }
  const avgBpm = total > 0 ? weighted / total : 120;

  return { ticksPerBeat, avgBpm, duration_sec, maxTick, channels };
}

// ──────────────────────────────────────────────────────────────
// Per-channel summary — derives the stats we actually care about.
// ──────────────────────────────────────────────────────────────
function summariseChannel(ch, ticksPerBeat, duration_sec) {
  const notes = ch.notes;
  if (notes.length === 0) {
    return { note_count: 0, programs: ch.programs };
  }

  let sumPitch = 0, lowPitch = 127, highPitch = 0;
  for (const n of notes) {
    sumPitch += n.pitch;
    if (n.pitch < lowPitch) lowPitch = n.pitch;
    if (n.pitch > highPitch) highPitch = n.pitch;
  }
  const avgPitch = sumPitch / notes.length;

  // Polyphony tracking — sweep on/off events in tick order
  const events = [];
  for (const n of notes) {
    events.push({ tick: n.tick, type: 'on' });
    events.push({ tick: n.endTick, type: 'off' });
  }
  events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  let active = 0, maxActive = 0;
  let lastTick = events[0].tick;
  let polyTicks = 0;       // tick-time during which active >= 2
  let activeTicks = 0;     // tick-time during which active >= 1
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
  const noteDensity = duration_sec > 0 ? notes.length / duration_sec : 0;

  // First (and any subsequent) programChange
  const firstProgram = ch.programs[0]?.program ?? null;
  const programChanges = ch.programs.length;

  // Mono/poly tag: count it mono if max simultaneous is 1, OR if polyphony is
  // extremely rare (< 2% of active time) — some files have brief overlaps from
  // sloppy quantisation but are musically monophonic.
  const mono = maxActive <= 1 || pctPolyphonic < 0.02;

  return {
    note_count: notes.length,
    pitch_low: lowPitch,
    pitch_high: highPitch,
    pitch_avg: Math.round(avgPitch * 10) / 10,
    range: highPitch - lowPitch,
    max_simultaneous: maxActive,
    pct_polyphonic: Math.round(pctPolyphonic * 1000) / 1000,
    note_density: Math.round(noteDensity * 10) / 10,
    mono,
    first_program: firstProgram,
    first_program_name: patchName(firstProgram),
    first_program_category: patchCategory(firstProgram),
    program_changes: programChanges,
  };
}

// ──────────────────────────────────────────────────────────────
// Stereo-duplicate detection — two channels are L/R duplicates if a large
// majority of their (pitch, ontick) tuples coincide within a small tolerance.
// ──────────────────────────────────────────────────────────────
function detectStereoDuplicates(parsed) {
  const TICK_TOLERANCE = 5;
  const channels = Object.entries(parsed.channels)
    .filter(([_, ch]) => ch.notes.length > 0)
    .map(([id, ch]) => ({ id: Number(id), notes: ch.notes }));

  const dupes = [];
  for (let i = 0; i < channels.length; i++) {
    for (let j = i + 1; j < channels.length; j++) {
      const a = channels[i], b = channels[j];
      if (a.id === 9 || b.id === 9) continue; // drums never count as dupes
      // Coarse filter — note count must be similar
      const ratio = Math.min(a.notes.length, b.notes.length) / Math.max(a.notes.length, b.notes.length);
      if (ratio < 0.85) continue;
      // Detailed match
      const bIndex = new Map(); // tick-bucket → pitches
      for (const n of b.notes) {
        const bucket = Math.round(n.tick / TICK_TOLERANCE);
        if (!bIndex.has(bucket)) bIndex.set(bucket, new Set());
        bIndex.get(bucket).add(n.pitch);
      }
      let matched = 0;
      for (const n of a.notes) {
        const bucket = Math.round(n.tick / TICK_TOLERANCE);
        for (let off = -1; off <= 1; off++) {
          const set = bIndex.get(bucket + off);
          if (set && set.has(n.pitch)) { matched++; break; }
        }
      }
      const overlap = matched / a.notes.length;
      if (overlap >= 0.9) {
        dupes.push({ a: a.id, b: b.id, overlap: Math.round(overlap * 100) / 100 });
      }
    }
  }
  return dupes;
}

// ──────────────────────────────────────────────────────────────
// Walk the library and assemble the full report
// ──────────────────────────────────────────────────────────────
async function walk(dir, results = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, results);
    else if (/\.(mid|midi)$/i.test(e.name)) results.push(full);
  }
  return results;
}

async function main() {
  console.log(`Scanning ${MIDI_DIR}…`);
  const files = await walk(MIDI_DIR);
  console.log(`Found ${files.length} MIDI files`);

  const tracks = [];
  let failed = 0;
  let scanned = 0;
  for (const file of files) {
    const fromMidiDir = relative(MIDI_DIR, file).split('/').join('/');
    const gameDir = fromMidiDir.split('/')[0];
    const filename = file.split('/').pop();
    try {
      const buffer = readFileSync(file);
      const parsed = parseDetail(buffer);
      const channels = {};
      for (const [id, ch] of Object.entries(parsed.channels)) {
        channels[id] = summariseChannel(ch, parsed.ticksPerBeat, parsed.duration_sec);
      }
      const stereoDupes = detectStereoDuplicates(parsed);

      tracks.push({
        path: `midi-files/${fromMidiDir}`,
        file: filename,
        game: gameDir,
        duration_sec: Math.round(parsed.duration_sec * 10) / 10,
        avg_bpm: Math.round(parsed.avgBpm),
        ticks_per_beat: parsed.ticksPerBeat,
        max_tick: parsed.maxTick,
        channels,
        stereo_duplicates: stereoDupes,
      });
    } catch (err) {
      failed++;
      console.warn(`  skip ${fromMidiDir}: ${err.message}`);
    }
    scanned++;
    if (scanned % 100 === 0) console.log(`  …${scanned}/${files.length}`);
  }

  console.log(`Parsed ${tracks.length} tracks (${failed} failed)`);

  // ── Aggregates ──
  const games = {};
  let totalChannels = 0, totalMono = 0, totalPoly = 0;
  let tracksWithDupes = 0, totalDupes = 0;
  const patchCategoryCounts = {};

  for (const t of tracks) {
    const ch = Object.values(t.channels);
    totalChannels += ch.length;
    for (const c of ch) {
      if (c.note_count === 0) continue;
      if (c.mono) totalMono++; else totalPoly++;
      const cat = c.first_program_category;
      patchCategoryCounts[cat] = (patchCategoryCounts[cat] || 0) + 1;
    }
    if (t.stereo_duplicates.length > 0) {
      tracksWithDupes++;
      totalDupes += t.stereo_duplicates.length;
    }
    if (!games[t.game]) games[t.game] = { tracks: 0, channel_position: {} };
    games[t.game].tracks++;
    for (const [chId, c] of Object.entries(t.channels)) {
      if (c.note_count === 0) continue;
      const slot = games[t.game].channel_position[chId] ||= {
        present_count: 0, mono_count: 0, poly_count: 0,
        program_categories: {}, programs: {}, pitch_avg_sum: 0, pitch_avg_n: 0,
      };
      slot.present_count++;
      if (c.mono) slot.mono_count++; else slot.poly_count++;
      slot.program_categories[c.first_program_category] = (slot.program_categories[c.first_program_category] || 0) + 1;
      const key = c.first_program == null ? 'none' : String(c.first_program);
      slot.programs[key] = (slot.programs[key] || 0) + 1;
      slot.pitch_avg_sum += c.pitch_avg;
      slot.pitch_avg_n++;
    }
  }

  // Reduce per-game slot data to a compact summary
  for (const g of Object.values(games)) {
    for (const chId of Object.keys(g.channel_position)) {
      const slot = g.channel_position[chId];
      slot.dominant_category = Object.entries(slot.program_categories).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const topProgKey = Object.entries(slot.programs).sort((a, b) => b[1] - a[1])[0]?.[0];
      slot.dominant_program = topProgKey === 'none' ? null : Number(topProgKey);
      slot.dominant_program_name = slot.dominant_program == null ? null : patchName(slot.dominant_program);
      slot.avg_pitch = slot.pitch_avg_n > 0 ? Math.round((slot.pitch_avg_sum / slot.pitch_avg_n) * 10) / 10 : null;
      delete slot.pitch_avg_sum; delete slot.pitch_avg_n;
    }
  }

  const summary = {
    track_count: tracks.length,
    game_count: Object.keys(games).length,
    failed,
    avg_channels_per_track: Math.round((totalChannels / tracks.length) * 10) / 10,
    total_mono_channels: totalMono,
    total_poly_channels: totalPoly,
    tracks_with_stereo_duplicates: tracksWithDupes,
    total_stereo_duplicate_pairs: totalDupes,
    patch_category_counts: patchCategoryCounts,
  };

  writeFileSync(OUT_JSON, JSON.stringify({
    generated: new Date().toISOString(),
    summary,
    games,
    tracks,
  }, null, 2));
  console.log(`Wrote ${OUT_JSON}`);

  // ── Markdown report ──
  const md = renderMarkdown(summary, games, tracks);
  writeFileSync(OUT_MD, md);
  console.log(`Wrote ${OUT_MD}`);
}

function renderMarkdown(summary, games, tracks) {
  const out = [];
  out.push('# Library scan report');
  out.push('');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push('## Library summary');
  out.push('');
  out.push(`- **Total tracks**: ${summary.track_count}`);
  out.push(`- **Total games**: ${summary.game_count}`);
  out.push(`- **Failed to parse**: ${summary.failed}`);
  out.push(`- **Average channels per track**: ${summary.avg_channels_per_track}`);
  out.push(`- **Total monophonic channels**: ${summary.total_mono_channels}`);
  out.push(`- **Total polyphonic channels**: ${summary.total_poly_channels}`);
  out.push(`- **Tracks with stereo duplicates detected**: ${summary.tracks_with_stereo_duplicates}`);
  out.push(`- **Total stereo-duplicate pairs**: ${summary.total_stereo_duplicate_pairs}`);
  out.push('');

  out.push('## Patch category usage (library-wide)');
  out.push('');
  out.push('| Category | Channel count |');
  out.push('|---|---:|');
  const cats = Object.entries(summary.patch_category_counts).sort((a, b) => b[1] - a[1]);
  for (const [cat, n] of cats) out.push(`| ${cat} | ${n} |`);
  out.push('');

  out.push('## Per-game patterns');
  out.push('');
  out.push('For each game, the dominant channel-position layout (which source channels appear and what role they tend to play).');
  out.push('');
  const gameNames = Object.keys(games).sort();
  for (const gameName of gameNames) {
    const g = games[gameName];
    out.push(`### ${gameName} — ${g.tracks} track${g.tracks === 1 ? '' : 's'}`);
    out.push('');
    out.push('| Source ch | Present in | Mono / Poly | Dominant patch | Avg pitch |');
    out.push('|---|---|---|---|---|');
    const chIds = Object.keys(g.channel_position).map(Number).sort((a, b) => a - b);
    for (const chId of chIds) {
      const slot = g.channel_position[chId];
      const presence = `${slot.present_count}/${g.tracks}`;
      const monoPoly = `${slot.mono_count} mono / ${slot.poly_count} poly`;
      const patch = slot.dominant_program_name
        ? `${slot.dominant_program_name} (${slot.dominant_category})`
        : `— (${slot.dominant_category ?? 'unknown'})`;
      const pitch = slot.avg_pitch == null ? '—' : slot.avg_pitch;
      out.push(`| ${chId} | ${presence} | ${monoPoly} | ${patch} | ${pitch} |`);
    }
    out.push('');
  }

  out.push('## Sample tracks with stereo duplicates');
  out.push('');
  const dupeSamples = tracks.filter(t => t.stereo_duplicates.length > 0).slice(0, 25);
  if (dupeSamples.length === 0) {
    out.push('_None detected._');
  } else {
    out.push('| Game | Track | Duplicate pairs |');
    out.push('|---|---|---|');
    for (const t of dupeSamples) {
      const pairs = t.stereo_duplicates.map(d => `${d.a}↔${d.b} (${Math.round(d.overlap * 100)}%)`).join(', ');
      out.push(`| ${t.game} | ${t.file} | ${pairs} |`);
    }
  }
  out.push('');

  return out.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
