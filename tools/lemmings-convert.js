import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Lemmings ADLIB.DAT → MIDI converter
 * Based on the SoundImage format as implemented in Lemmings.ts by tomsoftware
 * Includes decompression of the Lemmings DAT container format
 */

const CONFIGS = {
  lemmings: {
    version: 1,
    adlibChannelConfigPosition: 1452,
    dataOffset: 2215,
    frequenciesOffset: 2343,
    octavesOffset: 2727,
    frequenciesCountOffset: 2823,
    instructionsOffset: 2926,
    soundIndexTablePosition: 21989,
    soundDataOffset: 21731,
    numberOfTracks: 20,
  },
  ohno: {
    version: 2,
    adlibChannelConfigPosition: 1334,
    dataOffset: 1973,
    frequenciesOffset: 2101,
    octavesOffset: 2485,
    frequenciesCountOffset: 2581,
    instructionsOffset: 2684,
    soundIndexTablePosition: 10918,
    soundDataOffset: 10660,
    numberOfTracks: 6,
  },
};

const TRACK_NAMES = {
  lemmings: [
    'Lemmings Main Theme',
    'Keep Your Hair On',
    'Menacing',
    'Awesome',
    'Beast',
    'Beast II',
    'Doggie',
    'Lemming1',
    'Lemming2',
    'Lemming3',
    'Can Can',
    'London Bridge',
    'In the Hall of the Mountain King',
    'Forest Green',
    'Shadow Your Own',
    'How Much Is That Doggie',
    'Pachelbel Canon',
    'Dance of the Little Swans',
    'She Will Be Coming Round the Mountain',
    'Ten Green Bottles',
  ],
  ohno: [
    'Oh No Theme 1',
    'Oh No Theme 2',
    'Oh No Theme 3',
    'Oh No Theme 4',
    'Oh No Theme 5',
    'Oh No Theme 6',
  ],
};

// ─── Decompression (Lemmings DAT container format) ───

class BitReader {
  constructor(data, offset, length, initBufferLength) {
    this.data = data;
    this.startOffset = offset;
    this.pos = length; // read from end
    this.pos--;
    this.buffer = data[offset + this.pos];
    this.bufferLen = initBufferLength;
    this.checksum = this.buffer;
  }

  read(bitCount) {
    let result = 0;
    for (let i = bitCount; i > 0; i--) {
      if (this.bufferLen <= 0) {
        this.pos--;
        const b = this.data[this.startOffset + this.pos] || 0;
        this.buffer = b;
        this.checksum ^= b;
        this.bufferLen = 8;
      }
      this.bufferLen--;
      result = (result << 1) | (this.buffer & 1);
      this.buffer >>= 1;
    }
    return result;
  }

  eof() {
    return this.bufferLen <= 0 && this.pos < 0;
  }

  getCurrentChecksum() { return this.checksum; }
}

function decompress(fileData) {
  const parts = [];
  let pos = 0;
  const HEADER_SIZE = 10;

  while (pos + HEADER_SIZE < fileData.length) {
    const initialBufferLen = fileData[pos];
    const checksum = fileData[pos + 1];
    // readWord = big-endian in Lemmings.ts
    const unknown1 = (fileData[pos + 2] << 8) | fileData[pos + 3];
    const decompressedSize = (fileData[pos + 4] << 8) | fileData[pos + 5];
    const unknown0 = (fileData[pos + 6] << 8) | fileData[pos + 7];
    const size = (fileData[pos + 8] << 8) | fileData[pos + 9];

    const compressedSize = size - HEADER_SIZE;
    const dataOffset = pos + HEADER_SIZE;

    if (size > 0xffffff || size < 10) break;

    const bitReader = new BitReader(fileData, dataOffset, compressedSize, initialBufferLen);
    const outData = new Uint8Array(decompressedSize);
    let outPos = decompressedSize;

    function copyRaw(length) {
      for (; length > 0 && outPos > 0; length--) {
        outPos--;
        outData[outPos] = bitReader.read(8);
      }
    }

    function copyRef(length, offsetBitCount) {
      const offset = bitReader.read(offsetBitCount) + 1;
      if (outPos + offset > outData.length) return;
      for (; length > 0 && outPos > 0; length--) {
        outPos--;
        outData[outPos] = outData[outPos + offset];
      }
    }

    while (outPos > 0 && !bitReader.eof()) {
      if (bitReader.read(1) === 0) {
        if (bitReader.read(1) === 0) {
          copyRaw(bitReader.read(3) + 1);
        } else {
          copyRef(2, 8);
        }
      } else {
        const bits = bitReader.read(2);
        switch (bits) {
          case 0: copyRef(3, 9); break;
          case 1: copyRef(4, 10); break;
          case 2: copyRef(bitReader.read(8) + 1, 12); break;
          case 3: copyRaw(bitReader.read(8) + 9); break;
        }
      }
    }

    parts.push(outData);
    pos += size;
  }

  return parts;
}

