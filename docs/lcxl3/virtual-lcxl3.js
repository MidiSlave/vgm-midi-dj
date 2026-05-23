/**
 * Virtual LCXL3 Component
 *
 * On-screen representation of the Launch Control XL 3 hardware.
 * Dual-mode: virtual interaction + real WebMIDI bridge.
 *
 * Layout uses absolute positioning within a 1000×920 design space,
 * auto-scaled via CSS transform to fit the container.
 * Coordinates traced from real hardware reference.
 */

// CC numbers matching the real hardware (DAW mode, channel 1)
const BUTTON_CCS = {
    SOLO_ARM: [37, 38, 39, 40, 41, 42, 43, 44],
    MUTE_SELECT: [45, 46, 47, 48, 49, 50, 51, 52],
    PLAY: 116,
    RECORD: 118,
    TRACK_LEFT: 102,
    TRACK_RIGHT: 103,
    PAGE_UP: 106,
    PAGE_DOWN: 107,
};

// Encoder CCs (channel 16, relative mode)
const ENCODER_CCS = {
    ROW_A: [13, 14, 15, 16, 17, 18, 19, 20],
    ROW_B: [21, 22, 23, 24, 25, 26, 27, 28],
    ROW_C: [29, 30, 31, 32, 33, 34, 35, 36],
};

// Fader CCs (channel 16, absolute)
const FADER_CCS = [5, 6, 7, 8, 9, 10, 11, 12];

// LED control indices. Per Novation's LCXL3 Mk3 programmer's reference these
// are the same as the Control Change numbers used for the corresponding input
// events ("The Control Change indices listed are also used for sending colour
// to the corresponding LEDs"). The arrays we lifted from baeng-raembl had
// SOLO/MUTE pointing at the wrong indices — fixed below to match the PDF.
const CONTROL_INDEX = {
    ENCODERS_A: [0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14], // CCs 13-20
    ENCODERS_B: [0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C], // CCs 21-28
    ENCODERS_C: [0x1D, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24], // CCs 29-36
    SOLO_ARM:    [0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, 0x2C], // CCs 37-44
    MUTE_SELECT: [0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x32, 0x33, 0x34], // CCs 45-52
};

// SysEx constants for real hardware
const SYSEX_HEADER = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x15];
const CMD_DAW_MODE = 0x02;
const CMD_CONFIGURE_DISPLAY = 0x04;
const CMD_RGB_LED = 0x01;
const CMD_RGB_LED_TYPE = 0x53;
const CMD_BITMAP = 0x09;

// Hardware-traced coordinates (1000×1000 design space)
const TRACE = {
    colXs: [296.3, 371.17, 444.71, 519.97, 593.38, 667.98, 741.12, 815.99],
    knobRowsY: [217.62, 313.16, 406.71],
    ledRowYs: [250.53, 342.56, 435.31],
    ledXs: [291.78, 365.98, 440.18, 514.39, 588.19, 662.4, 736.6, 810.81],
    ledW: 10.37,
    ledH: 4.52,
    faderY: 487.31,
    faderH: 209.45,
    faderW: 8.38,
    faderXs: [292.11, 365.31, 440.52, 514.72, 588.53, 662.73, 736.93, 811.14],
    faderCapW: 51.86,
    faderCapH: 27.93,
    stripY1: 739.04,
    stripY2: 797.05,
    stripH: 38.3,
    stripX: 147,
    stripW: 704.37,
    display: { x: 142.05, y: 194.47, w: 87.06, h: 53.92 },
    pagePad: { x: 147.89, y: 294.48, w: 75, h: 38 },
    trackPad: { x: 147.89, y: 387.56, w: 75, h: 38 },
    recPlayPad: { x: 147, y: 490.75, w: 75, h: 75 },
    shiftModePad: { x: 147, y: 618.37, w: 75, h: 75 },
};

// Design space dimensions
const DESIGN_W = 1000;
const DESIGN_H = 920;

// Dead zone above chassis body (nothing visible above this Y)
const DESIGN_TOP_DEAD = 115;

export class VirtualLCXL3 {
    constructor(container, options = {}) {
        this._container = typeof container === 'string'
            ? document.getElementById(container)
            : container;

        this._logoPath = options.logoPath || '../../../Reference/LCXL3_logo.png';

        // Callbacks
        this._ccCallbacks = [];
        this._buttonDownCallbacks = [];
        this._buttonUpCallbacks = [];

        // State
        this._shiftHeld = false;
        this._faderValues = new Array(8).fill(64);
        this._ledColours = new Map(); // index -> {r,g,b}

        // WebMIDI
        this._midiInput = null;
        this._midiOutput = null;
        this._connected = false;

        // Hardware send throttling
        this._pendingBitmap = null;
        this._bitmapSendScheduled = false;
        this._lastLedSent = new Map();    // index -> 'r,g,b' (last flushed to hw)
        this._pendingLeds = new Map();    // index -> {r,g,b} (awaiting flush)
        this._ledFlushScheduled = false;

        // Build DOM
        this._build();

        // Attempt WebMIDI connection
        this._initMIDI();

        // Clear hardware LEDs/display on page unload
        this._cleanupHandler = () => this.cleanup();
        window.addEventListener('pagehide', this._cleanupHandler);
        window.addEventListener('beforeunload', this._cleanupHandler);
    }

