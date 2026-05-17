const CHANNEL_MAP = {
  JUNO_106: 0,    // Ch 1 - Pads / chords
  SH01A: 1,       // Ch 2 - Leads / arps
  BASS_STATION: 2, // Ch 3 - Bass
  KEYTAR: 3,      // Ch 4 - Melody
  TR08: 9,        // Ch 10 - Drums (GM standard)
};

const GM_TO_TR08 = {
  35: 36, // Acoustic Bass Drum → TR-08 Bass Drum
  36: 36, // Bass Drum 1
  37: 37, // Side Stick → Rim Shot
  38: 38, // Acoustic Snare
  39: 39, // Hand Clap
  40: 38, // Electric Snare → Snare
  41: 43, // Low Floor Tom → Low Tom
  42: 42, // Closed Hi-Hat
  43: 43, // High Floor Tom → Low Tom
  44: 42, // Pedal Hi-Hat → Closed HH
  45: 47, // Low Tom → Mid Tom
  46: 46, // Open Hi-Hat
  47: 47, // Low-Mid Tom → Mid Tom
  48: 50, // Hi-Mid Tom → High Tom
  49: 49, // Crash Cymbal → Cymbal
  50: 50, // High Tom
  51: 49, // Ride Cymbal → Cymbal
  52: 49, // Chinese Cymbal → Cymbal
  53: 49, // Ride Bell → Cymbal
  54: 42, // Tambourine → Closed HH
  55: 49, // Splash Cymbal → Cymbal
  56: 56, // Cowbell
  57: 49, // Crash Cymbal 2 → Cymbal
  62: 62, // Mute Hi Conga → Hi Conga
  63: 62, // Open Hi Conga → Hi Conga
  64: 64, // Low Conga
};

function remapDrumNote(note) {
  return GM_TO_TR08[note] || note;
}

function classifyChannel(events) {
  let hasNotes = false;
  let noteRange = { min: 127, max: 0 };
  let programs = new Set();

  for (const ev of events) {
    if (ev.type === 'noteOn') {
      hasNotes = true;
      noteRange.min = Math.min(noteRange.min, ev.note);
      noteRange.max = Math.max(noteRange.max, ev.note);
    }
    if (ev.type === 'programChange') {
      programs.add(ev.program);
    }
  }

  if (!hasNotes) return 'empty';

  const range = noteRange.max - noteRange.min;
  const avgNote = (noteRange.min + noteRange.max) / 2;

  if (programs.size > 0) {
    const prog = [...programs][0];
    if (prog >= 0 && prog <= 7) return 'piano';
    if (prog >= 24 && prog <= 31) return 'guitar';
    if (prog >= 32 && prog <= 39) return 'bass';
    if (prog >= 48 && prog <= 55) return 'strings';
    if (prog >= 56 && prog <= 63) return 'brass';
    if (prog >= 80 && prog <= 87) return 'lead';
    if (prog >= 88 && prog <= 95) return 'pad';
  }

  if (avgNote < 48 && range < 24) return 'bass';
  if (range < 12 && avgNote > 60) return 'lead';
  if (range > 24) return 'pad';

  return 'melody';
}

function suggestRouting(classification) {
  switch (classification) {
    case 'pad':
    case 'strings':
    case 'piano':
      return CHANNEL_MAP.JUNO_106;
    case 'lead':
    case 'guitar':
      return CHANNEL_MAP.SH01A;
    case 'bass':
      return CHANNEL_MAP.BASS_STATION;
    case 'melody':
    case 'brass':
      return CHANNEL_MAP.KEYTAR;
    default:
      return CHANNEL_MAP.SH01A;
  }
}

export { CHANNEL_MAP, GM_TO_TR08, remapDrumNote, classifyChannel, suggestRouting };