// ─── MIDI Writer ───

class MidiWriter {
  constructor() {
    this.tracks = [];
    this.ticksPerBeat = 480;
  }

  newTrack() {
    const track = [];
    this.tracks.push(track);
    return track;
  }

  writeFile(filePath) {
    const chunks = [];
    const header = Buffer.alloc(14);
    header.write('MThd', 0);
    header.writeUInt32BE(6, 4);
    header.writeUInt16BE(1, 8);
    header.writeUInt16BE(this.tracks.length, 10);
    header.writeUInt16BE(this.ticksPerBeat, 12);
    chunks.push(header);

    for (const track of this.tracks) {
      const trackData = this.encodeTrack(track);
      const trackHeader = Buffer.alloc(8);
      trackHeader.write('MTrk', 0);
      trackHeader.writeUInt32BE(trackData.length, 4);
      chunks.push(trackHeader);
      chunks.push(trackData);
    }

    writeFileSync(filePath, Buffer.concat(chunks));
  }

  encodeTrack(events) {
    const bytes = [];
    let lastTick = 0;
    events.sort((a, b) => a.tick - b.tick);

    for (const ev of events) {
      const delta = Math.max(0, Math.round(ev.tick - lastTick));
      lastTick = ev.tick;
      this.writeVarLen(bytes, delta);

      if (ev.type === 'meta') {
        bytes.push(0xff, ev.metaType);
        this.writeVarLen(bytes, ev.data.length);
        for (const b of ev.data) bytes.push(b);
      } else if (ev.type === 'noteOn') {
        bytes.push(0x90 | ev.channel, ev.note, ev.velocity);
      } else if (ev.type === 'noteOff') {
        bytes.push(0x80 | ev.channel, ev.note, 0);
      } else if (ev.type === 'programChange') {
        bytes.push(0xc0 | ev.channel, ev.program);
      }
    }

    this.writeVarLen(bytes, 0);
    bytes.push(0xff, 0x2f, 0x00);
    return Buffer.from(bytes);
  }

  writeVarLen(bytes, value) {
    const buf = [];
    buf.push(value & 0x7f);
    value >>= 7;
    while (value > 0) {
      buf.push((value & 0x7f) | 0x80);
      value >>= 7;
    }
    buf.reverse();
    for (const b of buf) bytes.push(b);
  }
}

// ─── SoundImage → MIDI conversion ───

function readWordLE(data, pos) {
  return (data[pos] || 0) | ((data[pos + 1] || 0) << 8);
}

function readByte(data, pos) {
  return data[pos] || 0;
}

function oplToMidiNote(fnum, octave) {
  if (fnum === 0) return 60;
  const freq = (fnum * 49716) / Math.pow(2, 20 - octave);
  if (freq <= 0) return 60;
  const midiNote = Math.round(69 + 12 * Math.log2(freq / 440));
  return Math.max(0, Math.min(127, midiNote));
}

