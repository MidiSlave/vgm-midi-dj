/**
 * OLED Synth Controller Visualizer Engine (128×64 canvas pixel space).
 *
 * Each `draw*` function renders one parameter's animation into a standard
 * Canvas 2D context. The integration module rasterises the canvas into the
 * LCXL3's monochrome bitmap buffer by thresholding luminance.
 *
 * Ported from the prototype `oled-synth-controller-visualizer` package
 * (TypeScript / Vite); type annotations stripped, drawing logic unchanged.
 * `val` is 0..100 throughout; `time` is seconds (or any monotonically
 * increasing value used for animation phase).
 */

function getSynthWaveform(x, time, frequency, amp) {
  return (
    Math.sin(x * 0.15 + time * frequency) * amp * 0.6 +
    Math.sin(x * 0.35 + time * frequency * 1.8) * amp * 0.3 +
    Math.cos(x * 0.05 - time * 0.8) * amp * 0.1
  );
}

function drawDottedLine(ctx, x1, y1, x2, y2, spacing = 3) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.floor(dist / spacing));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = Math.round(x1 + (x2 - x1) * t);
    const py = Math.round(y1 + (y2 - y1) * t);
    ctx.fillRect(px, py, 1, 1);
  }
}

function drawBezel(ctx, title, valueStr) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 1);
  ctx.fillRect(0, 15, 128, 1);
  ctx.fillRect(0, 63, 128, 1);
  ctx.fillRect(0, 0, 1, 64);
  ctx.fillRect(127, 0, 1, 64);

  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(title.toUpperCase(), 4, 11);

  ctx.textAlign = 'right';
  ctx.fillText(valueStr, 124, 11);
}

