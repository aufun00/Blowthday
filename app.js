"use strict";

const COUNT_MIN = 1;
const COUNT_MAX = 120;
const CALIBRATION_MS = 1600;
const BLOW_HOLD_MS = 180;

const countInput = document.querySelector("#candle-count");
const modeInput = document.querySelector("#candle-mode");
const modeLeft = document.querySelector("#mode-left");
const modeRight = document.querySelector("#mode-right");
const setup = document.querySelector(".setup");
const lightButton = document.querySelector("#light-button");
const buttonLabel = lightButton.querySelector(".button-label");
const buttonProgress = lightButton.querySelector(".button-progress");
const statusElement = document.querySelector("#status");
const noticeElement = document.querySelector("#notice");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const randomBetween = (min, max) => min + Math.random() * (max - min);

function readCount() {
  const parsed = Math.trunc(Number(countInput.value));
  const count = clamp(Number.isFinite(parsed) ? parsed : COUNT_MIN, COUNT_MIN, COUNT_MAX);
  countInput.value = String(count);
  return count;
}

function setStatus(message) {
  statusElement.textContent = message;
}

let noticeTimer = 0;
function showNotice(message) {
  window.clearTimeout(noticeTimer);
  noticeElement.textContent = message;
  noticeElement.hidden = false;
  noticeTimer = window.setTimeout(() => {
    noticeElement.hidden = true;
  }, 6500);
}

function setLocked(locked) {
  countInput.disabled = locked;
  modeInput.disabled = locked;
  lightButton.disabled = locked;
  setup.classList.toggle("is-locked", locked);
}

function setButton(label, progress = 0) {
  buttonLabel.textContent = label;
  buttonProgress.style.width = `${clamp(progress, 0, 1) * 100}%`;
}

