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
    pos += 4; // 'MTrk'
    const trackLen = view.getUint32(pos); pos += 4;
    const trackEnd = pos + trackLen;
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
          events.push({ tick, type: 'tempo', bpm: Math.round(60000000 / tempo) });
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

  // Pair noteOns with noteOffs so each noteOn carries its natural endTick.
  // Used to let notes ring out across loop wraps.
  const open = new Map();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'noteOn') {
      open.set(`${ev.channel}:${ev.note}`, i);
    } else if (ev.type === 'noteOff') {
      const onIdx = open.get(`${ev.channel}:${ev.note}`);
      if (onIdx != null) {
        events[onIdx].endTick = ev.tick;
        open.delete(`${ev.channel}:${ev.note}`);
      }
    }
  }

  return { events, ticksPerBeat, format };
}

function compileNotes(midi) {
  const notes = [];
  const open = new Map();
  let maxTick = 0;
  for (const ev of midi.events) {
    if (ev.tick > maxTick) maxTick = ev.tick;
    if (ev.type === 'noteOn') {
      open.set(`${ev.channel}:${ev.note}`, { tick: ev.tick, vel: ev.velocity });
    } else if (ev.type === 'noteOff') {
      const key = `${ev.channel}:${ev.note}`;
      const start = open.get(key);
      if (start) {
        notes.push({ channel: ev.channel, note: ev.note, startTick: start.tick, endTick: ev.tick, velocity: start.vel });
        open.delete(key);
      }
    }
  }
  for (const [key, start] of open) {
    const [ch, note] = key.split(':').map(Number);
    notes.push({ channel: ch, note, startTick: start.tick, endTick: maxTick, velocity: start.vel });
  }
  const pitched = notes.filter(n => n.channel !== 9);
  const minNote = pitched.length ? Math.min(...pitched.map(n => n.note)) - 2 : 48;
  const maxNote = pitched.length ? Math.max(...pitched.map(n => n.note)) + 2 : 84;
  return { notes, maxTick: Math.max(1, maxTick), minNote, maxNote };
}