function convertTrack(data, config, trackIndex) {
  const songHeaderPos = readWordLE(data, config.instructionsOffset + trackIndex * 2);

  if (songHeaderPos === 0 || songHeaderPos >= data.length - 6) return null;

  let offset = songHeaderPos;
  const sampleRateFactor = readWordLE(data, offset); offset += 2;
  const instrumentPos = readWordLE(data, offset) + config.instructionsOffset; offset += 2;
  const waitCycles = readByte(data, offset); offset++;
  const channelCount = readByte(data, offset); offset++;

  if (channelCount === 0 || channelCount > 9 || waitCycles === 0) return null;

  const channelPrograms = [];
  for (let i = 0; i < channelCount; i++) {
    channelPrograms.push(readWordLE(data, offset) + config.instructionsOffset);
    offset += 2;
  }

  const midi = new MidiWriter();

  // Tempo track
  const tempoTrack = midi.newTrack();
  const usPerBeat = Math.round((sampleRateFactor / 210) * (waitCycles + 1) * 500);
  const clampedTempo = Math.max(200000, Math.min(2000000, usPerBeat));
  const tempoBytes = [(clampedTempo >> 16) & 0xff, (clampedTempo >> 8) & 0xff, clampedTempo & 0xff];
  tempoTrack.push({ tick: 0, type: 'meta', metaType: 0x51, data: tempoBytes });

  const programs = [81, 80, 38, 4, 73, 68, 48, 51, 25];

  for (let ch = 0; ch < channelCount; ch++) {
    const track = midi.newTrack();
    const midiChannel = ch >= 9 ? ch + 1 : ch;

    track.push({ tick: 0, type: 'programChange', channel: midiChannel, program: programs[ch % programs.length] });

    const progPtr = channelPrograms[ch];
    if (progPtr >= data.length - 2) continue;

    let channelPosition = readWordLE(data, progPtr) + config.instructionsOffset;
    let programPointer = progPtr + 2;

    let tick = 0;
    let waitSum = 1;
    let currentNote = -1;
    let di00h = 0;
    let di12h = 0;
    let maxIter = 30000;

    while (maxIter-- > 0) {
      if (channelPosition >= data.length || channelPosition < 0) break;

      const cmd = readByte(data, channelPosition);
      channelPosition++;

      if ((cmd & 0x80) === 0) {
        // Note on
        if (currentNote >= 0) {
          track.push({ tick, type: 'noteOff', channel: midiChannel, note: currentNote });
        }

        di00h = cmd;
        const mainPos = ((di00h + di12h) & 0xff) + 4;
        const octave = readByte(data, mainPos + config.octavesOffset);
        const freqCountIdx = readByte(data, mainPos + config.frequenciesCountOffset);
        const fnum = readWordLE(data, config.frequenciesOffset + freqCountIdx * 32);

        const midiNote = oplToMidiNote(fnum & 0x7fff, octave & 0x07);
        currentNote = midiNote;

        track.push({ tick, type: 'noteOn', channel: midiChannel, note: midiNote, velocity: 90 });
        tick += waitSum * (midi.ticksPerBeat / 4);

      } else if (cmd >= 0xe0) {
        waitSum = cmd - 0xdf;

      } else if (config.version === 1 && cmd >= 0xc0 && cmd < 0xe0) {
        // Envelope/instrument v1
        const instrIdx = cmd - 0xc0;
        const instrPos = instrumentPos + ((instrIdx - 1) << 4);
        if (instrPos >= 0 && instrPos + 8 < data.length) {
          di12h = readByte(data, instrPos + 8);
        }

      } else if (config.version === 2 && cmd > 0xa0 && cmd < 0xe0) {
        // Envelope/instrument v2
        const instrIdx = cmd - 0xa0;
        const instrPos = instrumentPos + ((instrIdx - 1) << 4);
        if (instrPos >= 0 && instrPos + 8 < data.length) {
          di12h = readByte(data, instrPos + 8);
        }

      } else {
        // Command byte
        const subCmd = cmd & 0x0f;

        if (subCmd === 0) {
          // Next section / loop
          if (programPointer >= data.length - 2) break;
          const cx = readWordLE(data, programPointer);
          programPointer += 2;

          if (cx === 0) {
            // Loop: read new program pointer
            if (programPointer >= data.length - 2) break;
            const newProgBase = readWordLE(data, programPointer) + config.instructionsOffset;
            programPointer = newProgBase + 2;
            channelPosition = readWordLE(data, newProgBase) + config.instructionsOffset;
            // Only loop once for MIDI export
            break;
          } else {
            channelPosition = cx + config.instructionsOffset;
          }

        } else if (subCmd === 1) {
          // Note off with wait
          if (currentNote >= 0) {
            track.push({ tick, type: 'noteOff', channel: midiChannel, note: currentNote });
            currentNote = -1;
          }
          tick += waitSum * (midi.ticksPerBeat / 4);

        } else if (subCmd === 2) {
          // Rest
          tick += waitSum * (midi.ticksPerBeat / 4);

        } else if (subCmd === 3 || subCmd === 5) {
          // End of song / stop channel
          break;

        } else if (subCmd === 4) {
          // Transpose
          if (channelPosition < data.length) {
            di12h = readByte(data, channelPosition);
            channelPosition++;
          }

        } else if (subCmd === 8) {
          // Volume - skip parameter byte
          channelPosition++;
        }
        // subCmd 6,7 = portamento markers, ignore for MIDI
      }
    }

    if (currentNote >= 0) {
      track.push({ tick, type: 'noteOff', channel: midiChannel, note: currentNote });
    }
  }

  // Check we actually got some notes
  let totalNotes = 0;
  for (const track of midi.tracks) {
    totalNotes += track.filter(e => e.type === 'noteOn').length;
  }
  if (totalNotes < 3) return null;

  return midi;
}