class MicrophoneDiagnostics {
  constructor() {
    this.canvas = document.querySelector("#spectrum");
    this.ctx = this.canvas.getContext("2d");
    this.stateElement = document.querySelector("#diagnostic-state");
    this.processingElement = document.querySelector("#audio-processing");
    this.rmsElement = document.querySelector("#metric-rms");
    this.liftElement = document.querySelector("#metric-lift");
    this.bandsElement = document.querySelector("#metric-bands");
    this.holdElement = document.querySelector("#metric-hold");
    this.rmsFill = document.querySelector("#rms-fill");
    this.rmsThreshold = document.querySelector("#rms-threshold");
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.lastTelemetry = null;
    this.resize = this.resize.bind(this);
    window.addEventListener("resize", this.resize);
    this.resize();
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.lastTelemetry) this.draw(this.lastTelemetry);
  }

  setStage(label, state = "idle") {
    this.stateElement.textContent = label;
    this.stateElement.dataset.state = state;
  }

  setProcessing(settings, captureMode) {
    const setting = (name) => {
      if (settings?.[name] === true) return "ON";
      if (settings?.[name] === false) return "OFF";
      return "?";
    };
    const ns = setting("noiseSuppression");
    const ec = setting("echoCancellation");
    const agc = setting("autoGainControl");
    this.processingElement.textContent = `NS ${ns} · EC ${ec} · AGC ${agc}`;
    const processed = ns === "ON" || ec === "ON" || agc === "ON";
    this.processingElement.classList.toggle("is-raw", captureMode === "raw" && !processed);
    this.processingElement.classList.toggle("is-processed", processed);
    this.processingElement.title = captureMode === "raw"
      ? "浏览器接受了关闭音频处理的严格请求"
      : "浏览器未接受严格请求，已回退到兼容模式";
  }

  update(telemetry) {
    this.lastTelemetry = telemetry;
    const {
      features,
      baseline,
      candidateMs,
      candidate,
      active,
      stage,
      rmsLiftDb,
      lowLiftDb,
      highLiftDb
    } = telemetry;
    let label = "环境音";
    let state = "idle";

    if (stage === "calibrating") label = "采样中";
    else if (active) {
      label = "吹气成立";
      state = "blow";
    } else if (candidate) {
      label = "候选吹气";
      state = "candidate";
    } else if (baseline && features.rms > baseline.threshold) {
      label = "有声 · 频谱未通过";
      state = "sound";
    }
    this.setStage(label, state);

    const format = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : "--";
    const signed = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}` : "--";
    this.rmsElement.textContent = `${format(features.rms)} / ${format(baseline?.threshold)}`;
    this.liftElement.textContent = `${signed(rmsLiftDb)} dB`;
    this.bandsElement.textContent = `${signed(lowLiftDb)} / ${signed(highLiftDb)} dB`;
    this.holdElement.textContent = `${Math.round(candidateMs)} / ${BLOW_HOLD_MS} ms`;

    const meterMax = Math.max(0.08, (baseline?.threshold || 0.03) * 2.6);
    this.rmsFill.style.width = `${clamp(features.rms / meterMax, 0, 1) * 100}%`;
    this.rmsThreshold.style.left = `${clamp((baseline?.threshold || 0) / meterMax, 0, 1) * 100}%`;
    this.draw(telemetry);
  }

  draw({ frequencyData, sampleRate, active, candidate }) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!frequencyData?.length || !sampleRate) return;

    ctx.strokeStyle = "rgba(101, 72, 74, 0.1)";
    ctx.lineWidth = 1;
    for (let line = 1; line < 4; line += 1) {
      const y = this.height * line / 4;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(this.width, y + 0.5);
      ctx.stroke();
    }

    const barCount = clamp(Math.floor(this.width / 7), 32, 72);
    const gap = 2;
    const barWidth = Math.max(2, (this.width - gap * (barCount - 1)) / barCount);
    const fftSize = frequencyData.length * 2;
    const binHz = sampleRate / fftSize;
    const minFrequency = 80;
    const maxFrequency = Math.min(8000, sampleRate / 2);
    const color = active ? "#d94d50" : candidate ? "#e8794f" : "#dba45e";

    ctx.fillStyle = color;
    for (let bar = 0; bar < barCount; bar += 1) {
      const fromFrequency = minFrequency * Math.pow(maxFrequency / minFrequency, bar / barCount);
      const toFrequency = minFrequency * Math.pow(maxFrequency / minFrequency, (bar + 1) / barCount);
      const fromBin = clamp(Math.floor(fromFrequency / binHz), 1, frequencyData.length - 1);
      const toBin = clamp(Math.ceil(toFrequency / binHz), fromBin + 1, frequencyData.length);
      let magnitude = 0;
      for (let bin = fromBin; bin < toBin; bin += 1) magnitude = Math.max(magnitude, frequencyData[bin] / 255);
      const height = Math.max(1.5, Math.pow(magnitude, 0.72) * (this.height - 3));
      const x = bar * (barWidth + gap);
      ctx.globalAlpha = 0.42 + bar / barCount * 0.5;
      ctx.beginPath();
      ctx.roundRect(x, this.height - height, barWidth, height, Math.min(2, barWidth / 2));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

class CharacterArtwork {
  constructor(source) {
    this.canvas = null;
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => this.prepare(image), { once: true });
    image.src = source;
  }

  prepare(image) {
    const scale = Math.min(1, 640 / image.naturalWidth);
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    const data = pixels.data;
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    const isBackground = (pixel) => {
      const offset = pixel * 4;
      return data[offset] + data[offset + 1] + data[offset + 2] < 300;
    };
    const enqueue = (pixel) => {
      if (visited[pixel] || !isBackground(pixel)) return;
      visited[pixel] = 1;
      queue[tail++] = pixel;
    };

    for (let x = 0; x < width; x += 1) {
      enqueue(x);
      enqueue((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y += 1) {
      enqueue(y * width);
      enqueue(y * width + width - 1);
    }

    while (head < tail) {
      const pixel = queue[head++];
      data[pixel * 4 + 3] = 0;
      const x = pixel % width;
      if (x > 0) enqueue(pixel - 1);
      if (x < width - 1) enqueue(pixel + 1);
      if (pixel >= width) enqueue(pixel - width);
      if (pixel < width * (height - 1)) enqueue(pixel + width);
    }

    ctx.putImageData(pixels, 0, 0);
    this.canvas = canvas;
  }

  draw(ctx, centerX, topY, maxWidth, maxHeight) {
    if (!this.canvas) return;
    const scale = Math.min(maxWidth / this.canvas.width, maxHeight / this.canvas.height);
    const width = this.canvas.width * scale;
    const height = this.canvas.height * scale;
    ctx.drawImage(this.canvas, centerX - width / 2, topY, width, height);
  }
}

class BirthdaySong {
  constructor() {
    this.nodes = [];
    this.master = null;
    this.timer = 0;
    this.finish = null;
  }

  play(context) {
    this.stop();
    const beat = 60 / 128;
    const melody = [
      [67, 0.75], [67, 0.25], [69, 1], [67, 1], [72, 1], [71, 2],
      [67, 0.75], [67, 0.25], [69, 1], [67, 1], [74, 1], [72, 2],
      [67, 0.75], [67, 0.25], [79, 1], [76, 1], [72, 1], [71, 1], [69, 2],
      [77, 0.75], [77, 0.25], [76, 1], [72, 1], [74, 1], [72, 2]
    ];
    const master = context.createGain();
    master.gain.setValueAtTime(0.72, context.currentTime);
    master.connect(context.destination);
    this.master = master;
    let cursor = context.currentTime + 0.12;

    for (const [midi, beats] of melody) {
      const duration = beats * beat;
      const sounding = Math.max(0.08, duration * 0.88);
      const frequency = 440 * Math.pow(2, (midi - 69) / 12);
      const envelope = context.createGain();
      const harmonicGain = context.createGain();
      const fundamental = context.createOscillator();
      const harmonic = context.createOscillator();

      fundamental.type = "triangle";
      fundamental.frequency.setValueAtTime(frequency, cursor);
      harmonic.type = "sine";
      harmonic.frequency.setValueAtTime(frequency * 2, cursor);
      harmonicGain.gain.setValueAtTime(0.13, cursor);
      envelope.gain.setValueAtTime(0.0001, cursor);
      envelope.gain.exponentialRampToValueAtTime(0.095, cursor + 0.018);
      envelope.gain.exponentialRampToValueAtTime(0.0001, cursor + sounding);

      fundamental.connect(envelope);
      harmonic.connect(harmonicGain).connect(envelope);
      envelope.connect(master);
      fundamental.start(cursor);
      harmonic.start(cursor);
      fundamental.stop(cursor + sounding + 0.02);
      harmonic.stop(cursor + sounding + 0.02);
      this.nodes.push(fundamental, harmonic, envelope, harmonicGain);
      cursor += duration;
    }

    return new Promise((resolve) => {
      this.finish = resolve;
      this.timer = window.setTimeout(() => this.complete(true), Math.max(0, (cursor - context.currentTime + 0.24) * 1000));
    });
  }

  complete(completed) {
    window.clearTimeout(this.timer);
    this.timer = 0;
    const resolve = this.finish;
    this.finish = null;
    for (const node of this.nodes) {
      if (typeof node.stop === "function") {
        try { node.stop(); } catch {}
      }
      try { node.disconnect(); } catch {}
    }
    this.nodes = [];
    if (this.master) {
      try { this.master.disconnect(); } catch {}
      this.master = null;
    }
    if (resolve) resolve(completed);
  }

  stop() {
    if (this.finish || this.nodes.length) this.complete(false);
  }
}

class BirthdayScene {
  constructor(canvas, onAllExtinguished) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onAllExtinguished = onAllExtinguished;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.candles = [];
    this.particles = [];
    this.confetti = [];
    this.extinguishBudget = 0;
    this.blowVisual = 0;
    this.lastFrame = performance.now();
    this.characters = new CharacterArtwork("./raying.jpeg");
    this.palette = ["#ed625f", "#f5a14d", "#e78fb3", "#6bbab0", "#8875c8", "#f2c84b"];

    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    window.addEventListener("resize", this.resize);
    this.resize();
    requestAnimationFrame(this.frame);
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  createCandles(value, digitMode) {
    this.particles = [];
    this.confetti = [];
    this.extinguishBudget = 0;
    const digits = String(value).split("");

    if (digitMode) {
      const count = digits.length;
      this.candles = digits.map((digit, index) => ({
        type: "digit",
        digit,
        nx: (index - (count - 1) / 2) * Math.min(0.32, 0.72 / Math.max(1, count - 1)),
        ny: 0,
        color: this.palette[index % this.palette.length],
        phase: randomBetween(0, Math.PI * 2),
        lit: true,
        sx: 0,
        flameY: 0
      }));
    } else {
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      this.candles = Array.from({ length: value }, (_, index) => {
        const radius = Math.sqrt((index + 0.45) / value);
        const angle = index * goldenAngle;
        return {
          type: "plain",
          nx: Math.cos(angle) * radius * 0.86,
          ny: Math.sin(angle) * radius * 0.72,
          color: this.palette[index % this.palette.length],
          phase: randomBetween(0, Math.PI * 2),
          lit: true,
          sx: 0,
          flameY: 0
        };
      }).sort((a, b) => a.ny - b.ny);
    }

    document.body.classList.add("has-candles");
  }

  extinguishAll() {
    for (const candle of this.candles) candle.lit = false;
    this.blowVisual = 0;
  }

  clear() {
    this.candles = [];
    this.particles = [];
    this.confetti = [];
    document.body.classList.remove("has-candles");
  }

  get litCount() {
    return this.candles.reduce((count, candle) => count + (candle.lit ? 1 : 0), 0);
  }

  applyBlow(power, elapsedMs) {
    if (!this.litCount) return;
    this.blowVisual = Math.max(this.blowVisual, clamp(power, 0.25, 1.8));
    const rate = Math.max(2.3, this.candles.length * (0.34 + clamp(power, 0, 1.8) * 0.42));
    this.extinguishBudget += rate * elapsedMs / 1000;

    while (this.extinguishBudget >= 1 && this.litCount) {
      this.extinguishBudget -= 1;
      this.extinguishOne();
    }
  }

  extinguishOne() {
    const lit = this.candles.filter((candle) => candle.lit);
    if (!lit.length) return;
    const candle = lit[Math.floor(Math.random() * lit.length)];
    candle.lit = false;
    this.addSmoke(candle.sx, candle.flameY);

    if (this.litCount === 0) {
      this.celebrate();
      this.onAllExtinguished();
    }
  }

  addSmoke(x, y) {
    for (let index = 0; index < 5; index += 1) {
      this.particles.push({
        x: x + randomBetween(-2, 2),
        y,
        vx: randomBetween(-8, 12),
        vy: randomBetween(-36, -20),
        size: randomBetween(3, 7),
        life: randomBetween(0.7, 1.15),
        age: 0
      });
    }
  }

  celebrate() {
    const colors = ["#ed625f", "#ffc35a", "#65b9af", "#8b77c9", "#ef9abb"];
    for (let index = 0; index < 90; index += 1) {
      this.confetti.push({
        x: randomBetween(this.width * 0.1, this.width * 0.9),
        y: randomBetween(-80, -10),
        vx: randomBetween(-45, 45),
        vy: randomBetween(75, 170),
        rotation: randomBetween(0, Math.PI * 2),
        vr: randomBetween(-5, 5),
        size: randomBetween(4, 9),
        color: colors[index % colors.length],
        age: 0,
        life: randomBetween(2.8, 4.2)
      });
    }
  }

  frame(now) {
    const elapsed = Math.min(40, now - this.lastFrame);
    this.lastFrame = now;
    this.update(elapsed / 1000);
    this.draw(now / 1000);
    requestAnimationFrame(this.frame);
  }

  update(dt) {
    this.blowVisual *= Math.pow(0.07, dt);

    for (const smoke of this.particles) {
      smoke.age += dt;
      smoke.x += smoke.vx * dt;
      smoke.y += smoke.vy * dt;
      smoke.vx += 8 * dt;
      smoke.size += 4 * dt;
    }
    this.particles = this.particles.filter((particle) => particle.age < particle.life);

    for (const piece of this.confetti) {
      piece.age += dt;
      piece.x += piece.vx * dt;
      piece.y += piece.vy * dt;
      piece.vy += 25 * dt;
      piece.rotation += piece.vr * dt;
    }
    this.confetti = this.confetti.filter((piece) => piece.age < piece.life && piece.y < this.height + 30);
  }

  cakeGeometry() {
    const radiusX = Math.min(this.width * 0.39, 310);
    const radiusY = Math.max(48, radiusX * 0.29);
    const centerX = this.width / 2;
    const cakeHeight = clamp(this.height * 0.2, 108, 172);
    const latestTop = this.height - cakeHeight - radiusY - 42;
    const topY = Math.max(this.height * 0.42, Math.min(this.height * 0.64, latestTop));
    return { centerX, topY, radiusX, radiusY, cakeHeight };
  }

  draw(time) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    const cake = this.cakeGeometry();
    this.drawTable(ctx, cake);
    this.drawCake(ctx, cake, time);
    this.drawCandles(ctx, cake, time);
    this.drawSmoke(ctx);
    this.drawConfetti(ctx);
  }

  drawTable(ctx, cake) {
    const { centerX: x, topY: y, radiusX: rx, radiusY: ry, cakeHeight: h } = cake;
    const plateY = y + h + ry * 0.02;
    const shadow = ctx.createRadialGradient(
      x, plateY + ry * 0.82, 12,
      x, plateY + ry * 0.82, rx * 1.42
    );
    shadow.addColorStop(0, "rgba(105, 67, 62, 0.2)");
    shadow.addColorStop(0.58, "rgba(105, 67, 62, 0.09)");
    shadow.addColorStop(1, "rgba(105, 67, 62, 0)");
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(x, plateY + ry * 0.82, rx * 1.4, ry * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();

    const plateEdge = ctx.createLinearGradient(0, plateY - ry * 0.55, 0, plateY + ry * 0.55);
    plateEdge.addColorStop(0, "#fffdf8");
    plateEdge.addColorStop(0.52, "#f3e9d8");
    plateEdge.addColorStop(1, "#cdbb9b");
    ctx.fillStyle = plateEdge;
    ctx.beginPath();
    ctx.ellipse(x, plateY, rx * 1.19, ry * 1.08, 0, 0, Math.PI * 2);
    ctx.fill();

    const plateFace = ctx.createRadialGradient(x - rx * 0.25, plateY - ry * 0.25, 0, x, plateY, rx * 1.12);
    plateFace.addColorStop(0, "#ffffff");
    plateFace.addColorStop(0.72, "#fffaf0");
    plateFace.addColorStop(1, "#e3d5bd");
    ctx.fillStyle = plateFace;
    ctx.beginPath();
    ctx.ellipse(x, plateY - 5, rx * 1.12, ry * 0.98, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(156, 130, 91, 0.24)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, plateY - 5, rx * 1.04, ry * 0.86, 0, 0, Math.PI * 2);
    ctx.stroke();

    const contactShadow = ctx.createRadialGradient(x, plateY + ry * 0.18, rx * 0.46, x, plateY + ry * 0.18, rx * 1.05);
    contactShadow.addColorStop(0, "rgba(92, 63, 29, 0.17)");
    contactShadow.addColorStop(0.72, "rgba(92, 63, 29, 0.1)");
    contactShadow.addColorStop(1, "rgba(92, 63, 29, 0)");
    ctx.fillStyle = contactShadow;
    ctx.beginPath();
    ctx.ellipse(x, plateY + ry * 0.18, rx * 1.04, ry * 0.84, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawCake(ctx, cake, time) {
    const { centerX: x, topY: y, radiusX: rx, radiusY: ry, cakeHeight: h } = cake;
    const side = new Path2D();
    side.moveTo(x - rx, y);
    side.lineTo(x - rx, y + h);
    side.bezierCurveTo(x - rx, y + h + ry, x + rx, y + h + ry, x + rx, y + h);
    side.lineTo(x + rx, y);
    side.closePath();

    const body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, "#ead8b5");
    body.addColorStop(0.5, "#d8ba83");
    body.addColorStop(1, "#b8894c");
    ctx.fillStyle = body;
    ctx.fill(side);

    ctx.save();
    ctx.clip(side);

    ctx.fillStyle = "rgba(255, 248, 224, 0.16)";
    for (let index = 0; index < 56; index += 1) {
      const tx = x - rx + ((index * 83) % 197) / 197 * rx * 2;
      const ty = y + 8 + ((index * 47) % 101) / 101 * (h - 4);
      ctx.beginPath();
      ctx.arc(tx, ty, index % 3 === 0 ? 1.1 : 0.65, 0, Math.PI * 2);
      ctx.fill();
    }

    const sideShade = ctx.createLinearGradient(x - rx, 0, x + rx, 0);
    sideShade.addColorStop(0, "rgba(81, 57, 28, 0.24)");
    sideShade.addColorStop(0.18, "rgba(255, 255, 255, 0.1)");
    sideShade.addColorStop(0.5, "rgba(255, 255, 255, 0.2)");
    sideShade.addColorStop(0.84, "rgba(255, 255, 255, 0.02)");
    sideShade.addColorStop(1, "rgba(78, 49, 18, 0.27)");
    ctx.fillStyle = sideShade;
    ctx.fillRect(x - rx, y, rx * 2, h + ry);

    if (this.litCount) {
      const glowStrength = 0.035 + Math.min(1, this.litCount / 14) * 0.08;
      const sideGlow = ctx.createRadialGradient(x, y + h * 0.18, 0, x, y + h * 0.2, rx * 0.92);
      sideGlow.addColorStop(0, `rgba(255, 190, 74, ${glowStrength})`);
      sideGlow.addColorStop(1, "rgba(255, 190, 74, 0)");
      ctx.fillStyle = sideGlow;
      ctx.fillRect(x - rx, y, rx * 2, h + ry);
    }

    this.characters.draw(ctx, x, y + ry * 0.78, rx * 1.42, h * 0.94);
    ctx.restore();

    const topEdge = ctx.createLinearGradient(0, y - ry, 0, y + ry);
    topEdge.addColorStop(0, "#fbf3df");
    topEdge.addColorStop(0.64, "#e7d2aa");
    topEdge.addColorStop(1, "#b99358");
    ctx.fillStyle = topEdge;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    const glaze = ctx.createRadialGradient(x - rx * 0.28, y - ry * 0.46, 5, x, y, rx);
    glaze.addColorStop(0, "#fffdf6");
    glaze.addColorStop(0.56, "#f6ead0");
    glaze.addColorStop(1, "#d8bd8a");
    ctx.fillStyle = glaze;
    ctx.beginPath();
    ctx.ellipse(x, y - 3, rx * 0.94, ry * 0.84, 0, 0, Math.PI * 2);
    ctx.fill();

    if (this.litCount) {
      const pulse = 0.8 + Math.sin(time * 3.4) * 0.08;
      const topGlow = ctx.createRadialGradient(x, y - 8, 0, x, y - 4, rx * 0.78);
      topGlow.addColorStop(0, `rgba(255, 196, 82, ${0.15 * pulse})`);
      topGlow.addColorStop(0.7, `rgba(255, 196, 82, ${0.045 * pulse})`);
      topGlow.addColorStop(1, "rgba(255, 196, 82, 0)");
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, y - 3, rx * 0.94, ry * 0.84, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = topGlow;
      ctx.fillRect(x - rx, y - ry, rx * 2, ry * 2);
      ctx.restore();
    }

    ctx.strokeStyle = "rgba(135, 102, 55, 0.26)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, y - 3, rx * 0.84, ry * 0.69, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.beginPath();
    ctx.ellipse(x - rx * 0.53, y + h * 0.28, rx * 0.07, h * 0.26, 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  drawCandles(ctx, cake, time) {
    const count = this.candles.length;
    const plainHeight = count > 70 ? 31 : count > 40 ? 38 : count > 20 ? 47 : 61;
    const plainWidth = count > 70 ? 4.5 : count > 40 ? 6 : count > 20 ? 7 : 9;

    for (const candle of this.candles) {
      const x = cake.centerX + candle.nx * cake.radiusX * 0.82;
      const surface = Math.sqrt(Math.max(0, 1 - Math.pow(candle.nx * 0.9, 2)));
      const y = cake.topY + candle.ny * cake.radiusY * surface * 0.78;

      if (candle.type === "digit") {
        this.drawDigitCandle(ctx, candle, x, y, time);
      } else {
        const depthScale = 0.82 + (candle.ny + 0.75) * 0.13;
        this.drawPlainCandle(ctx, candle, x, y, plainWidth * depthScale, plainHeight * depthScale, time);
      }
    }
  }

  drawPlainCandle(ctx, candle, x, baseY, width, height, time) {
    const top = baseY - height;
    ctx.save();
    ctx.fillStyle = "rgba(79, 39, 42, 0.12)";
    ctx.beginPath();
    ctx.ellipse(x + 3, baseY + 2, width * 0.85, width * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = candle.color;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, top, width, height, width / 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - width / 2, top, width, height, width / 2);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.58)";
    ctx.lineWidth = Math.max(2, width * 0.26);
    for (let stripe = top - 8; stripe < baseY + 10; stripe += Math.max(10, width * 1.5)) {
      ctx.beginPath();
      ctx.moveTo(x - width, stripe + 8);
      ctx.lineTo(x + width, stripe - 8);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = "#5d4240";
    ctx.lineWidth = Math.max(1, width * 0.14);
    ctx.beginPath();
    ctx.moveTo(x, top + 1);
    ctx.lineTo(x, top - 6);
    ctx.stroke();
    candle.sx = x;
    candle.flameY = top - 12;
    if (candle.lit) this.drawFlame(ctx, x, top - 8, Math.max(0.68, width / 9), candle.phase, time);
    ctx.restore();
  }

  drawDigitCandle(ctx, candle, x, baseY, time) {
    const size = clamp(this.width * 0.13, 58, 84);
    const top = baseY - size * 0.88;
    ctx.save();
    ctx.font = `900 ${size}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(7, size * 0.12);
    ctx.strokeStyle = "rgba(117, 48, 53, 0.22)";
    ctx.strokeText(candle.digit, x + 2, baseY + 3);
    ctx.strokeStyle = "#fff4dc";
    ctx.lineWidth = Math.max(5, size * 0.075);
    ctx.strokeText(candle.digit, x, baseY);
    ctx.fillStyle = candle.color;
    ctx.fillText(candle.digit, x, baseY);

    ctx.strokeStyle = "#5d4240";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top + 5);
    ctx.lineTo(x, top - 5);
    ctx.stroke();
    candle.sx = x;
    candle.flameY = top - 12;
    if (candle.lit) this.drawFlame(ctx, x, top - 7, 1.12, candle.phase, time);
    ctx.restore();
  }

  drawFlame(ctx, x, y, scale, phase, time) {
    const flicker = Math.sin(time * 8.7 + phase) * 1.4 + Math.sin(time * 13.1 + phase * 0.7) * 0.8;
    const lean = this.blowVisual * 9 + flicker;
    const height = (19 + Math.sin(time * 10 + phase) * 2) * scale;
    const width = 8.5 * scale;

    const glow = ctx.createRadialGradient(x, y - height * 0.45, 0, x, y - height * 0.35, 28 * scale);
    glow.addColorStop(0, "rgba(255, 190, 72, 0.43)");
    glow.addColorStop(1, "rgba(255, 190, 72, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y - height * 0.35, 28 * scale, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f36b4d";
    ctx.beginPath();
    ctx.moveTo(x, y + 2);
    ctx.bezierCurveTo(x - width, y - height * 0.34, x - width * 0.45 + lean, y - height * 0.8, x + lean, y - height);
    ctx.bezierCurveTo(x + width * 0.8 + lean * 0.2, y - height * 0.56, x + width, y - height * 0.24, x, y + 2);
    ctx.fill();

    ctx.fillStyle = "#ffd76b";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - width * 0.42, y - height * 0.25, x + lean * 0.46, y - height * 0.62, x + lean * 0.52, y - height * 0.7);
    ctx.bezierCurveTo(x + width * 0.35, y - height * 0.35, x + width * 0.28, y - height * 0.12, x, y);
    ctx.fill();
  }

  drawSmoke(ctx) {
    for (const smoke of this.particles) {
      const progress = smoke.age / smoke.life;
      ctx.fillStyle = `rgba(104, 91, 91, ${0.25 * (1 - progress)})`;
      ctx.beginPath();
      ctx.arc(smoke.x, smoke.y, smoke.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawConfetti(ctx) {
    for (const piece of this.confetti) {
      const fade = clamp((piece.life - piece.age) / 0.5, 0, 1);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rotation);
      ctx.fillStyle = piece.color;
      ctx.fillRect(-piece.size / 2, -piece.size * 0.25, piece.size, piece.size * 0.5);
      ctx.restore();
    }
  }
}

class BlowDetector {
  constructor(onBlow, onTelemetry) {
    this.onBlow = onBlow;
    this.onTelemetry = onTelemetry;
    this.context = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.timeData = null;
    this.frequencyData = null;
    this.baseline = null;
    this.running = false;
    this.raf = 0;
    this.lastSampleAt = 0;
    this.candidateMs = 0;
    this.trackSettings = {};
    this.captureMode = "compatible";
  }

  async open() {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("UNSUPPORTED");
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("UNSUPPORTED");
    if (!this.context || this.context.state === "closed") this.context = new AudioContextClass();
    await this.context.resume();

    const rawAudio = {
      echoCancellation: { exact: false },
      noiseSuppression: { exact: false },
      autoGainControl: { exact: false },
      channelCount: { ideal: 1 }
    };
    const compatibleAudio = {
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: false },
      channelCount: { ideal: 1 }
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: rawAudio, video: false });
      this.captureMode = "raw";
    } catch (error) {
      if (error?.name !== "OverconstrainedError" && error?.name !== "TypeError") throw error;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: compatibleAudio, video: false });
      this.captureMode = "compatible";
    }

    const track = this.stream.getAudioTracks()[0];
    this.trackSettings = track?.getSettings?.() || {};

    this.source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.16;
    this.source.connect(this.analyser);
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  readFeatures() {
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.frequencyData);

    let squareSum = 0;
    let crossings = 0;
    let previous = this.timeData[0];
    for (let index = 0; index < this.timeData.length; index += 1) {
      const sample = this.timeData[index];
      squareSum += sample * sample;
      const current = sample;
      if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
      previous = current;
    }

    const sampleRate = this.context.sampleRate;
    const binHz = sampleRate / this.analyser.fftSize;
    const averageBand = (fromHz, toHz) => {
      const fromBin = clamp(Math.floor(fromHz / binHz), 1, this.frequencyData.length - 1);
      const toBin = clamp(Math.ceil(toHz / binHz), fromBin + 1, this.frequencyData.length);
      let total = 0;
      for (let index = fromBin; index < toBin; index += 1) total += this.frequencyData[index] / 255;
      return total / (toBin - fromBin);
    };

    return {
      rms: Math.sqrt(squareSum / this.timeData.length),
      zcr: crossings / this.timeData.length,
      lowLevel: averageBand(60, 900),
      highLevel: averageBand(1800, 8000)
    };
  }

  async calibrate(onProgress) {
    const samples = [];
    const startedAt = performance.now();
    let latestFeatures = null;

    await new Promise((resolve) => {
      const sample = (now) => {
        const elapsed = now - startedAt;
        onProgress(clamp(elapsed / CALIBRATION_MS, 0, 1));
        latestFeatures = this.readFeatures();
        this.onTelemetry({
          features: latestFeatures,
          frequencyData: this.frequencyData,
          sampleRate: this.context.sampleRate,
          baseline: null,
          candidateMs: 0,
          candidate: false,
          active: false,
          stage: "calibrating"
        });
        if (elapsed > 220) samples.push(latestFeatures);
        if (elapsed < CALIBRATION_MS) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });

    const percentile = (key, fraction) => {
      const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
      return values[Math.min(values.length - 1, Math.floor(values.length * fraction))] || 0;
    };
    const rms = percentile("rms", 0.82);
    this.baseline = {
      rms,
      zcr: percentile("zcr", 0.75),
      lowLevel: percentile("lowLevel", 0.82),
      highLevel: percentile("highLevel", 0.82),
      threshold: clamp(rms * 1.35 + 0.00035, 0.0015, 0.12)
    };
  }

  start() {
    this.running = true;
    this.lastSampleAt = performance.now();
    this.candidateMs = 0;

    const detect = (now) => {
      if (!this.running) return;
      const elapsed = Math.min(50, now - this.lastSampleAt);
      this.lastSampleAt = now;
      const features = this.readFeatures();
      const threshold = this.baseline.threshold;
      const liftDb = (value, reference, floor) => 20 * Math.log10(
        Math.max(value + floor, 0.000001) / Math.max(reference + floor, 0.000001)
      );
      const rmsLiftDb = liftDb(features.rms, this.baseline.rms, 0.00005);
      const lowLiftDb = liftDb(features.lowLevel, this.baseline.lowLevel, 0.003);
      const highLiftDb = liftDb(features.highLevel, this.baseline.highLevel, 0.003);
      const enoughSignal = features.rms >= Math.max(0.0007, this.baseline.rms * 1.08);
      const relativeRise = rmsLiftDb >= 2.2 || features.rms >= threshold;
      const lowWindLike = lowLiftDb >= 1.8;
      const hissLike = highLiftDb >= 1.8
        || features.zcr > Math.max(0.055, this.baseline.zcr * 1.12);
      const candidate = enoughSignal
        && relativeRise
        && (lowWindLike || hissLike || rmsLiftDb >= 4.5);

      if (candidate) this.candidateMs = Math.min(550, this.candidateMs + elapsed);
      else this.candidateMs = Math.max(0, this.candidateMs - elapsed * 1.8);

      const active = this.candidateMs >= BLOW_HOLD_MS;
      this.onTelemetry({
        features,
        frequencyData: this.frequencyData,
        sampleRate: this.context.sampleRate,
        baseline: this.baseline,
        candidateMs: this.candidateMs,
        candidate,
        active,
        rmsLiftDb,
        lowLiftDb,
        highLiftDb,
        stage: "listening"
      });

      if (active) {
        const bandLift = Math.max(0, lowLiftDb, highLiftDb);
        const power = clamp(0.35 + Math.max(0, rmsLiftDb - 2) * 0.16 + bandLift * 0.05, 0.35, 1.8);
        this.onBlow(power, elapsed);
      }
      this.raf = requestAnimationFrame(detect);
    };

    this.raf = requestAnimationFrame(detect);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.source = null;
    this.stream = null;
    this.analyser = null;
  }
}

