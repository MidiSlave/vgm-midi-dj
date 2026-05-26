// MIDI parsing worker — keeps the main thread free during track loads so
// the playing deck's setTimeout-driven playback doesn't stall.

self.onmessage = (e) => {
  const { id, buffer, dropChannels } = e.data;
  try {
    const dropSet = new Set(dropChannels || []);
    const midi = parseMidiFile(buffer, dropSet);
    const rollData = compileNotes(midi);
    // Transfer noting back — events/notes are plain arrays; structured clone is fine
    self.postMessage({ id, midi, rollData });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};

function parseMidiFile(arrayBuffer, dropSet = new Set()) {
  const data = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let pos = 0;

  function readVarLen() {
    let val = 0, byte;
    do { byte = data[pos++]; val = (val << 7) | (byte & 0x7f); } while (byte & 0x80);
    return val;
  }

  const header = String.fromCharCode(...data.slice(0, 4));
  if (header !== 'MThd') throw new Error('Not a MIDI file');
  pos = 4;
  view.getUint32(pos); pos += 4;
  const format = view.getUint16(pos); pos += 2;
  const numTracks = view.getUint16(pos); pos += 2;
  const ticksPerBeat = view.getUint16(pos); pos += 2;

  const events = [];

  for (let t = 0; t < numTracks; t++) {
    // Tolerate truncated files: stop walking if the next MTrk header or its
    // declared length runs past EOF (FF6_60_Ending_Theme.mid claims 21 tracks
    // but the data runs out after track 7).
    if (pos + 8 > data.length) break;
    const trackMagic = String.fromCharCode(data[pos], data[pos+1], data[pos+2], data[pos+3]);
    if (trackMagic !== 'MTrk') break;
    pos += 4;
    const trackLen = view.getUint32(pos); pos += 4;
    const trackEnd = Math.min(pos + trackLen, data.length);
    let tick = 0;
    let runningStatus = 0;

    while (pos < trackEnd) {
      const delta = readVarLen();
      tick += delta;
      let status = data[pos];
      if (status < 0x80) status = runningStatus;
      else { pos++; if (status < 0xf0) runningStatus = status; }

      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        const metaType = data[pos++];
        const len = readVarLen();
        if (metaType === 0x51) {
          const tempo = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
          // Keep fractional BPM so ms-per-tick stays accurate. Logic exports
          // tempos like 146.0003 which round to 146; over a long track the
          // 0.0003 rounding accumulates into audible drift.
          events.push({ tick, type: 'tempo', bpm: 60000000 / tempo });
        }
        pos += len;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readVarLen();
      } else if (type === 0x90) {
        const note = data[pos++], vel = data[pos++];
        if (!dropSet.has(channel)) {
          events.push({ tick, type: vel > 0 ? 'noteOn' : 'noteOff', channel, note, velocity: vel });
        }
      } else if (type === 0x80) {
        const note = data[pos++]; pos++;
        if (!dropSet.has(channel)) {
          events.push({ tick, type: 'noteOff', channel, note, velocity: 0 });
        }
      } else if (type === 0xc0) { pos++; }
      else if (type === 0xb0 || type === 0xe0 || type === 0xa0) { pos += 2; }
      else if (type === 0xd0) { pos++; }
      else { pos = trackEnd; }
    }
    pos = trackEnd;
  }

  events.sort((a, b) => a.tick - b.tick);

  // Dedup identical events at the same (tick, channel, note, type). VGM-style
  // MIDI Type 1 files often layer multiple *tracks* onto the *same channel*
  // (one track per game voice, all writing to ch 0 or ch 1 — common for NES
  // rips). Without dedup these emit duplicate noteOn/noteOff bytes per tick
  // and the receiving synth retriggers each one, producing an audible
  // "flam" / stutter even though the piano roll overlays the duplicates as
  // a single note. Keep the loudest velocity when noteOn dupes collide;
  // noteOff dupes just collapse.
  const seenKey = new Map(); // key → event we kept
  const deduped = [];
  for (const ev of events) {
    if (ev.channel === undefined || ev.note === undefined) {
      deduped.push(ev);
      continue;
    }
    const key = `${ev.tick}:${ev.channel}:${ev.note}:${ev.type}`;
    const prior = seenKey.get(key);
    if (!prior) {
      seenKey.set(key, ev);
      deduped.push(ev);
    } else if (ev.type === 'noteOn' && (ev.velocity ?? 0) > (prior.velocity ?? 0)) {
      prior.velocity = ev.velocity;
    }
  }
  const cleaned = deduped;

  // Pair noteOns with noteOffs so each noteOn carries its natural endTick.
  // Used to let notes ring out across loop wraps.
  const open = new Map();
  for (let i = 0; i < cleaned.length; i++) {
    const ev = cleaned[i];
    if (ev.type === 'noteOn') {
      open.set(`${ev.channel}:${ev.note}`, i);
    } else if (ev.type === 'noteOff') {
      const onIdx = open.get(`${ev.channel}:${ev.note}`);
      if (onIdx != null) {
        cleaned[onIdx].endTick = ev.tick;
        open.delete(`${ev.channel}:${ev.note}`);
      }
    }
  }

  return { events: cleaned, ticksPerBeat, format };
}