function convert(inputPath, outputDir, configName) {
  const cfg = CONFIGS[configName];
  if (!cfg) {
    console.error(`Unknown config: ${configName}. Use 'lemmings' or 'ohno'`);
    process.exit(1);
  }

  const names = TRACK_NAMES[configName] || [];
  const rawData = readFileSync(resolve(inputPath));

  console.log(`\nDecompressing ${inputPath}...`);
  const parts = decompress(rawData);
  console.log(`  Found ${parts.length} part(s)`);

  if (parts.length === 0) {
    console.error('  ERROR: Could not decompress file. Trying raw data...');
    // Fall through to try raw
  }

  // The ADLIB.DAT typically decompresses to a single part containing the sound driver + data
  const data = parts.length > 0 ? parts[0] : rawData;
  console.log(`  Decompressed size: ${data.length} bytes`);
  console.log(`  Config: ${configName} (${cfg.numberOfTracks} tracks, version ${cfg.version})`);
  console.log('─'.repeat(50));

  mkdirSync(resolve(outputDir), { recursive: true });

  let converted = 0;
  for (let i = 0; i < cfg.numberOfTracks; i++) {
    const trackName = names[i] || `Track ${i + 1}`;
    const midi = convertTrack(data, cfg, i);

    if (!midi) {
      console.log(`  Track ${i + 1}: ${trackName} - skipped (no usable data)`);
      continue;
    }

    // Add track name meta event
    const nameBytes = [...Buffer.from(trackName)];
    midi.tracks[0].push({ tick: 0, type: 'meta', metaType: 0x03, data: nameBytes });

    const safeName = trackName.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/ +/g, '_');
    const outPath = resolve(outputDir, `${String(i + 1).padStart(2, '0')}_${safeName}.mid`);
    midi.writeFile(outPath);

    let noteCount = 0;
    for (const t of midi.tracks) noteCount += t.filter(e => e.type === 'noteOn').length;
    console.log(`  Track ${i + 1}: ${trackName} → ${noteCount} notes`);
    converted++;
  }

  console.log(`\nConverted ${converted}/${cfg.numberOfTracks} tracks → ${outputDir}`);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node lemmings-convert.js <ADLIB.DAT> <output-dir> [lemmings|ohno]');
  console.error('  Configs: lemmings (20 tracks), ohno (6 tracks)');
  process.exit(1);
}

const configName = args[2] || 'lemmings';
convert(args[0], args[1], configName);