    // ── Public API ──

    onCC(callback) {
        this._ccCallbacks.push(callback);
        return () => {
            const i = this._ccCallbacks.indexOf(callback);
            if (i >= 0) this._ccCallbacks.splice(i, 1);
        };
    }

    onButtonDown(callback) {
        this._buttonDownCallbacks.push(callback);
        return () => {
            const i = this._buttonDownCallbacks.indexOf(callback);
            if (i >= 0) this._buttonDownCallbacks.splice(i, 1);
        };
    }

    onButtonUp(callback) {
        this._buttonUpCallbacks.push(callback);
        return () => {
            const i = this._buttonUpCallbacks.indexOf(callback);
            if (i >= 0) this._buttonUpCallbacks.splice(i, 1);
        };
    }

    // Register a single callback that fires every time the driver finishes a
    // fresh connect handshake (DAW mode enabled, relative encoders armed).
    // Integration code uses this to re-send LED state after a hot replug.
    onConnect(callback) {
        this._onConnectCallback = callback;
    }

    /** Send bitmap buffer (1216 bytes) to the OLED canvas + real hardware.
     *  Canvas updates immediately; hardware sends are throttled to ~20 FPS
     *  so rapid encoder turns and animation don't flood the SysEx bus. */
    renderBitmap(buffer) {
        if (!buffer || buffer.length !== 1216) return;

        // Virtual canvas — always immediate
        this._drawBitmapToCanvas(buffer);

        // Hardware — coalesce: store latest buffer, schedule one send
        if (this._midiOutput) {
            this._pendingBitmap = buffer;
            if (!this._bitmapSendScheduled) {
                this._bitmapSendScheduled = true;
                setTimeout(() => {
                    this._bitmapSendScheduled = false;
                    if (this._pendingBitmap && this._midiOutput) {
                        const msg = new Uint8Array([
                            ...SYSEX_HEADER, CMD_BITMAP, 0x35,
                            ...this._pendingBitmap, 0x7F, 0xF7
                        ]);
                        try { this._midiOutput.send(msg); } catch (e) { /* ignore */ }
                        this._pendingBitmap = null;
                    }
                }, 50); // ~20 FPS max to hardware
            }
        }
    }

    /** Set an encoder LED colour */
    setEncoderLED(row, col, r, g, b) {
        const rows = [CONTROL_INDEX.ENCODERS_A, CONTROL_INDEX.ENCODERS_B, CONTROL_INDEX.ENCODERS_C];
        const index = rows[row]?.[col];
        if (index === undefined) return;
        this._setLED(index, r, g, b);
    }

    /** Set a button LED colour by CC number */
    setButtonLED(cc, r, g, b) {
        const saIdx = BUTTON_CCS.SOLO_ARM.indexOf(cc);
        if (saIdx >= 0) {
            this._setLED(CONTROL_INDEX.SOLO_ARM[saIdx], r, g, b);
            return;
        }
        const msIdx = BUTTON_CCS.MUTE_SELECT.indexOf(cc);
        if (msIdx >= 0) {
            this._setLED(CONTROL_INDEX.MUTE_SELECT[msIdx], r, g, b);
            return;
        }
    }

    /** Clear all hardware LEDs, blank the OLED, and disable DAW mode */
    cleanup() {
        if (!this._midiOutput) return;

        const sendLed = (index) => {
            try {
                this._midiOutput.send(new Uint8Array([
                    ...SYSEX_HEADER, CMD_RGB_LED, CMD_RGB_LED_TYPE,
                    index, 0, 0, 0, 0xF7
                ]));
            } catch (e) { /* port may already be closing */ }
        };

        // Clear encoders (0x0D–0x24)
        for (let i = 0x0D; i <= 0x24; i++) sendLed(i);
        // Clear buttons (0x25–0x34)
        for (let i = 0x25; i <= 0x34; i++) sendLed(i);
        // Solo/Arm + Mute/Select (DAW mode indices)
        for (const idx of [...CONTROL_INDEX.SOLO_ARM, ...CONTROL_INDEX.MUTE_SELECT]) sendLed(idx);
        // Mode buttons
        sendLed(0x41);
        sendLed(0x42);

        // Blank the OLED display
        try {
            const blank = new Uint8Array(1216);
            const msg = new Uint8Array([...SYSEX_HEADER, CMD_BITMAP, 0x35, ...blank, 0x7F, 0xF7]);
            this._midiOutput.send(msg);
        } catch (e) { /* ignore */ }

        // Disable DAW mode
        try {
            this._midiOutput.send(new Uint8Array([...SYSEX_HEADER, CMD_DAW_MODE, 0x00, 0xF7]));
        } catch (e) { /* ignore */ }

        // Detach MIDI listener
        if (this._midiInput) this._midiInput.onmidimessage = null;
        this._connected = false;
        this._lastLedSent.clear();
        this._pendingLeds.clear();
        this._pendingBitmap = null;
    }

