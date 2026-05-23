/**
 * OLED List Renderer
 *
 * Renders list views to a 128x64 bitmap buffer compatible with the LCXL3 OLED.
 * Uses the same bitmap primitives as lcxl3-display.js but runs standalone
 * (duplicated here to avoid import path issues in test harnesses).
 */

// ── 5x7 Pixel Font ──
// Duplicated from lcxl3-display.js for standalone use

const FONT_5X7 = {
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
    '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    '2': [0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F],
    '3': [0x0E, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0E],
    '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    '5': [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
    '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
    '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
    'A': [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    'B': [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
    'C': [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
    'D': [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
    'E': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
    'F': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
    'G': [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0E],
    'H': [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    'I': [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
    'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
    'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
    'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
    'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
    'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
    'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
    'P': [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
    'Q': [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
    'R': [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
    'S': [0x0E, 0x11, 0x10, 0x0E, 0x01, 0x11, 0x0E],
    'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
    'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
    'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
    'X': [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
    'Y': [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
    'Z': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
    '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
    '+': [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
    '=': [0x00, 0x00, 0x1F, 0x00, 0x1F, 0x00, 0x00],
    '>': [0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10],
    '<': [0x01, 0x02, 0x04, 0x08, 0x04, 0x02, 0x01],
    '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
    ':': [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x00],
    '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x06],
    '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
    '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
    ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
    '[': [0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E],
    ']': [0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E],
    '*': [0x00, 0x04, 0x15, 0x0E, 0x15, 0x04, 0x00],
    '#': [0x0A, 0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x0A],
    '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
    '?': [0x0E, 0x11, 0x01, 0x06, 0x04, 0x00, 0x04],
    ',': [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x08],
    "'": [0x04, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
    '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
};

// ── Bitmap Primitives ──

export function createBitmapBuffer() {
    return new Uint8Array(1216);
}

export function setPixel(buffer, x, y, on = true) {
    if (x < 0 || x >= 128 || y < 0 || y >= 64) return;
    const byteIndex = y * 19 + Math.floor(x / 7);
    const bitIndex = 6 - (x % 7);
    if (on) {
        buffer[byteIndex] |= (1 << bitIndex);
    } else {
        buffer[byteIndex] &= ~(1 << bitIndex);
    }
}

export function drawHLine(buffer, x1, x2, y) {
    for (let x = x1; x <= x2; x++) setPixel(buffer, x, y, true);
}

export function drawVLine(buffer, x, y1, y2) {
    for (let y = y1; y <= y2; y++) setPixel(buffer, x, y, true);
}

export function drawRect(buffer, x, y, w, h) {
    drawHLine(buffer, x, x + w - 1, y);
    drawHLine(buffer, x, x + w - 1, y + h - 1);
    drawVLine(buffer, x, y, y + h - 1);
    drawVLine(buffer, x + w - 1, y, y + h - 1);
}

export function fillRect(buffer, x, y, w, h) {
    for (let dy = 0; dy < h; dy++) {
        drawHLine(buffer, x, x + w - 1, y + dy);
    }
}

/** Clear a rectangular area (set pixels off) */
export function clearRect(buffer, x, y, w, h) {
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            setPixel(buffer, x + dx, y + dy, false);
        }
    }
}

export function drawChar(buffer, char, x, y) {
    const charData = FONT_5X7[char.toUpperCase()] || FONT_5X7[' '];
    for (let row = 0; row < 7; row++) {
        const rowBits = charData[row];
        for (let col = 0; col < 5; col++) {
            if (rowBits & (0x10 >> col)) {
                setPixel(buffer, x + col, y + row, true);
            }
        }
    }
}

export function drawText(buffer, text, x, y, spacing = 1) {
    let curX = x;
    for (const char of text) {
        drawChar(buffer, char, curX, y);
        curX += 5 + spacing;
    }
    return curX - spacing;
}

export function measureText(text, spacing = 1) {
    return text.length * (5 + spacing) - spacing;
}

export function drawTextInverted(buffer, text, x, y, spacing = 1) {
    const width = measureText(text, spacing);
    fillRect(buffer, x - 1, y - 1, width + 2, 9);
    let curX = x;
    for (const char of text) {
        const charData = FONT_5X7[char.toUpperCase()] || FONT_5X7[' '];
        for (let row = 0; row < 7; row++) {
            const rowBits = charData[row];
            for (let col = 0; col < 5; col++) {
                if (rowBits & (0x10 >> col)) {
                    setPixel(buffer, curX + col, y + row, false);
                }
            }
        }
        curX += 5 + spacing;
    }
}

// ── List View Renderer ──

/**
 * Render a list view to a bitmap buffer
 *
 * Layout (21 chars x 8 lines):
 *   Line 0 (y=0):  Title bar (inverted)
 *   Line 1-6 (y=8-48): Items
 *   Line 7 (y=56): Status bar
 *
 * @param {Uint8Array} buffer - 1216-byte bitmap buffer
 * @param {Object} config
 * @param {string} config.title - Title bar text (left)
 * @param {string} [config.titleRight] - Title bar right text (e.g. position)
 * @param {Array} config.items - Visible items [{name, type?, meta?}]
 * @param {number} config.selectedIndex - Index within visible items
 * @param {number} config.scrollOffset - Overall scroll position
 * @param {number} config.total - Total item count
 * @param {string} [config.statusLeft] - Status bar left text
 * @param {string} [config.statusRight] - Status bar right text
 */
export function renderListView(buffer, config) {
    const {
        title, titleRight,
        items, selectedIndex, scrollOffset, total,
        statusLeft, statusRight
    } = config;

    // Title bar (inverted full-width)
    renderTitleBar(buffer, title, titleRight || `${scrollOffset + selectedIndex + 1}/${total}`);

    // List items (lines 1-6, y = 8 to 52)
    for (let i = 0; i < items.length && i < 6; i++) {
        const item = items[i];
        const y = 8 + (i * 8);
        const isSelected = (i === selectedIndex);

        // Build display string
        let prefix = ' ';
        if (item.type === 'folder') prefix = '>';
        let displayName = prefix + item.name;

        // Badge (slice count, sample count, etc.)
        let badge = '';
        if (item.meta?.sliceCount) badge = `[${item.meta.sliceCount}]`;
        if (item.meta?.sampleCount) badge = `(${item.meta.sampleCount})`;
        if (item.meta?.favourite) displayName += '*';

        // Truncate to fit (max ~20 chars with badge)
        const maxChars = badge ? 20 - badge.length - 1 : 21;
        if (displayName.length > maxChars) {
            displayName = displayName.substring(0, maxChars - 1) + '.';
        }

        if (isSelected) {
            // Full-width inverted row
            fillRect(buffer, 0, y - 1, 128, 9);
            // Draw text inverted
            let curX = 1;
            for (const char of displayName) {
                const charData = FONT_5X7[char.toUpperCase()] || FONT_5X7[' '];
                for (let row = 0; row < 7; row++) {
                    const rowBits = charData[row];
                    for (let col = 0; col < 5; col++) {
                        if (rowBits & (0x10 >> col)) {
                            setPixel(buffer, curX + col, y + row, false);
                        }
                    }
                }
                curX += 6;
            }
            // Badge (inverted)
            if (badge) {
                const badgeX = 128 - measureText(badge) - 2;
                for (const char of badge) {
                    const charData = FONT_5X7[char.toUpperCase()] || FONT_5X7[' '];
                    for (let row = 0; row < 7; row++) {
                        const rowBits = charData[row];
                        for (let col = 0; col < 5; col++) {
                            if (rowBits & (0x10 >> col)) {
                                setPixel(buffer, badgeX + (badge.indexOf(char)) * 6 + col, y + row, false);
                            }
                        }
                    }
                }
            }
        } else {
            drawText(buffer, displayName, 1, y);
            if (badge) {
                const badgeX = 128 - measureText(badge) - 2;
                drawText(buffer, badge, badgeX, y);
            }
        }
    }

    // Scrollbar (2px wide, right edge)
    if (total > 6) {
        const scrollbarX = 126;
        const trackY = 8;
        const trackH = 48;
        const thumbH = Math.max(4, Math.round(trackH * (6 / total)));
        const thumbY = trackY + Math.round((trackH - thumbH) * (scrollOffset / (total - 6)));

        // Track
        drawVLine(buffer, scrollbarX, trackY, trackY + trackH - 1);
        drawVLine(buffer, scrollbarX + 1, trackY, trackY + trackH - 1);

        // Clear track then draw thumb
        for (let y = trackY; y < trackY + trackH; y++) {
            setPixel(buffer, scrollbarX, y, false);
            setPixel(buffer, scrollbarX + 1, y, false);
        }
        for (let y = thumbY; y < thumbY + thumbH && y < trackY + trackH; y++) {
            setPixel(buffer, scrollbarX, y, true);
            setPixel(buffer, scrollbarX + 1, y, true);
        }
    }

    // Status bar
    if (statusLeft || statusRight) {
        renderStatusBar(buffer, statusLeft || '', statusRight || '');
    }
}

/**
 * Render inverted title bar at y=0
 */
export function renderTitleBar(buffer, text, rightText) {
    // Full-width inverted background
    fillRect(buffer, 0, 0, 128, 8);

    // Left text (inverted — clear pixels for text)
    let curX = 2;
    for (const char of text) {
        const charData = FONT_5X7[char.toUpperCase()] || FONT_5X7[' '];
        for (let row = 0; row < 7; row++) {
            const rowBits = charData[row];
            for (let col = 0; col < 5; col++) {
                if (rowBits & (0x10 >> col)) {
                    setPixel(buffer, curX + col, row + 1, false);
                }
            }
        }
        curX += 6;
    }

    // Right text (inverted)
    if (rightText) {
        const rw = measureText(rightText);
        let rX = 128 - rw - 2;
        for (const char of rightText) {
            const charData = FONT_5X7[char.toUpperCase()] || FONT_5X7[' '];
            for (let row = 0; row < 7; row++) {
                const rowBits = charData[row];
                for (let col = 0; col < 5; col++) {
                    if (rowBits & (0x10 >> col)) {
                        setPixel(buffer, rX + col, row + 1, false);
                    }
                }
            }
            rX += 6;
        }
    }
}

/**
 * Render status bar at y=56
 */
export function renderStatusBar(buffer, leftText, rightText) {
    // Separator line
    drawHLine(buffer, 0, 127, 55);

    if (leftText) {
        drawText(buffer, leftText, 2, 57);
    }

    if (rightText) {
        const rw = measureText(rightText);
        drawText(buffer, rightText, 128 - rw - 2, 57);
    }
}

// ── PPMod Visualisation Renderers ──

/**
 * Render a step bargraph (for TM/SEQ modes)
 * @param {Uint8Array} buffer
 * @param {number[]} steps - Array of step values (0-9 for TM, 0-100 for SEQ)
 * @param {number} selectedStep - Currently selected step index (-1 for none)
 * @param {number} playhead - Current playback step (-1 for none)
 * @param {number} y - Top Y position
 * @param {number} height - Bar area height
 * @param {number} maxValue - Maximum step value (9 for TM, 100 for SEQ)
 */
export function renderStepBargraph(buffer, steps, selectedStep, playhead, y, height, maxValue = 9) {
    const count = steps.length;
    const barWidth = Math.max(2, Math.floor(124 / count) - 1);
    const startX = 2;

    // Playhead indicator
    if (playhead >= 0 && playhead < count) {
        const px = startX + playhead * (barWidth + 1) + Math.floor(barWidth / 2);
        // Small triangle above bars
        setPixel(buffer, px, y - 2, true);
        setPixel(buffer, px - 1, y - 3, true);
        setPixel(buffer, px + 1, y - 3, true);
    }

    for (let i = 0; i < count; i++) {
        const x = startX + i * (barWidth + 1);
        const val = Math.max(0, Math.min(maxValue, steps[i] || 0));
        const barH = Math.round((val / maxValue) * height);

        if (barH > 0) {
            const barY = y + height - barH;
            fillRect(buffer, x, barY, barWidth, barH);
        }

        // Selected step highlight (invert the bar)
        if (i === selectedStep) {
            // Draw bracket below
            drawHLine(buffer, x, x + barWidth - 1, y + height + 1);
            setPixel(buffer, x, y + height + 2, true);
            setPixel(buffer, x + barWidth - 1, y + height + 2, true);
        }
    }
}

/**
 * Render animated waveform line (for LFO mode)
 * @param {Uint8Array} buffer
 * @param {string} waveform - 'sine', 'tri', 'square', 'saw'
 * @param {number} phase - Current phase 0-1
 * @param {number} y - Centre Y position
 * @param {number} height - Half-amplitude in pixels
 */
export function renderWaveformLine(buffer, waveform, phase, y, height) {
    for (let x = 0; x < 128; x++) {
        const t = ((x / 128) + phase) % 1;
        let val = 0;

        switch (waveform) {
            case 'sine':
                val = Math.sin(t * Math.PI * 2 * 3); // 3 cycles
                break;
            case 'tri':
                val = 1 - 4 * Math.abs((t * 3) % 1 - 0.5);
                break;
            case 'square':
                val = ((t * 3) % 1) < 0.5 ? 1 : -1;
                break;
            case 'saw':
                val = 2 * ((t * 3) % 1) - 1;
                break;
            default:
                val = Math.sin(t * Math.PI * 2 * 3);
        }

        const py = Math.round(y - val * height);
        setPixel(buffer, x, py, true);

        // Draw connecting line for square wave
        if (waveform === 'square' && x > 0) {
            const prevT = (((x - 1) / 128) + phase) % 1;
            const prevVal = ((prevT * 3) % 1) < 0.5 ? 1 : -1;
            if (prevVal !== val) {
                const y1 = Math.round(y - prevVal * height);
                const y2 = Math.round(y - val * height);
                const minY = Math.min(y1, y2);
                const maxY = Math.max(y1, y2);
                for (let ly = minY; ly <= maxY; ly++) {
                    setPixel(buffer, x, ly, true);
                }
            }
        }
    }
}

/**
 * Render AD envelope shape (for ENV mode)
 * @param {Uint8Array} buffer
 * @param {number} attack - Attack time (0-1 normalised)
 * @param {number} release - Release time (0-1 normalised)
 * @param {string} curve - 'linear', 'exp', 'log'
 * @param {number} y - Top Y position
 * @param {number} height - Envelope height in pixels
 */
export function renderEnvelopeShape(buffer, attack, release, curve, y, height) {
    const w = 100; // envelope width
    const startX = 14;
    const atkEnd = startX + Math.round(attack * w * 0.4); // 40% of space for attack
    const relStart = atkEnd;
    const relEnd = relStart + Math.round(release * w * 0.6); // 60% for release

    // Attack phase
    for (let x = startX; x <= atkEnd; x++) {
        const t = (x - startX) / Math.max(1, atkEnd - startX);
        let val;
        switch (curve) {
            case 'exp': val = t * t; break;
            case 'log': val = Math.sqrt(t); break;
            default: val = t;
        }
        const py = Math.round(y + height - val * height);
        setPixel(buffer, x, py, true);
    }

    // Release phase
    for (let x = relStart; x <= relEnd && x < 128; x++) {
        const t = (x - relStart) / Math.max(1, relEnd - relStart);
        let val;
        switch (curve) {
            case 'exp': val = 1 - t * t; break;
            case 'log': val = 1 - Math.sqrt(t); break;
            default: val = 1 - t;
        }
        const py = Math.round(y + height - val * height);
        setPixel(buffer, x, py, true);
    }
}

/**
 * Render depth bar with label
 * @param {Uint8Array} buffer
 * @param {number} depth - Depth 0-100
 * @param {number} y - Top Y position
 */
export function renderDepthBar(buffer, depth, y) {
    const label = `DEPTH`;
    const valueStr = `${Math.round(depth)}%`;

    drawText(buffer, label, 2, y);

    // Bar
    const barX = 38;
    const barW = 64;
    const barH = 7;
    drawRect(buffer, barX, y, barW, barH);
    const fillW = Math.round((barW - 2) * (depth / 100));
    if (fillW > 0) {
        fillRect(buffer, barX + 1, y + 1, fillW, barH - 2);
    }

    // Value
    drawText(buffer, valueStr, barX + barW + 4, y);
}