let appState = "idle";
let operationId = 0;
const diagnostics = new MicrophoneDiagnostics();
const birthdaySong = new BirthdaySong();
const detector = new BlowDetector(
  (power, elapsed) => scene.applyBlow(power, elapsed),
  (telemetry) => diagnostics.update(telemetry)
);
const scene = new BirthdayScene(document.querySelector("#scene"), () => {
  if (appState !== "listening") return;
  appState = "complete";
  birthdaySong.stop();
  detector.stop();
  diagnostics.setStage("已停止");
  setButton("再点一次", 0);
  setStatus("生日快乐！愿望会实现的");
});

function explainMicrophoneError(error) {
  if (error?.message === "UNSUPPORTED") return "当前浏览器不支持麦克风分析，请使用最新版 Chrome 或 Safari。";
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "没有取得麦克风权限。请在浏览器设置中允许麦克风，然后重试。";
  }
  if (error?.name === "NotFoundError") return "没有找到可用的麦克风。";
  if (!window.isSecureContext) return "麦克风需要 HTTPS 安全连接。";
  return "麦克风暂时无法启动，请刷新页面后重试。";
}

async function lightCandles() {
  if (appState === "calibrating") return;
  const id = ++operationId;
  const count = readCount();
  const digitMode = modeInput.checked;

  birthdaySong.stop();
  if (scene.litCount) scene.extinguishAll();
  appState = "calibrating";
  setLocked(true);
  setButton("等待麦克风…", 0);
  setStatus("正在准备麦克风");
  diagnostics.setStage("等待授权");
  noticeElement.hidden = true;

  try {
    await detector.open();
    if (id !== operationId) return;
    diagnostics.setProcessing(detector.trackSettings, detector.captureMode);
    setButton("采样 0%", 0);
    setStatus("请保持自然环境音");
    await detector.calibrate((progress) => {
      if (id !== operationId) return;
      setButton(`采样 ${Math.round(progress * 100)}%`, progress);
    });
    if (id !== operationId) return;

    scene.createCandles(count, digitMode);
    appState = "singing";
    setLocked(false);
    setButton("重新点燃", 0);
    setStatus("生日快乐歌播放中，唱完再吹蜡烛");
    diagnostics.setStage("生日歌播放中");
    const completed = await birthdaySong.play(detector.context);
    if (id !== operationId || !completed || !scene.litCount) return;

    appState = "listening";
    setStatus("唱完啦，现在可以吹蜡烛了");
    diagnostics.setStage("等待吹气");
    detector.start();
  } catch (error) {
    console.error(error);
    birthdaySong.stop();
    detector.stop();
    diagnostics.setStage("不可用");
    appState = "idle";
    setLocked(false);
    setButton("重试", 0);
    setStatus("麦克风未启动");
    showNotice(explainMicrophoneError(error));
  }
}