// 1. Channel LP/HP Filter
export function drawFilter(ctx, time, val) {
  let label = 'NEUTRAL';
  if (val < 48) label = `LP ${Math.round(val * 2)}%`;
  else if (val > 52) label = `HP ${Math.round((val - 50) * 2)}%`;

  drawBezel(ctx, 'FILTER', label);

  const startY = 40;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const cutoffX = Math.round((val / 100) * 128);

  ctx.moveTo(1, startY);
  for (let x = 1; x < 127; x++) {
    let y = startY;
    if (val < 48) {
      const dx = x - cutoffX;
      if (dx > 0) y = startY + Math.pow(dx * 0.4, 2);
    } else if (val > 52) {
      const dx = cutoffX - x;
      if (dx > 0) y = startY + Math.pow(dx * 0.4, 2);
    }
    y = Math.max(18, Math.min(61, y));
    ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  for (let x = 6; x < 124; x += 3) {
    let limitY = startY;
    if (val < 48) {
      const dx = x - cutoffX;
      if (dx > 0) limitY = startY + Math.pow(dx * 0.4, 2);
    } else if (val > 52) {
      const dx = cutoffX - x;
      if (dx > 0) limitY = startY + Math.pow(dx * 0.4, 2);
    }
    limitY = Math.max(18, Math.min(61, limitY));

    const signalAmp = Math.sin(x * 0.2 + time * 12) * 10 + Math.cos(x * 0.5 - time * 8) * 6;
    const waveHeight = Math.max(0, signalAmp + 12);
    const bottomY = 60;
    const topY = Math.max(limitY, bottomY - waveHeight);

    for (let sy = bottomY; sy >= topY; sy -= 2) ctx.fillRect(x, sy, 1, 1);
  }

  drawDottedLine(ctx, 64, 18, 64, 61, 4);
}

// 2. Channel Pan
export function drawPan(ctx, time, val) {
  const panPercent = Math.round(val - 50);
  let panText = 'CENTER';
  if (panPercent < 0) panText = `L ${Math.abs(panPercent) * 2}%`;
  else if (panPercent > 0) panText = `R ${panPercent * 2}%`;

  drawBezel(ctx, 'PANNING', panText);

  const ampL = (100 - val) / 100;
  const ampR = val / 100;

  ctx.fillStyle = '#ffffff';
  const midY_L = 32;
  const midY_R = 48;

  for (let x = 8; x < 120; x++) {
    const wave = getSynthWaveform(x, time, 10, ampL * 12);
    ctx.fillRect(x, Math.round(midY_L + wave), 1, 1);
  }
  for (let x = 8; x < 120; x++) {
    const wave = getSynthWaveform(x, time + Math.PI, 10, ampR * 12);
    ctx.fillRect(x, Math.round(midY_R + wave), 1, 1);
  }

  ctx.font = '6px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('L', 4, midY_L + 2);
  ctx.fillText('R', 4, midY_R + 2);

  const sliderWidth = 80;
  const startX = 24;
  const sliderY = 58;
  ctx.fillRect(startX, sliderY, sliderWidth, 1);
  ctx.fillRect(64, sliderY - 2, 1, 5);
  const handleX = Math.round(startX + (val / 100) * sliderWidth);
  ctx.fillRect(handleX - 3, sliderY - 2, 7, 5);
  ctx.fillStyle = '#000000';
  ctx.fillRect(handleX, sliderY - 1, 1, 3);
}

// 3. Channel Reverb Send
export function drawReverbSend(ctx, time, val) {
  drawBezel(ctx, 'REVERB SEND', `${Math.round(val)}%`);

  const centerX = 64;
  const centerY = 42;
  const sendNorm = val / 100;

  ctx.fillStyle = '#ffffff';
  const maxR = 22;
  const ringCount = 2;
  for (let i = 0; i < ringCount; i++) {
    const phase = (time * 1.5 + i / ringCount) % 1;
    const r = phase * maxR * sendNorm;
    if (r > 1) {
      for (let angle = 0; angle < Math.PI * 2; angle += 0.3) {
        const x = Math.round(centerX + Math.cos(angle) * r);
        const y = Math.round(centerY + Math.sin(angle) * r);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  ctx.beginPath();
  const centerSize = 2 + sendNorm * 5;
  ctx.arc(centerX, centerY, centerSize, 0, Math.PI * 2);
  ctx.fill();

  const particleCount = Math.floor(sendNorm * 20);
  for (let i = 0; i < particleCount; i++) {
    const speedMultiplier = 1 + sendNorm * 2;
    const angle = i * 2.3 + time * speedMultiplier;
    const radius = 6 + (Math.sin(time + i) * 3 + i * 2) % (15 * sendNorm + 2);
    const px = Math.round(centerX + Math.cos(angle) * radius);
    const py = Math.round(centerY + Math.sin(angle) * radius);
    if (px >= 2 && px < 126 && py >= 18 && py < 62) ctx.fillRect(px, py, 1, 1);
  }

  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(34, 58, 60, 4);
  const fillW = Math.round(sendNorm * 58);
  ctx.fillRect(35, 59, fillW, 2);
}

// 4. Channel Delay Send
export function drawDelaySend(ctx, time, val) {
  drawBezel(ctx, 'DELAY SEND', `${Math.round(val)}%`);
  const sendNorm = val / 100;
  const triggerX = 14;
  const targetX = 114;
  const bounceY = 40;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(triggerX - 4, bounceY - 14, 2, 28);
  ctx.fillRect(targetX + 2, bounceY - 14, 2, 28);

  ctx.font = '6px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('IN', triggerX - 10, bounceY + 3);
  ctx.fillText('ECHO', targetX + 6, bounceY + 3);

  const period = 1.8;
  const currentProgress = (time % period) / period;

  drawDottedLine(ctx, triggerX, bounceY, targetX, bounceY, 5);

  if (sendNorm > 0.05) {
    let pX = triggerX + currentProgress * (targetX - triggerX);
    const pSize = Math.round(1 + sendNorm * 4);
    if (currentProgress > 0.5) {
      pX = targetX - (currentProgress - 0.5) * 2 * (targetX - triggerX);
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(pX, bounceY, pSize, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < 4; i++) {
      const offset = (i + 1) * 0.04;
      let trailP = currentProgress - offset;
      if (trailP < 0) trailP += 1.0;
      let tX = triggerX + trailP * (targetX - triggerX);
      if (trailP > 0.5) tX = targetX - (trailP - 0.5) * 2 * (targetX - triggerX);
      const trailSize = Math.max(1, pSize - i - 1);
      ctx.fillRect(Math.round(tX - trailSize / 2), Math.round(bounceY - trailSize / 2), trailSize, trailSize);
    }

    const fbCount = Math.floor(sendNorm * 5);
    for (let i = 0; i < fbCount; i++) {
      const fbX = triggerX + ((time * 12 + i * 15) % (targetX - triggerX));
      const fbH = Math.sin(time * 8 + i) * 6 * sendNorm;
      drawDottedLine(ctx, fbX, bounceY - fbH, fbX, bounceY + fbH, 3);
    }
  }
}

// 5. Reverb Room Size
export function drawReverbSize(ctx, time, val) {
  drawBezel(ctx, 'ROOM SIZE', `${Math.round(val)} m³`);
  const centerX = 64;
  const centerY = 41;
  const baseVertices = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1,  1], [1, -1,  1], [1, 1,  1], [-1, 1,  1],
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const angleX = time * 0.45;
  const angleY = time * 0.70;
  const cubeScale = 6 + (val / 100) * 16;
  const projected = [];
  for (const v of baseVertices) {
    const x = v[0], y = v[1], z = v[2];
    const x1 = x * Math.cos(angleY) - z * Math.sin(angleY);
    const z1 = x * Math.sin(angleY) + z * Math.cos(angleY);
    const y2 = y * Math.cos(angleX) - z1 * Math.sin(angleX);
    const z2 = y * Math.sin(angleX) + z1 * Math.cos(angleX);
    const dist = 3.5;
    const perspective = dist / (dist - z2);
    const px = Math.round(centerX + x1 * cubeScale * perspective);
    const py = Math.round(centerY + y2 * cubeScale * perspective * 0.85);
    projected.push([px, py]);
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (const edge of edges) {
    const p1 = projected[edge[0]];
    const p2 = projected[edge[1]];
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(8, 22, 5, 1); ctx.fillRect(10, 20, 1, 5);
  ctx.fillRect(115, 22, 5, 1); ctx.fillRect(117, 20, 1, 5);
  ctx.fillRect(8, 57, 5, 1); ctx.fillRect(10, 55, 1, 5);
  ctx.fillRect(115, 57, 5, 1); ctx.fillRect(117, 55, 1, 5);
}

// 6. Reverb Decay
export function drawReverbDecay(ctx, time, val) {
  const decayTimeStr = (0.2 + (val / 100) * 12).toFixed(1) + ' s';
  drawBezel(ctx, 'DECAY TIME', decayTimeStr);
  const startX = 14, endX = 114;
  const startY = 30, groundY = 56;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  let first = true;
  for (let x = startX; x <= endX; x++) {
    const progress = (x - startX) / (endX - startX);
    const factor = 1 + (val / 100) * 12;
    const y = startY + (groundY - startY) * (1 - Math.exp(-progress * factor));
    if (first) { ctx.moveTo(x, Math.round(y)); first = false; }
    else ctx.lineTo(x, Math.round(y));
  }
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 4; i++) {
    const speed = 0.3 + (val / 100) * 0.1;
    const progress = ((time * speed) + i / 4) % 1;
    const x = startX + progress * (endX - startX);
    const factor = 1 + (val / 100) * 12;
    const y = startY + (groundY - startY) * (1 - Math.exp(-progress * factor));
    ctx.beginPath();
    ctx.arc(Math.round(x), Math.round(y), 2, 0, Math.PI * 2);
    ctx.fill();
    const poolSize = Math.floor(61 - y);
    if (poolSize > 0) {
      for (let sy = Math.round(y) + 2; sy < 60; sy += 3) ctx.fillRect(Math.round(x), sy, 1, 1);
    }
  }
  for (let x = startX; x <= endX; x++) {
    const waveY = 60 + Math.sin(x * 0.15 + time * 6) * 1.5;
    ctx.fillRect(x, Math.round(waveY), 1, 1);
  }
}

// 7. Reverb Damp
export function drawReverbDamp(ctx, time, val) {
  drawBezel(ctx, 'HF DAMPING', `${Math.round(val)}%`);
  const dampNorm = val / 100;
  const wallX = 64;
  ctx.fillStyle = '#ffffff';
  for (let y = 18; y < 62; y += 4) {
    ctx.fillRect(wallX, y, 2, 2);
    if (Math.sin(time * 5 + y) > 0.4) {
      ctx.fillRect(wallX + (Math.sin(y) > 0 ? 3 : -3), y, 1, 1);
    }
  }
  for (let x = 8; x < wallX; x++) {
    const noisyWave = Math.sin(x * 0.6 - time * 18) * 8 + Math.cos(x * 1.5 + time * 12) * 3;
    ctx.fillRect(x, Math.round(41 + noisyWave), 1, 1);
  }
  for (let x = wallX + 2; x < 120; x++) {
    const dampFactor = Math.max(0.05, 1 - dampNorm);
    const smoothWave = Math.sin(x * (0.6 * dampFactor) - time * 18) * (8 * dampFactor);
    ctx.fillRect(x, Math.round(41 + smoothWave), 1, 1);
  }
  ctx.font = '6px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('BRIGHT HF', 10, 58);
  ctx.fillText('ABSORBED', 80, 58);
}

// 8. Delay Time
export function drawDelayTime(ctx, time, val) {
  const ms = Math.round(50 + (val / 100) * 950);
  let beatLabel = '1/8';
  if (val < 15) beatLabel = '1/64';
  else if (val < 30) beatLabel = '1/32';
  else if (val < 45) beatLabel = '1/16';
  else if (val < 60) beatLabel = '1/8';
  else if (val < 75) beatLabel = '1/4';
  else if (val < 90) beatLabel = '1/2';
  else beatLabel = '1/1';
  drawBezel(ctx, 'DELAY TIME', `${ms}ms ${beatLabel}`);

  const gear1X = 35, gear2X = 93, gearY = 41, gearR = 14;
  const spinSpeed = 3.5 * (100 / (val + 10));
  const rotation = time * spinSpeed;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(gear1X, gearY, gearR, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const angle = rotation + (i * Math.PI) / 1.5;
    const sx = Math.round(gear1X - Math.cos(angle) * gearR);
    const sy = Math.round(gearY - Math.sin(angle) * gearR);
    drawDottedLine(ctx, gear1X, gearY, sx, sy, 3);
  }
  ctx.beginPath();
  ctx.arc(gear2X, gearY, gearR, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const angle = rotation * 0.8 + (i * Math.PI) / 1.5;
    const sx = Math.round(gear2X - Math.cos(angle) * gearR);
    const sy = Math.round(gearY - Math.sin(angle) * gearR);
    drawDottedLine(ctx, gear2X, gearY, sx, sy, 3);
  }
  ctx.fillRect(gear1X, gearY - gearR, gear2X - gear1X, 1);
  ctx.fillRect(gear1X, gearY + gearR, gear2X - gear1X, 1);

  const beltLength = (gear2X - gear1X) * 2 + Math.PI * gearR * 2;
  const beltProgress = (time * spinSpeed * 5) % beltLength;
  let markerX = gear1X, markerY = gearY - gearR;
  if (beltProgress < (gear2X - gear1X)) {
    markerX = gear1X + beltProgress;
    markerY = gearY - gearR;
  } else if (beltProgress < (gear2X - gear1X) + Math.PI * gearR) {
    const arcProgress = (beltProgress - (gear2X - gear1X)) / (Math.PI * gearR);
    const angle = -Math.PI / 2 + arcProgress * Math.PI;
    markerX = gear2X + Math.cos(angle) * gearR;
    markerY = gearY + Math.sin(angle) * gearR;
  } else if (beltProgress < 2 * (gear2X - gear1X) + Math.PI * gearR) {
    const progress = beltProgress - (gear2X - gear1X) - Math.PI * gearR;
    markerX = gear2X - progress;
    markerY = gearY + gearR;
  } else {
    const arcProgress = (beltProgress - 2 * (gear2X - gear1X) - Math.PI * gearR) / (Math.PI * gearR);
    const angle = Math.PI / 2 + arcProgress * Math.PI;
    markerX = gear1X + Math.cos(angle) * gearR;
    markerY = gearY + Math.sin(angle) * gearR;
  }
  ctx.fillRect(Math.round(markerX) - 1, Math.round(markerY) - 1, 3, 3);
}

// 9. Delay Feedback
export function drawDelayFeedback(ctx, time, val) {
  drawBezel(ctx, 'FEEDBACK', `${Math.round(val)}%`);
  const fbNorm = val / 100;
  const centerX = 64, centerY = 41;
  const tunnelCount = 5;
  const speed = 1.0 + fbNorm * 2.0;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (let i = 0; i < tunnelCount; i++) {
    const phase = ((time * speed) + i / tunnelCount) % 1;
    const sizeX = phase * 50 * (0.5 + fbNorm * 0.5) + 1;
    const sizeY = phase * 20 * (0.5 + fbNorm * 0.5) + 1;
    ctx.strokeRect(
      Math.round(centerX - sizeX),
      Math.round(centerY - sizeY),
      Math.round(sizeX * 2),
      Math.round(sizeY * 2),
    );
    if (i === 1) {
      drawDottedLine(ctx, centerX, centerY, centerX - 50, centerY - 20, 5);
      drawDottedLine(ctx, centerX, centerY, centerX + 50, centerY - 20, 5);
      drawDottedLine(ctx, centerX, centerY, centerX - 50, centerY + 20, 5);
      drawDottedLine(ctx, centerX, centerY, centerX + 50, centerY + 20, 5);
    }
  }
  if (val > 80) {
    ctx.fillStyle = '#ffffff';
    if (Math.floor(time * 12) % 2 === 0) {
      ctx.font = 'bold 6px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('! SELF OSC !', centerX, centerY + 4);
    }
    for (let r = 0; r < 3; r++) {
      const spikeX = Math.round(centerX + Math.cos(time * 15 + r) * 35);
      const spikeY = Math.round(centerY + Math.sin(time * 15 + r) * 12);
      ctx.fillRect(spikeX, spikeY, 2, 2);
    }
  }
}

// 10. Delay LP/HP Filter
export function drawDelayFilter(ctx, time, val) {
  let label = 'BYPASS';
  if (val < 48) label = `LP ${Math.round(val * 2)}%`;
  else if (val > 52) label = `HP ${Math.round((val - 50) * 2)}%`;
  drawBezel(ctx, 'DELAY FILTER', label);
  const startX = 20, endX = 108;
  const midY = 41;
  ctx.fillStyle = '#ffffff';
  const hpGateX = startX + Math.round((val > 50 ? (val - 50) / 50 : 0) * (endX - startX) * 0.8);
  const lpGateX = endX - Math.round((val < 50 ? (50 - val) / 50 : 0) * (endX - startX) * 0.8);
  ctx.fillRect(hpGateX, midY - 14, 2, 28);
  ctx.fillRect(lpGateX - 1, midY - 14, 2, 28);
  ctx.font = '6px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('L', hpGateX - 5, midY - 10);
  ctx.fillText('H', lpGateX + 4, midY - 10);
  for (let x = startX; x <= endX; x++) {
    const isInside = x >= hpGateX && x <= lpGateX;
    const amplitude = isInside ? 10 : 1;
    const waveY = getSynthWaveform(x, time, 12, amplitude);
    ctx.fillRect(x, Math.round(midY + waveY), 1, 1);
  }
  drawDottedLine(ctx, startX, midY, hpGateX, midY, 4);
  drawDottedLine(ctx, lpGateX, midY, endX, midY, 4);
}

/**
 * Rasterise the canvas into an LCXL3 OLED bitmap buffer (1216 bytes).
 * Threshold is a luminance sum (R+G+B). Anti-aliased pixels above the
 * threshold are treated as lit; everything else is off.
 */
export function rasterCanvasToOLEDBuffer(canvas, buffer, lumThreshold = 220) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, 128, 64);
  const data = img.data;
  // Clear buffer.
  for (let i = 0; i < buffer.length; i++) buffer[i] = 0;
  for (let y = 0; y < 64; y++) {
    const rowBase = y * 19;
    for (let x = 0; x < 128; x++) {
      const idx = (y * 128 + x) * 4;
      const lum = data[idx] + data[idx + 1] + data[idx + 2];
      if (lum > lumThreshold) {
        buffer[rowBase + (x / 7 | 0)] |= 1 << (6 - (x % 7));
      }
    }
  }
}

/** Make an offscreen 128×64 canvas with non-smoothed text-friendly defaults. */
export function makeOLEDCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'alphabetic';
  return canvas;
}