function compileNotes(midi) {
  const notes = [];
  const open = new Map();
  // End-of-music = last note-off, not last event. Trailing tempo / EOT /
  // sysex / controller events have been observed in the wild past the last
  // note (Terra Funk has a stray tempo at bar 190 past bar-83 music) and
  // would otherwise inflate maxTick and render acres of empty piano roll.
  let lastEventTick = 0;
  const noteOnTicks = [];
  for (const ev of midi.events) {
    if (ev.tick > lastEventTick) lastEventTick = ev.tick;
    if (ev.type === 'noteOn') {
      open.set(`${ev.channel}:${ev.note}`, { tick: ev.tick, vel: ev.velocity });
      noteOnTicks.push(ev.tick);
    } else if (ev.type === 'noteOff') {
      const key = `${ev.channel}:${ev.note}`;
      const start = open.get(key);
      if (start) {
        notes.push({ channel: ev.channel, note: ev.note, startTick: start.tick, endTick: ev.tick, velocity: start.vel });
        open.delete(key);
      }
    }
  }
  // Hanging notes (unmatched noteOn at file end) ring out to the last event.
  for (const [key, start] of open) {
    const [ch, note] = key.split(':').map(Number);
    notes.push({ channel: ch, note, startTick: start.tick, endTick: lastEventTick, velocity: start.vel });
  }
  // Trim trailing straggler-clusters past a long silence (Jenova Absolute
  // had 21 notes 10× past the music's actual end).
  const musicalEnd = computeMusicalEnd(noteOnTicks, midi.ticksPerBeat);
  const pitched = notes.filter(n => n.channel !== 9);
  const minNote = pitched.length ? Math.min(...pitched.map(n => n.note)) - 2 : 48;
  const maxNote = pitched.length ? Math.max(...pitched.map(n => n.note)) + 2 : 84;
  return { notes, maxTick: Math.max(1, musicalEnd), minNote, maxNote };
}

function computeMusicalEnd(noteTicks, ticksPerBeat) {
  if (!noteTicks || noteTicks.length === 0) return 0;
  const sorted = [...noteTicks].sort((a, b) => a - b);
  const GAP_BEATS = 32;
  const MAX_TAIL_FRAC = 0.05;
  const gapTicks = GAP_BEATS * ticksPerBeat;
  let endIdx = sorted.length - 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > gapTicks) {
      const tail = sorted.length - i;
      if (tail < sorted.length * MAX_TAIL_FRAC) endIdx = i - 1;
      else break;
    }
  }
  return sorted[endIdx] + ticksPerBeat * 4;
}