countInput.addEventListener("change", readCount);
countInput.addEventListener("blur", readCount);
modeInput.addEventListener("change", () => {
  const digitMode = modeInput.checked;
  modeLeft.classList.toggle("is-active", !digitMode);
  modeRight.classList.toggle("is-active", digitMode);
  modeInput.setAttribute("aria-label", digitMode ? "切换到多根蜡烛" : "切换到数字蜡烛");
});
lightButton.addEventListener("click", lightCandles);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && appState === "singing") {
    operationId += 1;
    birthdaySong.stop();
    appState = "song-paused";
    diagnostics.setStage("音乐已停止");
    return;
  }

  if (document.visibilityState === "visible" && appState === "song-paused" && scene.litCount) {
    detector.context.resume().then(() => {
      appState = "listening";
      setStatus("音乐已停止，现在可以吹蜡烛了");
      diagnostics.setStage("等待吹气");
      detector.start();
    }).catch(() => setStatus("麦克风已暂停，请重新点燃"));
    return;
  }

  if (document.visibilityState === "visible" && appState === "listening" && detector.context?.state === "suspended") {
    detector.context.resume().catch(() => {
      setStatus("麦克风已暂停，请重新点燃");
    });
  }
});

window.addEventListener("pagehide", () => birthdaySong.stop());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker registration failed", error));
  });
}
