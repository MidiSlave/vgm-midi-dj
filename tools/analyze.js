import { readFileSync } from 'fs';
import { resolve } from 'path';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(n) {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

function parseMidi(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 0;

  function readStr(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(buffer[pos++]);
    return s;
  }

  function readU32() { const v = view.getUint32(pos); pos += 4; return v; }
  function readU16() { const v = view.getUint16(pos); pos += 2; return v; }

  function readVarLen() {
    let val = 0;
    let byte;
    do {
      byte = buffer[pos++];
      val = (val << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return val;
  }

  const header = readStr(4);
  if (header !== 'MThd') throw new Error('Not a MIDI file');

  readU32(); // header length
  const format = readU16();
  const numTracks = readU16();
  const ticksPerBeat = readU16();

  const tracks = [];

  for (let t = 0; t < numTracks; t++) {
    const trackHeader = readStr(4);
    if (trackHeader !== 'MTrk') throw new Error(`Expected MTrk, got ${trackHeader}`);
    const trackLen = readU32();
    const trackEnd = pos + trackLen;

    const events = [];
    let runningStatus = 0;
    let tick = 0;

    while (pos < trackEnd) {
      const delta = readVarLen();
      tick += delta;

      let status = buffer[pos];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        pos++;
        if (status < 0xf0) runningStatus = status;
      }

      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        const metaType = buffer[pos++];
        const len = readVarLen();
        const data = buffer.slice(pos, pos + len);
        pos += len;

        if (metaType === 0x51) {
          const tempo = (data[0] << 16) | (data[1] << 8) | data[2];
          events.push({ tick, type: 'tempo', bpm: Math.round(60000000 / tempo) });
        } else if (metaType === 0x03) {
          events.push({ tick, type: 'trackName', name: String.fromCharCode(...data) });
        }
      } else if (status === 0xf0 || status === 0xf7) {
        const len = readVarLen();
        pos += len;
      } else if (type === 0x90) {
        const note = buffer[pos++];
        const vel = buffer[pos++];
        if (vel > 0) {
          events.push({ tick, type: 'noteOn', channel, note, velocity: vel });
        }
      } else if (type === 0x80) {
        pos += 2;
      } else if (type === 0xc0) {
        const program = buffer[pos++];
        events.push({ tick, type: 'programChange', channel, program });
      } else if (type === 0xb0) {
        const cc = buffer[pos++];
        const val = buffer[pos++];
        events.push({ tick, type: 'cc', channel, cc, value: val });
      } else if (type === 0xe0) {
        pos += 2;
      } else if (type === 0xd0) {
        pos += 1;
      } else if (type === 0xa0) {
        pos += 2;
      } else {
        break;
      }
    }

    pos = trackEnd;
    tracks.push(events);
  }

  return { format, numTracks, ticksPerBeat, tracks };
}

function analyze(filePath) {
  const buffer = readFileSync(resolve(filePath));
  const midi = parseMidi(buffer);

  console.log(`\nFile: ${filePath}`);
  console.log(`Format: ${midi.format} | Tracks: ${midi.numTracks} | Ticks/Beat: ${midi.ticksPerBeat}`);
  console.log('─'.repeat(60));

  const channels = {};

  for (let t = 0; t < midi.tracks.length; t++) {
    const track = midi.tracks[t];
    const trackName = track.find(e => e.type === 'trackName');
    const tempo = track.find(e => e.type === 'tempo');

    if (tempo) console.log(`Tempo: ${tempo.bpm} BPM`);

    for (const ev of track) {
      if (ev.channel === undefined) continue;
      if (!channels[ev.channel]) {
        channels[ev.channel] = { notes: [], programs: new Set(), noteCount: 0, trackName: trackName?.name };
      }
      if (ev.type === 'noteOn') {
        channels[ev.channel].notes.push(ev.note);
        channels[ev.channel].noteCount++;
      }
      if (ev.type === 'programChange') {
        channels[ev.channel].programs.add(ev.program);
      }
    }
  }

  console.log('\nChannel Summary:');
  console.log('─'.repeat(60));

  for (const [ch, data] of Object.entries(channels).sort((a, b) => a[0] - b[0])) {
    if (data.noteCount === 0) continue;

    const min = Math.min(...data.notes);
    const max = Math.max(...data.notes);
    const isDrum = parseInt(ch) === 9;
    const progs = data.programs.size > 0 ? ` | Programs: ${[...data.programs].join(', ')}` : '';
    const name = data.trackName ? ` (${data.trackName})` : '';

    console.log(
      `  Ch ${String(parseInt(ch) + 1).padStart(2)}${name}: ` +
      `${data.noteCount} notes | ` +
      `Range: ${noteName(min)}-${noteName(max)}` +
      `${isDrum ? ' [DRUMS]' : ''}` +
      progs
    );

    if (isDrum) {
      const drumHits = {};
      for (const n of data.notes) {
        drumHits[n] = (drumHits[n] || 0) + 1;
      }
      const sorted = Object.entries(drumHits).sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.log(`         Drums: ${sorted.map(([n, c]) => `${noteName(parseInt(n))}(${c})`).join(', ')}`);
    }
  }

  console.log('\n─'.repeat(60));
  console.log('Suggested routing:');

  for (const [ch, data] of Object.entries(channels).sort((a, b) => a[0] - b[0])) {
    if (data.noteCount === 0) continue;
    const chNum = parseInt(ch);

    if (chNum === 9) {
      console.log(`  Ch ${chNum + 1} → TR-08 (Ch 10)`);
    } else {
      const avg = data.notes.reduce((a, b) => a + b, 0) / data.notes.length;
      const range = Math.max(...data.notes) - Math.min(...data.notes);

      let suggestion;
      if (avg < 48 && range < 24) suggestion = 'Bass Station 2 (Ch 3)';
      else if (range > 30) suggestion = 'Juno 106 (Ch 1)';
      else if (avg > 65) suggestion = 'SH-01A (Ch 2)';
      else suggestion = 'Roland Keytar (Ch 4)';

      console.log(`  Ch ${chNum + 1} → ${suggestion}`);
    }
  }
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/analyze.js <midi-file>');
  process.exit(1);
}

analyze(file);