    get connected() { return this._connected; }
    get shiftHeld() { return this._shiftHeld; }

    // ── DOM Construction ──

    _build() {
        // Panel wrapper — 1000×920 design space
        this._panel = document.createElement('div');
        this._panel.className = 'lcxl3-panel';

        // Device body (dark chassis background)
        const body = document.createElement('div');
        body.className = 'lcxl3-body';
        this._panel.appendChild(body);

        // Logo
        const logo = document.createElement('img');
        logo.className = 'lcxl3-logo';
        logo.src = this._logoPath;
        logo.alt = 'Launch Control XL';
        logo.draggable = false;
        this._panel.appendChild(logo);

        // OLED display
        this._buildOLED();

        // 3 × 8 encoder knobs with LED indicators
        this._buildEncoders();

        // 8 faders
        this._buildFaders();

        // Side button pads
        this._buildSidePads();

        // Bottom strip rows (Solo/Arm + Mute/Select)
        this._buildStrips();

        // Side text labels
        this._buildLabels();

        // Add to container
        this._container.appendChild(this._panel);

        // Auto-scale to fit container
        this._setupScaling();
    }

    _buildOLED() {
        const d = TRACE.display;
        const frame = document.createElement('div');
        frame.className = 'lcxl3-oled-frame';
        frame.style.left = d.x + 'px';
        frame.style.top = d.y + 'px';
        frame.style.width = '128px';
        frame.style.height = '64px';

        this._oledCanvas = document.createElement('canvas');
        this._oledCanvas.className = 'lcxl3-oled';
        this._oledCanvas.width = 128;
        this._oledCanvas.height = 64;
        this._oledCtx = this._oledCanvas.getContext('2d');

        frame.appendChild(this._oledCanvas);
        this._panel.appendChild(frame);

        // Store reference for counter-scaling in _setupScaling()
        this._oledFrame = frame;
    }

    _buildEncoders() {
        this._encoderElements = [];
        const rowCCs = [ENCODER_CCS.ROW_A, ENCODER_CCS.ROW_B, ENCODER_CCS.ROW_C];

        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 8; c++) {
                // Knob (centred on trace coordinate)
                const knob = document.createElement('div');
                knob.className = 'lcxl3-encoder-knob';
                knob.style.left = TRACE.colXs[c] + 'px';
                knob.style.top = TRACE.knobRowsY[r] + 'px';
                this._attachEncoderDrag(knob, rowCCs[r][c]);
                this._panel.appendChild(knob);

                // LED below knob
                const led = document.createElement('div');
                led.className = 'lcxl3-encoder-led';
                led.style.left = TRACE.ledXs[c] + 'px';
                led.style.top = TRACE.ledRowYs[r] + 'px';
                led.style.width = TRACE.ledW + 'px';
                led.style.height = TRACE.ledH + 'px';
                this._panel.appendChild(led);

                this._encoderElements.push({ knob, led, row: r, col: c });
            }
        }
    }

    _buildFaders() {
        this._faderElements = [];

        for (let f = 0; f < 8; f++) {
            // Fader track
            const track = document.createElement('div');
            track.className = 'lcxl3-fader-track';
            track.style.left = TRACE.faderXs[f] + 'px';
            track.style.top = TRACE.faderY + 'px';
            track.style.width = TRACE.faderW + 'px';
            track.style.height = TRACE.faderH + 'px';
            this._panel.appendChild(track);

            // Fader thumb (centred on track, positioned at 50%)
            const thumb = document.createElement('div');
            thumb.className = 'lcxl3-fader-thumb';
            thumb.style.width = TRACE.faderCapW + 'px';
            thumb.style.height = TRACE.faderCapH + 'px';
            // Horizontally centre thumb on the fader track
            const thumbLeft = TRACE.faderXs[f] + (TRACE.faderW / 2) - (TRACE.faderCapW / 2);
            thumb.style.left = thumbLeft + 'px';
            // Initial position: 50%
            const range = TRACE.faderH - TRACE.faderCapH;
            const initialTop = TRACE.faderY + range * 0.5;
            thumb.style.top = initialTop + 'px';

            // Indicator line
            const line = document.createElement('div');
            line.className = 'lcxl3-fader-line';
            thumb.appendChild(line);

            this._panel.appendChild(thumb);

            this._attachFaderDrag(track, thumb, f);
            this._faderElements.push({ track, thumb });
        }
    }

    _buildSidePads() {
        // SVG chevron icons for nav buttons — wide, open wedges matching hardware
        const chevronV = (d) => `<svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="#777" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="${d}"/></svg>`;
        const chevronH = (d) => `<svg width="12" height="18" viewBox="0 0 12 18" fill="none" stroke="#777" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="${d}"/></svg>`;
        const chevronUp = chevronV('2,10 9,3 16,10');
        const chevronDown = chevronV('2,2 9,9 16,2');
        const chevronLeft = chevronH('10,2 3,9 10,16');
        const chevronRight = chevronH('2,2 9,9 2,16');

        // Page pad (horizontal: ∧ ∨)
        this._buildRubberPad(
            TRACE.pagePad, 'horizontal',
            { svg: chevronUp, cc: BUTTON_CCS.PAGE_UP, cls: 'nav-btn' },
            { svg: chevronDown, cc: BUTTON_CCS.PAGE_DOWN, cls: 'nav-btn' }
        );

        // Track pad (horizontal: < >)
        this._buildRubberPad(
            TRACE.trackPad, 'horizontal',
            { svg: chevronLeft, cc: BUTTON_CCS.TRACK_LEFT, cls: 'nav-btn' },
            { svg: chevronRight, cc: BUTTON_CCS.TRACK_RIGHT, cls: 'nav-btn' }
        );

        // Rec/Play pad (vertical)
        this._buildRubberPad(
            TRACE.recPlayPad, 'vertical',
            { label: '\u25CF', cc: BUTTON_CCS.RECORD, cls: 'rec-btn', transport: true },
            { label: '\u25B6', cc: BUTTON_CCS.PLAY, cls: 'play-btn', transport: true }
        );

        // Shift/Mode pad (vertical)
        const shiftModePad = this._buildRubberPad(
            TRACE.shiftModePad, 'vertical',
            { label: 'Shift', cc: null, cls: 'shift-btn' },
            { label: 'Mode', cc: null, cls: 'mode-btn' }
        );

        // Wire up shift button specially
        const shiftBtn = shiftModePad.querySelector('.shift-btn');
        if (shiftBtn) {
            this._shiftBtn = shiftBtn;
            shiftBtn.addEventListener('mousedown', () => {
                this._shiftHeld = true;
                shiftBtn.classList.add('held');
            });
            const shiftUp = () => {
                this._shiftHeld = false;
                shiftBtn.classList.remove('held');
            };
            shiftBtn.addEventListener('mouseup', shiftUp);
            shiftBtn.addEventListener('mouseleave', shiftUp);
        }
    }

    _buildRubberPad(pos, orientation, btn1, btn2) {
        const pad = document.createElement('div');
        pad.className = `lcxl3-rubber-pad ${orientation === 'vertical' ? 'vertical' : ''}`.trim();
        pad.style.left = pos.x + 'px';
        pad.style.top = pos.y + 'px';
        pad.style.width = pos.w + 'px';
        pad.style.height = pos.h + 'px';

        const b1 = this._makePadButton(btn1);
        const divider = document.createElement('div');
        divider.className = 'lcxl3-pad-divider';
        const b2 = this._makePadButton(btn2);

        pad.appendChild(b1);
        pad.appendChild(divider);
        pad.appendChild(b2);
        this._panel.appendChild(pad);
        return pad;
    }

    _makePadButton(config) {
        const btn = document.createElement('div');
        btn.className = `lcxl3-pad-btn ${config.cls || ''}`.trim();

        if (config.transport) {
            const led = document.createElement('div');
            led.className = 'lcxl3-transport-led';
            led.textContent = config.label;
            btn.appendChild(led);
        } else if (config.svg) {
            btn.innerHTML = config.svg;
        } else {
            btn.textContent = config.label;
        }

        if (config.cc !== null && config.cc !== undefined) {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('pressed');
                this._emitButtonDown(config.cc);
            });
            const up = () => {
                btn.classList.remove('pressed');
                this._emitButtonUp(config.cc);
            };
            btn.addEventListener('mouseup', up);
            btn.addEventListener('mouseleave', up);
        }

        return btn;
    }

    _buildStrips() {
        const pitch = TRACE.colXs[1] - TRACE.colXs[0]; // ~75px between columns
        const btnStartRel = (TRACE.colXs[0] - (pitch / 2)) - TRACE.stripX;

        // Solo/Arm strip
        this._saLeds = [];
        this._saButtons = [];
        this._buildStripRow(
            TRACE.stripY1, 'Solo / Arm', BUTTON_CCS.SOLO_ARM,
            this._saButtons, this._saLeds, pitch, btnStartRel,
            'DAW Control', 1
        );

        // Mute/Select strip
        this._msLeds = [];
        this._msButtons = [];
        this._buildStripRow(
            TRACE.stripY2, 'Mute / Select', BUTTON_CCS.MUTE_SELECT,
            this._msButtons, this._msLeds, pitch, btnStartRel,
            'DAW Mixer', 9
        );
    }

    _buildStripRow(y, labelText, ccs, btnArray, ledArray, pitch, btnStartRel, chassisLabel, numStart) {
        const strip = document.createElement('div');
        strip.className = 'lcxl3-strip-row';
        strip.style.left = TRACE.stripX + 'px';
        strip.style.top = y + 'px';
        strip.style.width = TRACE.stripW + 'px';
        strip.style.height = TRACE.stripH + 'px';

        // Layout: [Label] | [Device btn] | [1] [2] ...
        const deviceBtnW = 40;
        const labelW = btnStartRel - deviceBtnW;

        // Label section
        const labelBtn = document.createElement('div');
        labelBtn.className = 'lcxl3-strip-label';
        labelBtn.style.width = labelW + 'px';
        labelBtn.style.height = '100%';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'lcxl3-strip-label-text';
        labelSpan.textContent = labelText;
        labelBtn.appendChild(labelSpan);

        labelBtn.addEventListener('mousedown', () => labelBtn.classList.add('pressed'));
        labelBtn.addEventListener('mouseup', () => labelBtn.classList.remove('pressed'));
        labelBtn.addEventListener('mouseleave', () => labelBtn.classList.remove('pressed'));
        strip.appendChild(labelBtn);

        // Divider 1 (after label)
        const d1 = document.createElement('div');
        d1.className = 'lcxl3-strip-divider';
        d1.style.left = labelW + 'px';
        strip.appendChild(d1);

        // Device button (small icon section)
        const deviceBtn = document.createElement('div');
        deviceBtn.className = 'lcxl3-strip-btn';
        deviceBtn.style.left = (labelW + 3) + 'px';
        deviceBtn.style.width = (deviceBtnW - 3) + 'px';
        strip.appendChild(deviceBtn);

        // Divider 2 (before button 1)
        const d2 = document.createElement('div');
        d2.className = 'lcxl3-strip-divider';
        d2.style.left = btnStartRel + 'px';
        strip.appendChild(d2);

        // 8 track buttons
        for (let i = 0; i < 8; i++) {
            const centerRel = TRACE.colXs[i] - TRACE.stripX;
            const leftRel = centerRel - (pitch / 2);

            const btn = document.createElement('div');
            btn.className = 'lcxl3-strip-btn';
            btn.style.left = (leftRel + 3) + 'px';
            btn.style.width = (pitch - 3) + 'px';

            const led = document.createElement('div');
            led.className = 'lcxl3-button-led';
            btn.appendChild(led);

            this._attachButton(btn, ccs[i]);
            strip.appendChild(btn);
            btnArray.push(btn);
            ledArray.push(led);

            // Divider after button (except last)
            if (i < 7) {
                const div = document.createElement('div');
                div.className = 'lcxl3-strip-divider';
                div.style.left = (centerRel + (pitch / 2)) + 'px';
                strip.appendChild(div);
            }
        }

        this._panel.appendChild(strip);

        // Chassis text below strip — aligned with side label column
        const chassisLbl = document.createElement('div');
        chassisLbl.className = 'lcxl3-chassis-text';
        chassisLbl.textContent = chassisLabel;
        chassisLbl.style.left = '147px';
        chassisLbl.style.width = '75px';
        chassisLbl.style.top = (y + 42) + 'px';
        chassisLbl.style.textAlign = 'center';
        this._panel.appendChild(chassisLbl);

        for (let i = 0; i < 8; i++) {
            const num = document.createElement('div');
            num.className = 'lcxl3-chassis-text';
            num.textContent = numStart + i;
            num.style.width = pitch + 'px';
            num.style.textAlign = 'center';
            num.style.left = (TRACE.colXs[i] - pitch / 2) + 'px';
            num.style.top = (y + 42) + 'px';
            this._panel.appendChild(num);
        }
    }

    _buildLabels() {
        const labels = [
            { text: 'Page', x: 147, y: 275, w: 75 },
            { text: 'Track', x: 147, y: 370, w: 75 },
            { text: 'Settings', x: 147, y: 430, w: 75 },
            { text: 'Edit', x: 147, y: 700, w: 75 },
        ];

        labels.forEach(l => {
            const el = document.createElement('div');
            el.className = 'lcxl3-side-label';
            el.textContent = l.text;
            el.style.left = l.x + 'px';
            el.style.top = l.y + 'px';
            el.style.width = l.w + 'px';
            this._panel.appendChild(el);
        });
    }

    _setupScaling() {
        const update = () => {
            const containerW = this._container.clientWidth;
            if (containerW <= 0) return;
            const scale = Math.min(containerW / DESIGN_W, 1);
            // Shift panel up to cut the dead zone above the chassis
            this._panel.style.transform = `scale(${scale}) translateY(-${DESIGN_TOP_DEAD}px)`;
            this._container.style.height = `${(DESIGN_H - DESIGN_TOP_DEAD) * scale}px`;

            // Counter-scale the OLED so it always renders at 128×64 CSS pixels
            if (this._oledFrame) {
                const counterScale = 1 / scale;
                this._oledFrame.style.transform = `scale(${counterScale})`;
                this._oledFrame.style.transformOrigin = 'top left';
            }
        };

        this._resizeObserver = new ResizeObserver(update);
        this._resizeObserver.observe(this._container);
        update();
    }

    // ── Interaction Handlers ──

    _attachEncoderDrag(knob, cc) {
        let startY = 0;
        let accumulated = 0;

        const onMove = (e) => {
            const delta = startY - e.clientY;
            startY = e.clientY;
            accumulated += delta;

            // Every 3px of drag = 1 encoder tick
            while (accumulated >= 3) {
                accumulated -= 3;
                this._emitCC(cc, 1); // CW
            }
            while (accumulated <= -3) {
                accumulated += 3;
                this._emitCC(cc, 65); // CCW
            }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        knob.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            accumulated = 0;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Scroll wheel = fine control
        knob.addEventListener('wheel', (e) => {
            e.preventDefault();
            const dir = e.deltaY < 0 ? 1 : 65; // CW or CCW
            this._emitCC(cc, dir);
        }, { passive: false });
    }

    _attachFaderDrag(trackEl, thumbEl, index) {
        const cc = FADER_CCS[index];

        const onMove = (e) => {
            const rect = trackEl.getBoundingClientRect();
            const capH = TRACE.faderCapH;
            const range = rect.height - capH;
            // Calculate position from bottom (fader = 0 at bottom, 127 at top)
            const yFromTop = e.clientY - rect.top - capH / 2;
            const clamped = Math.max(0, Math.min(range, yFromTop));
            const value = Math.round((1 - clamped / range) * 127);
            this._faderValues[index] = value;
            // Position thumb in design space
            const designTop = TRACE.faderY + clamped;
            thumbEl.style.top = designTop + 'px';
            this._emitCC(cc, value);
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        // Allow clicking anywhere on the track
        trackEl.addEventListener('mousedown', (e) => {
            e.preventDefault();
            onMove(e);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Also allow dragging from the thumb
        thumbEl.addEventListener('mousedown', (e) => {
            e.preventDefault();
            onMove(e);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    _attachButton(el, cc) {
        el.addEventListener('mousedown', () => {
            el.classList.add('pressed');
            this._emitButtonDown(cc);
        });
        const up = () => {
            el.classList.remove('pressed');
            this._emitButtonUp(cc);
        };
        el.addEventListener('mouseup', up);
        el.addEventListener('mouseleave', up);
    }

    // ── Event Emission ──

    _emitCC(cc, value) {
        this._ccCallbacks.forEach(cb => cb(cc, value, this._shiftHeld));
    }

    _emitButtonDown(cc) {
        this._buttonDownCallbacks.forEach(cb => cb(cc, this._shiftHeld));
    }

    _emitButtonUp(cc) {
        this._buttonUpCallbacks.forEach(cb => cb(cc, this._shiftHeld));
    }

    // ── OLED Rendering ──

    _drawBitmapToCanvas(buffer) {
        const ctx = this._oledCtx;
        const imgData = ctx.createImageData(128, 64);
        const data = imgData.data;

        for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 128; x++) {
                const byteIndex = y * 19 + Math.floor(x / 7);
                const bitIndex = 6 - (x % 7);
                const on = (buffer[byteIndex] >> bitIndex) & 1;

                const i = (y * 128 + x) * 4;
                // OLED-style: white pixels on black
                data[i] = on ? 255 : 0;
                data[i + 1] = on ? 255 : 0;
                data[i + 2] = on ? 255 : 0;
                data[i + 3] = 255;
            }
        }

        ctx.putImageData(imgData, 0, 0);
    }

    // ── LED Control ──

    _setLED(index, r, g, b) {
        this._ledColours.set(index, { r, g, b });

        const cssColour = `rgb(${r * 2}, ${g * 2}, ${b * 2})`;

        // Virtual DOM — always immediate
        const encIdx = this._encoderElements.findIndex((_, i) => {
            const rows = [CONTROL_INDEX.ENCODERS_A, CONTROL_INDEX.ENCODERS_B, CONTROL_INDEX.ENCODERS_C];
            const flatIdx = rows.flat();
            return flatIdx[i] === index;
        });

        if (encIdx >= 0) {
            this._encoderElements[encIdx].led.style.background = cssColour;
        } else {
            const saIdx = CONTROL_INDEX.SOLO_ARM.indexOf(index);
            if (saIdx >= 0 && this._saLeds?.[saIdx]) {
                this._saLeds[saIdx].style.background = cssColour;
            } else {
                const msIdx = CONTROL_INDEX.MUTE_SELECT.indexOf(index);
                if (msIdx >= 0 && this._msLeds?.[msIdx]) {
                    this._msLeds[msIdx].style.background = cssColour;
                }
            }
        }

        // Hardware — batch into pending map, flush once per microtask.
        // This prevents flicker when callers set dim→bright in the same
        // synchronous render pass (only the final value reaches hardware).
        if (this._midiOutput) {
            this._pendingLeds.set(index, { r, g, b });
            if (!this._ledFlushScheduled) {
                this._ledFlushScheduled = true;
                queueMicrotask(() => this._flushLeds());
            }
        }
    }

    _flushLeds() {
        this._ledFlushScheduled = false;
        if (!this._midiOutput) { this._pendingLeds.clear(); return; }

        for (const [index, { r, g, b }] of this._pendingLeds) {
            const key = `${r},${g},${b}`;
            if (this._lastLedSent.get(index) === key) continue;
            this._lastLedSent.set(index, key);

            try {
                this._midiOutput.send(new Uint8Array([
                    ...SYSEX_HEADER, CMD_RGB_LED, CMD_RGB_LED_TYPE,
                    index, r & 0x7F, g & 0x7F, b & 0x7F, 0xF7
                ]));
            } catch (e) { /* ignore */ }
        }
        this._pendingLeds.clear();
    }

    // ── WebMIDI Bridge ──

    async _initMIDI() {
        if (!navigator.requestMIDIAccess) return;

        try {
            const access = await navigator.requestMIDIAccess({ sysex: true });
            this._findPorts(access);

            access.onstatechange = () => this._findPorts(access);
        } catch (e) {
            console.warn('[VirtualLCXL3] WebMIDI not available:', e.message);
        }
    }

    _findPorts(access) {
        let dawIn = null, dawOut = null;
        let anyIn = null, anyOut = null;

        // Only count ports whose state is 'connected'. WebMIDI keeps port
        // objects around with state='disconnected' after a hot-unplug, and
        // matching them by name alone leaves stale references that block the
        // DAW-mode re-enable on subsequent replug.
        const isLcxl3 = (port) =>
            port.state === 'connected' &&
            port.name &&
            (port.name.includes('Launch Control XL') || port.name.includes('LCXL3'));

        console.log('[VirtualLCXL3] Scanning MIDI inputs:');
        for (const [, port] of access.inputs) {
            console.log(`  IN: "${port.name}" (${port.manufacturer}) [${port.state}]`);
            if (isLcxl3(port)) {
                if (port.name.includes('DAW')) dawIn = port;
                else if (!anyIn) anyIn = port;
            }
        }

        console.log('[VirtualLCXL3] Scanning MIDI outputs:');
        for (const [, port] of access.outputs) {
            console.log(`  OUT: "${port.name}" (${port.manufacturer}) [${port.state}]`);
            if (isLcxl3(port)) {
                if (port.name.includes('DAW')) dawOut = port;
                else if (!anyOut) anyOut = port;
            }
        }

        console.log('[VirtualLCXL3] Matched:', {
            dawIn: dawIn?.name, dawOut: dawOut?.name,
            anyIn: anyIn?.name, anyOut: anyOut?.name
        });

        // Pick best ports — prefer the dedicated DAW pair, fall back to the
        // user-template pair. The LCXL3 Mk3 only exposes its DAW port AFTER
        // it has entered DAW mode, so on first contact we're typically on the
        // user-template port and must send the DAW-mode-enable SysEx there to
        // make the DAW port appear.
        const newInput = dawIn || anyIn;
        const newOutput = dawOut || anyOut;

        // Detach the previous input listener if the port reference changed —
        // otherwise a stale onmidimessage on a disconnected (or wrong) port
        // can leak duplicate events.
        if (this._midiInput && this._midiInput !== newInput) {
            try { this._midiInput.onmidimessage = null; } catch (_) {}
        }

        const prevInputId = this._midiInput?.id;
        const prevOutputId = this._midiOutput?.id;
        this._midiInput = newInput;
        this._midiOutput = newOutput;

        const wasConnected = this._connected;
        this._connected = !!(this._midiInput && this._midiOutput);
        const portsChanged =
            this._midiInput?.id !== prevInputId || this._midiOutput?.id !== prevOutputId;

        if (this._connected && (!wasConnected || portsChanged)) {
            const portKind = (this._midiInput.name || '').includes('DAW') ? 'DAW' : 'user';
            console.log(`[VirtualLCXL3] Connected via ${portKind} port: in="${this._midiInput.name}" out="${this._midiOutput.name}"`);

            // Forget any LED dedupe state — the device may have just powered on,
            // or we've swapped to a different port pair with unknown LED state.
            this._lastLedSent.clear();

            // Enable DAW mode. Idempotent: if we're already in DAW mode, the
            // device just no-ops. If we're on the user-template port, this is
            // what triggers the DAW port to appear (statechange fires next,
            // _findPorts swaps us onto the DAW port, and this branch runs
            // again because portsChanged).
            try {
                this._midiOutput.send(new Uint8Array([...SYSEX_HEADER, CMD_DAW_MODE, 0x7F, 0xF7]));
                console.log('[VirtualLCXL3] Sent DAW-mode-enable SysEx');
            } catch (e) {
                console.warn('[VirtualLCXL3] DAW-mode SysEx failed:', e.message);
            }

            // Select DAW Control sub-mode (B6 1E 02). DAW mode has two
            // sub-modes — Mixer (01h) and Control (02h) — with different CC
            // layouts. The PDF's CC numbering (37–44 SOLO, 45–52 MUTE etc.)
            // is the Control layout, so force it explicitly.
            try {
                this._midiOutput.send(new Uint8Array([0xB6, 0x1E, 0x02]));
                console.log('[VirtualLCXL3] Selected DAW Control sub-mode');
            } catch (_) {}

            // Enable relative encoders on each row (channel 7, CCs 69/72/73).
            try {
                this._midiOutput.send(new Uint8Array([0xB6, 69, 127]));
                this._midiOutput.send(new Uint8Array([0xB6, 72, 127]));
                this._midiOutput.send(new Uint8Array([0xB6, 73, 127]));
            } catch (_) {}

            // Disable auto-display so the device doesn't overwrite our OLED.
            this._disableAutoDisplay();

            // Listen for hardware input on the new port.
            this._midiInput.onmidimessage = (e) => this._handleHardwareMessage(e.data);

            const statusEl = document.getElementById('status');
            if (statusEl) {
                statusEl.textContent = `Connected: ${this._midiInput.name}`;
                statusEl.className = 'connected';
            }

            // Notify external listeners (integration module) — they may want
            // to re-paint LEDs now that the device has known-dark state.
            if (typeof this._onConnectCallback === 'function') {
                try { this._onConnectCallback(); } catch (_) {}
            }
        }

        if (!this._connected && wasConnected) {
            console.log('[VirtualLCXL3] Real LCXL3 disconnected');
        }

        if (!this._connected) {
            const statusEl = document.getElementById('status');
            if (statusEl) {
                statusEl.textContent = 'Disconnected \u2014 virtual only';
                statusEl.className = 'disconnected';
            }
        }
    }

    _disableAutoDisplay() {
        if (!this._midiOutput) return;

        // Config byte: arrangement NAME_NUMERIC (4) with auto-on-change
        // and auto-on-touch bits cleared (bits 6 & 5 = 0)
        const config = 0x04;

        const send = (target) => {
            try {
                this._midiOutput.send(new Uint8Array([
                    ...SYSEX_HEADER, CMD_CONFIGURE_DISPLAY, target, config, 0xF7
                ]));
            } catch (e) { /* ignore */ }
        };

        // Faders (0x05–0x0C)
        for (let i = 0x05; i <= 0x0C; i++) send(i);
        // Encoders (0x0D–0x24)
        for (let i = 0x0D; i <= 0x24; i++) send(i);
        // Global displays
        send(0x35); // STATIONARY
        send(0x36); // TEMPORARY
    }

    _handleHardwareMessage(data) {
        const status = data[0];
        const d1 = data[1];
        const d2 = data[2];

        // SysEx — ignore
        if (status >= 0xF0) return;

        const channel = (status & 0x0F) + 1;
        const type = status & 0xF0;

        // Verbose trace so we can see exactly what the LCXL3 sends. Cheap.
        if (this._traceMidiIn) {
            const hex = [...data].map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`[LCXL3 in] ${hex}  (ch ${channel}, type 0x${type.toString(16)}, d1 ${d1}, d2 ${d2})`);
        }

        // Shift on channel 7
        if (channel === 7 && d1 === 63) {
            this._shiftHeld = d2 === 127;
            this._shiftBtn?.classList.toggle('held', this._shiftHeld);
            return;
        }

        // Button presses. Per PDF buttons output on channel 1 as CC, but some
        // firmwares emit Note On instead, and the channel number can differ in
        // sub-modes. Accept either CC or Note On from any "low" channel as a
        // button event so we don't silently drop them.
        const isButtonCC = type === 0xB0 && channel <= 7 && (d2 === 0 || d2 === 127);
        const isButtonNote = (type === 0x90 || type === 0x80) && channel <= 7;
        if (isButtonCC || isButtonNote) {
            const down = type === 0x90 ? d2 > 0 : d2 === 127;
            if (down) this._emitButtonDown(d1);
            else this._emitButtonUp(d1);
            return;
        }

        // CC on channel 16 = encoder/fader
        if (type === 0xB0) {
            let cc = d1;
            let val = d2;

            // Relative encoders send on CCs 77-100 (base CC + 64).
            // Translate CC back to 13-36, and convert pivot-64 values
            // (65=CW +1, 63=CCW -1) to two's complement (1=CW, 127=CCW)
            // so consumers see the same encoding as virtual knob drags.
            if (cc >= 77 && cc <= 100) {
                cc -= 64;
                const delta = val - 64;
                if (delta === 0) return;
                val = delta > 0 ? delta : 128 + delta;
            }

            this._emitCC(cc, val);
        }
    }

    // Toggle the verbose MIDI-in trace from the console:
    //   window.lcxl3Debug.driver.setMidiInTrace(true)
    setMidiInTrace(on) { this._traceMidiIn = !!on; }
}

// Re-export constants for use by browsers
export { BUTTON_CCS, ENCODER_CCS, FADER_CCS, CONTROL_INDEX };
