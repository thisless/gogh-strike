import {
  TILE, T, createOverworld, createDungeon, getTile, isBlocked, moveEntity,
  isBossBarrierOpen, countLitBraziers, UPGRADES, inSwordArc, distance,
} from './grave-world.js';

const $ = (id) => document.getElementById(id);
const canvas = $('world');
const ctx = canvas.getContext('2d', { alpha: false });
const lightCanvas = document.createElement('canvas');
const lctx = lightCanvas.getContext('2d');
const minimap = $('minimap');
const mctx = minimap.getContext('2d');
const bigMap = $('big-map');
const bctx = bigMap.getContext('2d');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 1, b = 0) => b + Math.random() * (a - b);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const hash2 = (x, y) => {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};

let vw = 480, vh = 270, pixelScale = 4;
const camera = { x: 0, y: 0, shake: 0 };
const groundCache = new Map();
const keys = new Set();
const pressed = new Set();

const state = {
  mode: 'title',
  paused: false,
  overlay: null,
  world: null,
  overworld: null,
  dungeon: null,
  player: null,
  boss: null,
  enemies: [],
  projectiles: [],
  particles: [],
  pickups: [],
  floaters: [],
  quest: { stage: 'wake', souls: 0, braziers: 0, bossDown: false, relic: false, talked: false },
  dialogue: null,
  interaction: null,
  interactionProgress: 0,
  time: 0,
  kills: 0,
  startTime: 0,
  shake: 0,
  hitstop: 0,
  toastUntil: 0,
  lastFootstep: 0,
  minimapTick: 0,
  hudTick: 0,
  bossActive: false,
  victoryShown: false,
  fireflies: [],
  lastObjective: '',
};

const PAL = {
  grass: ['#324d38', '#36543c', '#2f4a36'],
  meadow: '#3a5739',
  moss: '#2b4a39',
  path: '#736347',
  pathEdge: '#5b4e38',
  pathPebble: '#8c7a55',
  dirt: '#493b2d',
  dirtDark: '#382c22',
  water: '#1d3d4a',
  waterLight: '#326069',
  stone: '#51525b',
  stoneDark: '#3e3f48',
  wall: '#191c26',
  wallEdge: '#2b3040',
  floor: '#3b3943',
  floorLine: '#32313a',
  bridge: '#5a4630',
  bridgeDark: '#443422',
  ink: '#0a0c14',
  paper: '#e9ddc1',
  gold: '#d9b86b',
  teal: '#7fb8b4',
  blood: '#a45751',
  mossLight: '#91a978',
};

const EPITAPHS = [
  '“She waited for the spring, and it came without her.”',
  '“A kind word, a stubborn mule, a very good pie.”',
  '“He counted the stars and never once got the same number.”',
  '“Beloved. Infuriating. Missed.”',
  '“Here lies the last person to ring the quiet bell.”',
  '“No name. The yew remembers.”',
  '“They planted roses. The roses won.”',
];

let ac = null;
let master = null;
let ambientStarted = false;
let muted = false;
let noiseBuffer = null;

function initAudio() {
  if (ac) return;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain();
    master.gain.value = muted ? 0 : 0.34;
    master.connect(ac.destination);
  } catch {
    ac = null;
  }
}

function getNoise() {
  if (noiseBuffer || !ac) return noiseBuffer;
  noiseBuffer = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function startAmbient() {
  if (!ac || ambientStarted) return;
  ambientStarted = true;
  const bus = ac.createGain();
  bus.gain.value = 0.1;
  bus.connect(master);
  const low = ac.createOscillator();
  low.type = 'sine';
  low.frequency.value = 55;
  const lowGain = ac.createGain();
  lowGain.gain.value = 0.13;
  low.connect(lowGain).connect(bus);
  low.start();
  const fifth = ac.createOscillator();
  fifth.type = 'sine';
  fifth.frequency.value = 82.4;
  const fifthGain = ac.createGain();
  fifthGain.gain.value = 0.055;
  fifth.connect(fifthGain).connect(bus);
  fifth.start();
  const wind = ac.createBufferSource();
  wind.buffer = getNoise();
  wind.loop = true;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 420;
  filter.Q.value = 0.6;
  const windGain = ac.createGain();
  windGain.gain.value = 0.075;
  wind.connect(filter).connect(windGain).connect(bus);
  wind.start();
  const lfo = ac.createOscillator();
  lfo.frequency.value = 0.06;
  const lfoGain = ac.createGain();
  lfoGain.gain.value = 140;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();
}

function tone(freq, dur, type = 'sine', vol = 0.2, slide = 0, delay = 0) {
  if (!ac || muted) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function noise(dur, vol = 0.2, type = 'lowpass', freq = 900, delay = 0) {
  if (!ac || muted) return;
  const t = ac.currentTime + delay;
  const source = ac.createBufferSource();
  source.buffer = getNoise();
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  filter.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.35), t + dur);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  source.connect(filter).connect(gain).connect(master);
  source.start(t);
  source.stop(t + dur + 0.03);
}

function sfx(name) {
  if (!ac || muted) return;
  if (name === 'step') noise(0.06, 0.05, 'lowpass', 280);
  else if (name === 'slash') {
    noise(0.14, 0.16, 'highpass', 1500);
    tone(460, 0.12, 'triangle', 0.07, -260);
  } else if (name === 'hit') {
    noise(0.09, 0.2, 'bandpass', 700);
    tone(95, 0.12, 'square', 0.1, -40);
  } else if (name === 'hurt') {
    tone(190, 0.26, 'sawtooth', 0.15, -120);
    noise(0.16, 0.12, 'lowpass', 500);
  } else if (name === 'coin') {
    tone(880, 0.07, 'sine', 0.11);
    tone(1320, 0.11, 'sine', 0.08, 0, 0.06);
  } else if (name === 'dig') {
    noise(0.2, 0.18, 'lowpass', 520);
    tone(120, 0.12, 'triangle', 0.05, -30);
  } else if (name === 'bury') {
    tone(220, 0.5, 'sine', 0.08);
    tone(330, 0.55, 'sine', 0.06, 0, 0.08);
    tone(440, 0.6, 'sine', 0.04, 0, 0.16);
  } else if (name === 'talk') {
    tone(320, 0.04, 'square', 0.035);
  } else if (name === 'brazier') {
    noise(0.5, 0.22, 'lowpass', 900);
    tone(170, 0.45, 'sawtooth', 0.08, -110);
  } else if (name === 'boss') {
    tone(72, 0.9, 'sawtooth', 0.18, -34);
    noise(0.7, 0.2, 'lowpass', 340);
  } else if (name === 'victory') {
    [392, 494, 587, 784].forEach((f, i) => tone(f, 0.55, 'sine', 0.1, 0, i * 0.13));
  } else if (name === 'click') {
    tone(560, 0.04, 'sine', 0.06);
  } else if (name === 'open') {
    tone(260, 0.1, 'triangle', 0.08);
    tone(390, 0.16, 'triangle', 0.07, 0, 0.08);
  } else if (name === 'heal') {
    tone(440, 0.3, 'sine', 0.08);
    tone(660, 0.4, 'sine', 0.05, 0, 0.1);
  }
}

function setMuted(value) {
  muted = value;
  if (master) master.gain.value = muted ? 0 : 0.34;
  $('sound-toggle').classList.toggle('muted', muted);
}

function resize() {
  pixelScale = Math.max(2, Math.min(6, Math.round(Math.min(innerWidth / 480, innerHeight / 270))));
  vw = Math.ceil(innerWidth / pixelScale);
  vh = Math.ceil(innerHeight / pixelScale);
  canvas.width = vw;
  canvas.height = vh;
  lightCanvas.width = vw;
  lightCanvas.height = vh;
  ctx.imageSmoothingEnabled = false;
  lctx.imageSmoothingEnabled = false;
  if (state.world) snapCamera();
}

function fillRect(x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h));
}

function fillEllipse(x, y, rx, ry, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(Math.round(x), Math.round(y), Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

function buildGround(world) {
  const c = document.createElement('canvas');
  c.width = world.w * TILE;
  c.height = world.h * TILE;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) drawGroundTile(g, world, x, y);
  }
  groundCache.set(world.id, c);
  return c;
}

function drawGroundTile(g, world, tx, ty) {
  const tile = getTile(world, tx, ty);
  const x = tx * TILE, y = ty * TILE;
  const h = hash2(tx, ty);
  if (tile === T.GRASS || tile === T.MEADOW || tile === T.MOSS) {
    const base = tile === T.MEADOW ? PAL.meadow : tile === T.MOSS ? PAL.moss : PAL.grass[Math.floor(h * 3)];
    g.fillStyle = base;
    g.fillRect(x, y, TILE, TILE);
    const blades = 2 + Math.floor(h * 3);
    for (let i = 0; i < blades; i++) {
      const bx = x + 2 + Math.floor(hash2(tx + i * 7, ty + i * 3) * 12);
      const by = y + 3 + Math.floor(hash2(tx + i * 3, ty + i * 11) * 11);
      g.fillStyle = i % 2 ? '#416044' : '#2a4330';
      g.fillRect(bx, by, 1, 2);
      if (i === 0 && h > 0.93) {
        g.fillStyle = h > 0.965 ? '#c9b96f' : '#9a7f9a';
        g.fillRect(bx, by - 1, 1, 1);
      }
    }
  } else if (tile === T.PATH) {
    g.fillStyle = PAL.path;
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = '#66583f';
    for (let i = 0; i < 3; i++) {
      const sx = x + Math.floor(hash2(tx + i * 5, ty + i * 9) * 14);
      const sy = y + Math.floor(hash2(tx + i * 9, ty + i * 2) * 14);
      g.fillRect(sx, sy, 1, 1);
    }
    const around = [
      [0, -1, 0, 0, TILE, 1], [0, 1, 0, TILE - 1, TILE, 1],
      [-1, 0, 0, 0, 1, TILE], [1, 0, TILE - 1, 0, 1, TILE],
    ];
    for (const [dx, dy, ex, ey, ew, eh] of around) {
      const n = getTile(world, tx + dx, ty + dy);
      if (n !== T.PATH && n !== T.DIRT && n !== T.BRIDGE && n !== T.STONE && n !== T.FLOOR) {
        g.fillStyle = PAL.pathEdge;
        g.fillRect(x + ex, y + ey, ew, eh);
      }
    }
  } else if (tile === T.DIRT) {
    g.fillStyle = PAL.dirt;
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = PAL.dirtDark;
    for (let i = 0; i < 4; i++) {
      g.fillRect(x + Math.floor(hash2(tx + i, ty + i * 3) * 14), y + Math.floor(hash2(tx + i * 5, ty + i) * 14), 2, 1);
    }
  } else if (tile === T.WATER) {
    g.fillStyle = PAL.water;
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = PAL.waterLight;
    const wy = y + 4 + Math.floor(h * 8);
    g.fillRect(x + 3, wy, 5, 1);
    g.fillRect(x + 10, wy + 3, 3, 1);
  } else if (tile === T.STONE) {
    g.fillStyle = PAL.stone;
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = PAL.stoneDark;
    g.fillRect(x, y + 7, TILE, 1);
    g.fillRect(x + 7, y, 1, 7);
    g.fillRect(x + 3, y + 8, 1, 8);
    g.fillRect(x + 12, y + 8, 1, 8);
  } else if (tile === T.WALL) {
    g.fillStyle = PAL.wall;
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = PAL.wallEdge;
    g.fillRect(x, y, TILE, 1);
    g.fillRect(x, y + 8, TILE, 1);
    g.fillRect(x + 5, y + 1, 1, 7);
    g.fillRect(x + 12, y + 9, 1, 7);
  } else if (tile === T.FLOOR) {
    g.fillStyle = PAL.floor;
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = PAL.floorLine;
    g.fillRect(x, y, TILE, 1);
    g.fillRect(x, y, 1, TILE);
    g.fillRect(x + 8, y + 8, 1, 8);
  } else if (tile === T.BRIDGE) {
    g.fillStyle = PAL.bridge;
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = PAL.bridgeDark;
    g.fillRect(x, y + 3, TILE, 1);
    g.fillRect(x, y + 9, TILE, 1);
    g.fillRect(x + 4, y, 1, TILE);
    g.fillRect(x + 12, y, 1, TILE);
  } else {
    g.fillStyle = '#070910';
    g.fillRect(x, y, TILE, TILE);
  }
}

function snapCamera() {
  const world = state.world;
  if (!world) return;
  const target = state.mode === 'title' ? world.titleCamera : state.player;
  camera.x = clamp(target.x - vw / 2, 0, Math.max(0, world.w * TILE - vw));
  camera.y = clamp(target.y - vh / 2, 0, Math.max(0, world.h * TILE - vh));
  camera.shake = 0;
}

function updateCamera(dt) {
  const world = state.world;
  if (!world) return;
  const target = state.mode === 'title' ? world.titleCamera : state.player;
  const tx = clamp(target.x - vw / 2, 0, Math.max(0, world.w * TILE - vw));
  const ty = clamp(target.y - vh / 2, 0, Math.max(0, world.h * TILE - vh));
  const speed = state.mode === 'title' ? 1 : clamp(dt * 5.5, 0, 1);
  camera.x = lerp(camera.x, tx, speed);
  camera.y = lerp(camera.y, ty, speed);
  camera.shake = Math.max(0, camera.shake - dt * 22);
}

function drawDecor(item) {
  const { x, y, type } = item;
  const t = state.time;
  if (type === 'tuft') {
    const sway = Math.sin(t * 1.4 + x * 0.12) * 1;
    ctx.fillStyle = '#29442f';
    ctx.fillRect(Math.round(x), Math.round(y) - 4, 1, 4);
    ctx.fillRect(Math.round(x) - 2 + Math.round(sway), Math.round(y) - 3, 1, 3);
    ctx.fillRect(Math.round(x) + 2, Math.round(y) - 5, 1, 5);
    ctx.fillStyle = '#4c6b4b';
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 5, 1, 2);
  } else if (type === 'flowers') {
    ctx.fillStyle = '#355238';
    ctx.fillRect(Math.round(x), Math.round(y) - 3, 1, 3);
    ctx.fillStyle = item.color || '#b78aa6';
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 5, 2, 2);
    ctx.fillStyle = '#e2d69b';
    ctx.fillRect(Math.round(x), Math.round(y) - 4, 1, 1);
  } else if (type === 'bones') {
    ctx.fillStyle = '#b9b39d';
    ctx.fillRect(Math.round(x), Math.round(y) - 1, 4, 1);
    ctx.fillRect(Math.round(x) + 3, Math.round(y) - 2, 2, 2);
    ctx.fillStyle = '#8c8775';
    ctx.fillRect(Math.round(x) + 1, Math.round(y), 1, 1);
  } else if (type === 'rubble') {
    ctx.fillStyle = '#55565f';
    ctx.fillRect(Math.round(x), Math.round(y) - 2, 3, 2);
    ctx.fillRect(Math.round(x) + 4, Math.round(y) - 1, 2, 1);
    ctx.fillStyle = '#3b3c44';
    ctx.fillRect(Math.round(x) + 1, Math.round(y) - 1, 1, 1);
  } else if (type === 'shovel') {
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(-0.55);
    ctx.fillStyle = '#6e5130';
    ctx.fillRect(-1, -9, 2, 10);
    ctx.fillStyle = '#9a9a9d';
    ctx.fillRect(-3, 1, 6, 5);
    ctx.restore();
  }
}

function drawObject(object) {
  if (object.type === 'tree') drawTree(object);
  else if (object.type === 'grave') drawGrave(object);
  else if (object.type === 'church') drawChurch(object);
  else if (object.type === 'house') drawHouse(object);
  else if (object.type === 'shrine') drawShrine(object);
  else if (object.type === 'lantern') drawLantern(object);
  else if (object.type === 'fence') drawFence(object);
  else if (object.type === 'bench') drawBench(object);
  else if (object.type === 'sign') drawSign(object);
  else if (object.type === 'chest') drawChest(object);
  else if (object.type === 'rock') drawRock(object);
  else if (object.type === 'well') drawWell(object);
  else if (object.type === 'market') drawMarket(object);
  else if (object.type === 'statue') drawStatue(object);
  else if (object.type === 'column') drawColumn(object);
  else if (object.type === 'ossuary') drawOssuary(object);
  else if (object.type === 'bones-pile') drawBonesPile(object);
  else if (object.type === 'brazier') drawBrazier(object);
  else if (object.type === 'barrier') drawBarrier(object);
}

function drawTree(o) {
  const { x, y } = o;
  const sway = Math.sin(state.time * 1.1 + x * 0.07) * 1.4;
  fillEllipse(x + 2, y + 1, 11, 3, '#080c13aa');
  ctx.fillStyle = '#3a2a1c';
  ctx.fillRect(Math.round(x) - 2, Math.round(y) - 12, 4, 12);
  ctx.fillStyle = '#523b26';
  ctx.fillRect(Math.round(x) - 1, Math.round(y) - 12, 1, 9);
  ctx.fillStyle = '#203b2b';
  ctx.beginPath();
  ctx.ellipse(Math.round(x) + sway, Math.round(y) - 21, 12, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(Math.round(x) - 7 + sway, Math.round(y) - 16, 8, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(Math.round(x) + 8 + sway, Math.round(y) - 17, 8, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2e5238';
  ctx.beginPath();
  ctx.ellipse(Math.round(x) - 3 + sway, Math.round(y) - 25, 7, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3d6242';
  ctx.fillRect(Math.round(x) - 6 + Math.round(sway), Math.round(y) - 28, 4, 2);
  ctx.fillRect(Math.round(x) + 3 + Math.round(sway), Math.round(y) - 23, 3, 2);
  ctx.fillStyle = '#4d7350';
  ctx.fillRect(Math.round(x) - 2 + Math.round(sway), Math.round(y) - 30, 2, 1);
}

function drawGrave(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 8, 2.5, '#090d13a8');
  if (o.state === 'empty') {
    ctx.fillStyle = '#34291f';
    ctx.fillRect(Math.round(x) - 7, Math.round(y) - 5, 14, 5);
    ctx.fillStyle = '#120f0d';
    ctx.fillRect(Math.round(x) - 5, Math.round(y) - 5, 10, 3);
    ctx.fillStyle = '#6d5434';
    ctx.fillRect(Math.round(x) + 4, Math.round(y) - 15, 2, 13);
    ctx.fillStyle = '#9a7a4a';
    ctx.fillRect(Math.round(x) + 3, Math.round(y) - 16, 4, 2);
    return;
  }
  if (o.state === 'restless') {
    ctx.fillStyle = '#4a3928';
    ctx.beginPath();
    ctx.ellipse(Math.round(x), Math.round(y) - 3, 8, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#604a31';
    ctx.fillRect(Math.round(x) - 4, Math.round(y) - 6, 4, 2);
    ctx.fillStyle = '#7c7a74';
    ctx.fillRect(Math.round(x) - 5, Math.round(y) - 12, 3, 8);
    const pulse = 0.5 + 0.5 * Math.sin(state.time * 2.2 + x);
    ctx.globalAlpha = 0.5 + pulse * 0.45;
    ctx.fillStyle = '#e7c978';
    ctx.fillRect(Math.round(x) + 2, Math.round(y) - 20 - pulse * 2, 2, 2);
    ctx.fillRect(Math.round(x) + 1, Math.round(y) - 17, 4, 1);
    ctx.globalAlpha = 1;
    return;
  }
  if (o.state === 'dug') {
    ctx.fillStyle = '#5b4730';
    ctx.fillRect(Math.round(x) - 7, Math.round(y) - 4, 14, 4);
    ctx.fillStyle = '#14100d';
    ctx.fillRect(Math.round(x) - 5, Math.round(y) - 4, 10, 2);
    ctx.fillStyle = '#b8b199';
    ctx.fillRect(Math.round(x) - 2, Math.round(y) - 3, 4, 1);
    return;
  }
  const stone = o.state === 'resting' ? '#8e918b' : '#6d706f';
  const light = o.state === 'resting' ? '#b8bbb0' : '#858986';
  if (o.kind === 'cross') {
    ctx.fillStyle = '#3b3b40';
    ctx.fillRect(Math.round(x) - 5, Math.round(y) - 4, 10, 4);
    ctx.fillStyle = stone;
    ctx.fillRect(Math.round(x) - 2, Math.round(y) - 17, 4, 14);
    ctx.fillRect(Math.round(x) - 6, Math.round(y) - 13, 12, 4);
    ctx.fillStyle = light;
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 16, 1, 4);
  } else if (o.kind === 'cracked') {
    ctx.fillStyle = '#3b3b40';
    ctx.fillRect(Math.round(x) - 6, Math.round(y) - 4, 12, 4);
    ctx.fillStyle = stone;
    ctx.fillRect(Math.round(x) - 5, Math.round(y) - 14, 10, 11);
    ctx.fillRect(Math.round(x) - 4, Math.round(y) - 17, 8, 3);
    ctx.fillStyle = '#3d3e42';
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 13, 1, 4);
    ctx.fillRect(Math.round(x) - 2, Math.round(y) - 9, 3, 1);
  } else {
    ctx.fillStyle = '#3b3b40';
    ctx.fillRect(Math.round(x) - 6, Math.round(y) - 4, 12, 4);
    ctx.fillStyle = stone;
    ctx.fillRect(Math.round(x) - 5, Math.round(y) - 13, 10, 10);
    ctx.fillRect(Math.round(x) - 4, Math.round(y) - 16, 8, 4);
    ctx.fillRect(Math.round(x) - 2, Math.round(y) - 17, 4, 1);
    ctx.fillStyle = light;
    ctx.fillRect(Math.round(x) - 3, Math.round(y) - 12, 1, 3);
    ctx.fillRect(Math.round(x) + 2, Math.round(y) - 14, 1, 2);
    ctx.fillStyle = '#5b5d5c';
    ctx.fillRect(Math.round(x) - 2, Math.round(y) - 9, 4, 1);
  }
  ctx.fillStyle = '#48603f';
  ctx.fillRect(Math.round(x) - 6, Math.round(y) - 7, 2, 2);
  ctx.fillRect(Math.round(x) + 4, Math.round(y) - 10, 1, 2);
  if (o.flowers) {
    ctx.fillStyle = '#b98aa2';
    ctx.fillRect(Math.round(x) - 8, Math.round(y) - 3, 2, 1);
    ctx.fillStyle = '#c8c183';
    ctx.fillRect(Math.round(x) + 7, Math.round(y) - 4, 1, 1);
  }
  if (o.state === 'resting') {
    ctx.fillStyle = '#e9d28d';
    ctx.fillRect(Math.round(x) + 7, Math.round(y) - 8, 2, 4);
    ctx.fillStyle = '#f6e7b0';
    ctx.fillRect(Math.round(x) + 7, Math.round(y) - 9, 2, 1);
  }
}

function drawChurch(o) {
  const { x, y } = o;
  const left = x - o.w / 2, right = x + o.w / 2, top = y - o.h;
  fillEllipse(x, y - 1, o.w * 0.46, 10, '#070b12a8');
  ctx.fillStyle = '#3d3e46';
  ctx.fillRect(Math.round(left + 18), Math.round(y - 10), Math.round(o.w - 36), 10);
  ctx.fillStyle = '#4a4b54';
  ctx.fillRect(Math.round(left + 14), Math.round(top + 62), Math.round(o.w - 28), Math.round(o.h - 70));
  ctx.fillStyle = '#55565e';
  for (let i = 0; i < 9; i++) {
    ctx.fillRect(Math.round(left + 16 + i * 22), Math.round(top + 70 + (i % 2) * 17), 14, 1);
  }
  ctx.fillStyle = '#34353d';
  ctx.fillRect(Math.round(left + 20), Math.round(top + 62), 5, Math.round(o.h - 72));
  ctx.fillRect(Math.round(right - 25), Math.round(top + 62), 5, Math.round(o.h - 72));
  ctx.fillStyle = '#292f3d';
  ctx.beginPath();
  ctx.moveTo(left + 4, top + 66);
  ctx.lineTo(x, top + 9);
  ctx.lineTo(right - 4, top + 66);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#363e50';
  ctx.beginPath();
  ctx.moveTo(left + 15, top + 62);
  ctx.lineTo(x, top + 17);
  ctx.lineTo(right - 15, top + 62);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#202634';
  for (let i = 0; i < 7; i++) {
    const t = i / 7;
    const yy = top + 24 + t * 38;
    const half = 4 + t * 92;
    ctx.fillRect(Math.round(x - half), Math.round(yy), Math.round(half * 2), 1);
  }
  ctx.fillStyle = '#4c5365';
  ctx.fillRect(Math.round(x - 1), Math.round(top + 12), 2, 52);
  ctx.fillStyle = '#2b3140';
  ctx.beginPath();
  ctx.moveTo(x - 25, top + 70);
  ctx.lineTo(x, top + 18);
  ctx.lineTo(x + 25, top + 70);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#1d2230';
  ctx.fillRect(Math.round(x - 15), Math.round(top + 62), 30, 12);
  ctx.fillStyle = '#d9b86b';
  ctx.fillRect(Math.round(x - 1), Math.round(top + 4), 2, 10);
  ctx.fillRect(Math.round(x - 5), Math.round(top + 7), 10, 2);
  const doorTop = y - 38;
  ctx.fillStyle = '#2d231b';
  ctx.fillRect(Math.round(x - 13), Math.round(doorTop), 26, 36);
  ctx.beginPath();
  ctx.fillStyle = '#2d231b';
  ctx.arc(Math.round(x), Math.round(doorTop), 13, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#493626';
  ctx.fillRect(Math.round(x - 10), Math.round(doorTop + 4), 20, 32);
  ctx.fillStyle = '#6a4d31';
  ctx.fillRect(Math.round(x - 1), Math.round(doorTop + 5), 2, 31);
  ctx.fillStyle = '#d9b86b';
  ctx.fillRect(Math.round(x - 5), Math.round(doorTop + 20), 2, 2);
  const glass = ctx.createLinearGradient(x, top + 78, x, top + 101);
  glass.addColorStop(0, '#e3b86e');
  glass.addColorStop(0.55, '#9d6f57');
  glass.addColorStop(1, '#5d5367');
  ctx.fillStyle = glass;
  ctx.fillRect(Math.round(x - 8), Math.round(top + 78), 16, 21);
  ctx.fillStyle = '#2d2f3b';
  ctx.fillRect(Math.round(x - 9), Math.round(top + 78), 18, 2);
  ctx.fillRect(Math.round(x - 1), Math.round(top + 79), 2, 20);
  ctx.fillRect(Math.round(x - 8), Math.round(top + 88), 16, 1);
  ctx.fillStyle = '#e6c57e';
  ctx.fillRect(Math.round(x - 17), Math.round(y - 44), 3, 8);
  ctx.fillRect(Math.round(x + 14), Math.round(y - 44), 3, 8);
  ctx.fillStyle = '#263a2e';
  ctx.fillRect(Math.round(x - 24), Math.round(y - 15), 5, 8);
  ctx.fillRect(Math.round(x + 19), Math.round(y - 15), 5, 8);
}

function drawHouse(o) {
  const { x, y } = o;
  const w = o.w, h = o.h;
  const left = x - w / 2, top = y - h;
  fillEllipse(x, y - 1, w * 0.44, 6, '#070b12a8');
  ctx.fillStyle = ['#4c4641', '#51483e', '#45454b'][o.variant % 3];
  ctx.fillRect(Math.round(left + 5), Math.round(top + 24), Math.round(w - 10), Math.round(h - 30));
  ctx.fillStyle = ['#2b303a', '#3a2d2b', '#333942'][o.variant % 3];
  ctx.beginPath();
  ctx.moveTo(left + 1, top + 28);
  ctx.lineTo(x, top + 2);
  ctx.lineTo(left + w - 1, top + 28);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#222733';
  ctx.fillRect(Math.round(left + 4), Math.round(top + 26), Math.round(w - 8), 2);
  ctx.fillStyle = '#5b4a35';
  ctx.fillRect(Math.round(left + 12), Math.round(y - 22), 10, 20);
  ctx.fillStyle = '#d9b86b';
  ctx.fillRect(Math.round(left + w - 24), Math.round(top + 32), 9, 8);
  ctx.fillStyle = '#e8ce8c';
  ctx.fillRect(Math.round(left + w - 22), Math.round(top + 34), 3, 3);
  ctx.fillStyle = '#35363d';
  ctx.fillRect(Math.round(left + w - 16), Math.round(top + 6), 5, 13);
  ctx.fillStyle = '#252832';
  ctx.fillRect(Math.round(left + 9), Math.round(top + 35), 8, 8);
  ctx.fillStyle = '#6c5a3f';
  ctx.fillRect(Math.round(left + 13), Math.round(top + 35), 1, 8);
}

function drawShrine(o) {
  const { x, y } = o;
  const t = state.time;
  fillEllipse(x, y + 1, 15, 4, '#070b12a8');
  ctx.fillStyle = '#3e4c45';
  ctx.fillRect(Math.round(x - 14), Math.round(y - 7), 28, 7);
  ctx.fillStyle = '#53635a';
  ctx.fillRect(Math.round(x - 10), Math.round(y - 10), 20, 4);
  ctx.fillStyle = '#4b5a53';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 39), 14, 30);
  ctx.fillRect(Math.round(x - 9), Math.round(y - 41), 18, 4);
  ctx.fillStyle = '#5d7066';
  ctx.fillRect(Math.round(x - 5), Math.round(y - 37), 1, 26);
  const glow = 0.55 + Math.sin(t * 1.8) * 0.25;
  ctx.globalAlpha = glow;
  ctx.fillStyle = '#8fd0c6';
  ctx.fillRect(Math.round(x - 2), Math.round(y - 31), 4, 2);
  ctx.fillRect(Math.round(x - 1), Math.round(y - 34), 2, 10);
  ctx.globalAlpha = 1;
  const float = Math.sin(t * 1.2) * 1.5;
  ctx.fillStyle = '#7fae9e';
  ctx.fillRect(Math.round(x + 13), Math.round(y - 26 + float), 3, 3);
  ctx.fillRect(Math.round(x - 16), Math.round(y - 20 - float), 2, 2);
  ctx.fillStyle = '#324139';
  ctx.fillRect(Math.round(x - 12), Math.round(y - 3), 24, 2);
}

function drawLantern(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 5, 2, '#070b12a8');
  ctx.fillStyle = '#2e2b25';
  ctx.fillRect(Math.round(x - 1), Math.round(y - 23), 2, 23);
  ctx.fillRect(Math.round(x - 4), Math.round(y - 22), 8, 2);
  ctx.fillStyle = '#e6c57e';
  ctx.fillRect(Math.round(x - 3), Math.round(y - 20), 6, 7);
  ctx.fillStyle = '#fff0b9';
  ctx.fillRect(Math.round(x - 1), Math.round(y - 19), 2, 3);
  ctx.fillStyle = '#3a3329';
  ctx.fillRect(Math.round(x - 4), Math.round(y - 21), 8, 1);
  ctx.fillRect(Math.round(x - 4), Math.round(y - 12), 8, 1);
}

function drawFence(o) {
  const { x, y } = o;
  ctx.fillStyle = '#30333a';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 11), 2, 11);
  ctx.fillRect(Math.round(x + 5), Math.round(y - 11), 2, 11);
  ctx.fillStyle = '#41454d';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 8), 14, 1);
  ctx.fillRect(Math.round(x - 7), Math.round(y - 4), 14, 1);
  ctx.fillStyle = '#22252b';
  ctx.fillRect(Math.round(x - 6), Math.round(y - 12), 1, 2);
  ctx.fillRect(Math.round(x + 6), Math.round(y - 12), 1, 2);
}

function drawBench(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 10, 2, '#070b12a8');
  ctx.fillStyle = '#4e3a26';
  ctx.fillRect(Math.round(x - 9), Math.round(y - 9), 18, 3);
  ctx.fillRect(Math.round(x - 9), Math.round(y - 5), 18, 2);
  ctx.fillStyle = '#332619';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 4), 2, 4);
  ctx.fillRect(Math.round(x + 5), Math.round(y - 4), 2, 4);
}

function drawSign(o) {
  const { x, y } = o;
  ctx.fillStyle = '#3d2e1f';
  ctx.fillRect(Math.round(x - 1), Math.round(y - 14), 2, 14);
  ctx.fillStyle = '#6b5334';
  ctx.fillRect(Math.round(x - 8), Math.round(y - 19), 16, 7);
  ctx.fillStyle = '#8f7147';
  ctx.fillRect(Math.round(x - 6), Math.round(y - 17), 11, 1);
  ctx.fillRect(Math.round(x - 6), Math.round(y - 15), 7, 1);
}

function drawChest(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 9, 2, '#070b12a8');
  ctx.fillStyle = '#4b3622';
  ctx.fillRect(Math.round(x - 8), Math.round(y - 10), 16, 10);
  ctx.fillStyle = '#6b4c2c';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 9), 14, 4);
  ctx.fillStyle = '#b7934c';
  ctx.fillRect(Math.round(x - 8), Math.round(y - 4), 16, 1);
  ctx.fillRect(Math.round(x - 2), Math.round(y - 10), 4, 10);
  if (o.opened) {
    ctx.fillStyle = '#3a2919';
    ctx.fillRect(Math.round(x - 8), Math.round(y - 13), 16, 3);
    ctx.fillStyle = '#1a120b';
    ctx.fillRect(Math.round(x - 6), Math.round(y - 8), 12, 2);
  } else {
    ctx.fillStyle = '#d9b86b';
    ctx.fillRect(Math.round(x - 1), Math.round(y - 7), 2, 2);
  }
}

function drawRock(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 9, 2, '#070b12a8');
  ctx.fillStyle = o.mined ? '#4a4b50' : '#5b5d60';
  ctx.beginPath();
  ctx.moveTo(x - 8, y);
  ctx.lineTo(x - 7, y - 6);
  ctx.lineTo(x - 2, y - 10);
  ctx.lineTo(x + 5, y - 8);
  ctx.lineTo(x + 9, y - 2);
  ctx.lineTo(x + 7, y);
  ctx.closePath();
  ctx.fill();
  if (!o.mined) {
    ctx.fillStyle = '#76797a';
    ctx.fillRect(Math.round(x - 4), Math.round(y - 8), 4, 2);
    ctx.fillStyle = '#3c3d42';
    ctx.fillRect(Math.round(x + 1), Math.round(y - 4), 4, 2);
  } else {
    ctx.fillStyle = '#2d2e33';
    ctx.fillRect(Math.round(x - 5), Math.round(y - 3), 10, 2);
  }
}

function drawWell(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 13, 3, '#070b12a8');
  ctx.fillStyle = '#565860';
  ctx.fillRect(Math.round(x - 11), Math.round(y - 10), 22, 10);
  ctx.fillStyle = '#20232b';
  ctx.fillRect(Math.round(x - 8), Math.round(y - 9), 16, 5);
  ctx.fillStyle = '#35373e';
  ctx.fillRect(Math.round(x - 10), Math.round(y - 13), 20, 3);
  ctx.fillStyle = '#3f2e1f';
  ctx.fillRect(Math.round(x - 1), Math.round(y - 26), 2, 13);
  ctx.fillStyle = '#2a303b';
  ctx.beginPath();
  ctx.moveTo(x - 12, y - 24);
  ctx.lineTo(x, y - 33);
  ctx.lineTo(x + 12, y - 24);
  ctx.closePath();
  ctx.fill();
}

function drawMarket(o) {
  const { x, y } = o;
  ctx.fillStyle = '#3b2d21';
  ctx.fillRect(Math.round(x - 12), Math.round(y - 9), 24, 9);
  ctx.fillStyle = '#6d5033';
  ctx.fillRect(Math.round(x - 12), Math.round(y - 10), 24, 2);
  ctx.fillStyle = '#71443e';
  ctx.beginPath();
  ctx.moveTo(x - 16, y - 24);
  ctx.lineTo(x + 16, y - 24);
  ctx.lineTo(x + 12, y - 15);
  ctx.lineTo(x - 12, y - 15);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#d9c58c';
  for (let i = 0; i < 4; i++) ctx.fillRect(Math.round(x - 13 + i * 8), Math.round(y - 23), 3, 8);
  ctx.fillStyle = '#b78a54';
  ctx.fillRect(Math.round(x - 8), Math.round(y - 13), 5, 3);
  ctx.fillRect(Math.round(x + 2), Math.round(y - 14), 4, 4);
}

function drawStatue(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 10, 2, '#070b12a8');
  ctx.fillStyle = '#46474f';
  ctx.fillRect(Math.round(x - 9), Math.round(y - 6), 18, 6);
  ctx.fillStyle = '#5b5c64';
  ctx.fillRect(Math.round(x - 6), Math.round(y - 9), 12, 3);
  ctx.fillStyle = '#76767d';
  ctx.fillRect(Math.round(x - 3), Math.round(y - 26), 6, 18);
  ctx.beginPath();
  ctx.arc(Math.round(x), Math.round(y - 29), 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5d5d64';
  ctx.fillRect(Math.round(x - 9), Math.round(y - 22), 6, 2);
  ctx.fillRect(Math.round(x + 3), Math.round(y - 22), 6, 2);
  ctx.fillStyle = '#455d4a';
  ctx.fillRect(Math.round(x - 2), Math.round(y - 14), 2, 4);
}

function drawColumn(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 9, 2, '#070b12a8');
  ctx.fillStyle = '#4c4d55';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 6), 14, 6);
  ctx.fillRect(Math.round(x - 5), Math.round(y - 28), 10, 22);
  ctx.fillRect(Math.round(x - 8), Math.round(y - 31), 16, 3);
  ctx.fillStyle = '#5d5f68';
  ctx.fillRect(Math.round(x - 4), Math.round(y - 27), 2, 19);
  ctx.fillStyle = '#393a42';
  ctx.fillRect(Math.round(x + 2), Math.round(y - 25), 1, 12);
}

function drawOssuary(o) {
  const { x, y } = o;
  const w = o.small ? 22 : 30;
  fillEllipse(x, y + 1, w * 0.55, 3, '#070b12a8');
  ctx.fillStyle = '#4b4c55';
  ctx.fillRect(Math.round(x - w / 2), Math.round(y - 12), w, 12);
  ctx.fillStyle = '#5d5e67';
  ctx.fillRect(Math.round(x - w / 2 - 2), Math.round(y - 15), w + 4, 4);
  ctx.fillStyle = '#34353d';
  ctx.fillRect(Math.round(x - w / 2 + 3), Math.round(y - 8), w - 6, 1);
  ctx.fillStyle = '#8b8b86';
  ctx.fillRect(Math.round(x - 2), Math.round(y - 11), 4, 2);
  ctx.fillRect(Math.round(x - 1), Math.round(y - 13), 2, 6);
}

function drawBonesPile(o) {
  const { x, y } = o;
  ctx.fillStyle = '#b7b19b';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 3), 9, 1);
  ctx.fillRect(Math.round(x + 1), Math.round(y - 5), 6, 1);
  ctx.fillRect(Math.round(x - 3), Math.round(y - 6), 2, 3);
  ctx.fillStyle = '#8f8a78';
  ctx.fillRect(Math.round(x - 5), Math.round(y - 4), 1, 1);
  ctx.fillRect(Math.round(x + 4), Math.round(y - 2), 3, 1);
}

function drawBrazier(o) {
  const { x, y } = o;
  fillEllipse(x, y + 1, 7, 2, '#070b12a8');
  ctx.fillStyle = '#34353d';
  ctx.fillRect(Math.round(x - 1), Math.round(y - 6), 2, 6);
  ctx.fillStyle = '#4d4e57';
  ctx.fillRect(Math.round(x - 7), Math.round(y - 11), 14, 5);
  ctx.fillRect(Math.round(x - 8), Math.round(y - 13), 16, 2);
  if (o.lit) {
    const t = state.time;
    const flick = Math.sin(t * 7 + x) * 1;
    ctx.fillStyle = '#e08a4f';
    ctx.fillRect(Math.round(x - 4), Math.round(y - 19 + flick), 8, 6);
    ctx.fillStyle = '#f2c76f';
    ctx.fillRect(Math.round(x - 2), Math.round(y - 23 + flick), 4, 8);
    ctx.fillStyle = '#fff0b0';
    ctx.fillRect(Math.round(x - 1), Math.round(y - 22 + flick), 2, 4);
  } else {
    ctx.fillStyle = '#25262c';
    ctx.fillRect(Math.round(x - 4), Math.round(y - 14), 8, 2);
  }
}

function drawBarrier(o) {
  if (isBossBarrierOpen(state.world)) return;
  const { x, y } = o;
  const t = state.time;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    ctx.strokeStyle = i % 2 ? '#7f5f9c88' : '#6ea6a388';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let yy = -26; yy <= 0; yy += 4) {
      const xx = Math.sin(t * 2 + yy * 0.4 + i * 1.6) * 2;
      if (yy === -26) ctx.moveTo(x + xx, y + yy);
      else ctx.lineTo(x + xx, y + yy);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = '#8f6aa355';
  ctx.fillRect(Math.round(x - 14), Math.round(y - 26), 28, 2);
}

function drawPlayer(p) {
  if (p.invuln > 0 && Math.floor(p.invuln * 18) % 2 === 0 && p.hurtFlash > 0) return;
  const x = Math.round(p.x), y = Math.round(p.y);
  const bob = p.moving ? Math.round(Math.sin(p.animTime * 13) * 1) : 0;
  fillEllipse(x, y + 1, 6, 2.2, '#070b12b0');
  if (p.dashTime > 0) {
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#9fc6bd';
    ctx.fillRect(x - 4, y - 18, 8, 18);
    ctx.globalAlpha = 1;
  }
  const hurt = p.hurtFlash > 0;
  const cloak = hurt ? '#e7ded1' : '#2f4a4b';
  const cloakLight = hurt ? '#fff6e8' : '#3d5c59';
  const skin = hurt ? '#fff4df' : '#c79a72';
  ctx.fillStyle = '#1c2228';
  ctx.fillRect(x - 3, y - 5 + bob, 2, 5);
  ctx.fillRect(x + 1, y - 5 - bob, 2, 5);
  ctx.fillStyle = cloak;
  ctx.fillRect(x - 4, y - 15 + bob, 8, 10);
  ctx.fillStyle = cloakLight;
  ctx.fillRect(x - 2, y - 14 + bob, 4, 7);
  ctx.fillStyle = '#25343a';
  ctx.fillRect(x - 5, y - 14 + bob, 2, 6);
  ctx.fillRect(x + 3, y - 14 + bob, 2, 6);
  ctx.fillStyle = skin;
  ctx.fillRect(x - 3, y - 20 + bob, 6, 5);
  ctx.fillStyle = '#202026';
  ctx.fillRect(x - 4, y - 21 + bob, 8, 2);
  ctx.fillStyle = '#1a1c22';
  ctx.fillRect(x - 6, y - 22 + bob, 12, 2);
  ctx.fillStyle = '#3b3030';
  ctx.fillRect(x - 3, y - 22 + bob, 6, 1);
  if (p.dirX < -0.3) {
    ctx.fillStyle = '#16161c';
    ctx.fillRect(x - 3, y - 19 + bob, 1, 1);
  } else if (p.dirX > 0.3) {
    ctx.fillStyle = '#16161c';
    ctx.fillRect(x + 2, y - 19 + bob, 1, 1);
  } else {
    ctx.fillStyle = '#16161c';
    ctx.fillRect(x - 2, y - 19 + bob, 1, 1);
    ctx.fillRect(x + 1, y - 19 + bob, 1, 1);
  }
  ctx.fillStyle = '#c9a15f';
  ctx.fillRect(x - 6, y - 10 + bob, 2, 3);
  ctx.fillStyle = '#f0cf80';
  ctx.fillRect(x - 6, y - 9 + bob, 1, 1);
  if (p.attackAnim > 0) drawSlash(p);
}

function drawSlash(p) {
  const progress = 1 - p.attackAnim / 0.24;
  const angle = Math.atan2(p.dirY, p.dirX);
  const start = angle - 0.85 + progress * 0.45;
  const end = angle + 0.85 + progress * 0.45;
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y) - 11);
  ctx.strokeStyle = `rgba(246,226,168,${0.85 - progress * 0.55})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 17 + progress * 3, start, end);
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,255,${0.5 - progress * 0.4})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 14 + progress * 2, start + 0.2, end - 0.15);
  ctx.stroke();
  ctx.restore();
}

function drawSexton(npc) {
  const t = state.time;
  const x = Math.round(npc.x);
  const y = Math.round(npc.y + Math.sin(t * 1.6) * 2);
  ctx.globalAlpha = 0.78;
  fillEllipse(x, y + 1, 7, 2, '#8fd2c455');
  ctx.fillStyle = '#c7dfd3';
  ctx.beginPath();
  ctx.ellipse(x, y - 14, 5, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#a9cec1';
  ctx.beginPath();
  ctx.moveTo(x - 7, y - 11);
  ctx.lineTo(x + 7, y - 11);
  ctx.lineTo(x + 5, y);
  ctx.lineTo(x + 2, y - 3);
  ctx.lineTo(x, y + 1);
  ctx.lineTo(x - 3, y - 2);
  ctx.lineTo(x - 5, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#20332e';
  ctx.fillRect(x - 3, y - 16, 2, 2);
  ctx.fillRect(x + 2, y - 16, 2, 2);
  ctx.fillStyle = '#e9d28d';
  ctx.fillRect(x + 6, y - 10, 2, 4);
  ctx.fillStyle = '#fff0b0';
  ctx.fillRect(x + 6, y - 11, 2, 1);
  ctx.globalAlpha = 1;
}

function drawEnemy(e) {
  if (e.type === 'ghoul') drawGhoul(e);
  else if (e.type === 'skeleton') drawSkeleton(e);
  else if (e.type === 'wisp') drawWisp(e);
}

function drawGhoul(e) {
  const x = Math.round(e.x), y = Math.round(e.y);
  const bob = Math.round(Math.sin(state.time * 8 + e.seed) * 1);
  fillEllipse(x, y + 1, 6, 2, '#070b12b0');
  const flash = e.hitFlash > 0;
  ctx.fillStyle = flash ? '#fff2dc' : '#3f5547';
  ctx.fillRect(x - 5, y - 14 + bob, 10, 9);
  ctx.fillStyle = flash ? '#fff' : '#55705a';
  ctx.fillRect(x - 3, y - 16 + bob, 6, 5);
  ctx.fillStyle = flash ? '#fff' : '#2e4035';
  ctx.fillRect(x - 7, y - 13 + bob, 2, 7);
  ctx.fillRect(x + 5, y - 13 + bob, 2, 7);
  ctx.fillStyle = '#1c241f';
  ctx.fillRect(x - 4, y - 5 + bob, 2, 5);
  ctx.fillRect(x + 2, y - 5 + bob, 2, 5);
  ctx.fillStyle = '#d8d47b';
  ctx.fillRect(x - 2, y - 15 + bob, 1, 1);
  ctx.fillRect(x + 2, y - 15 + bob, 1, 1);
  ctx.fillStyle = '#27372c';
  ctx.fillRect(x - 1, y - 9 + bob, 2, 3);
}

function drawSkeleton(e) {
  const x = Math.round(e.x), y = Math.round(e.y);
  const bob = Math.round(Math.sin(state.time * 7 + e.seed) * 1);
  fillEllipse(x, y + 1, 6, 2, '#070b12b0');
  const flash = e.hitFlash > 0;
  const bone = flash ? '#ffffff' : '#c7c1aa';
  const dark = flash ? '#ffffff' : '#8e8a78';
  ctx.fillStyle = bone;
  ctx.fillRect(x - 4, y - 16 + bob, 8, 6);
  ctx.fillRect(x - 2, y - 10 + bob, 4, 7);
  ctx.fillRect(x - 5, y - 13 + bob, 2, 7);
  ctx.fillRect(x + 3, y - 13 + bob, 2, 7);
  ctx.fillRect(x - 3, y - 4 + bob, 2, 4);
  ctx.fillRect(x + 1, y - 4 + bob, 2, 4);
  ctx.fillStyle = '#1c1d22';
  ctx.fillRect(x - 3, y - 14 + bob, 2, 2);
  ctx.fillRect(x + 1, y - 14 + bob, 2, 2);
  ctx.fillStyle = dark;
  ctx.fillRect(x - 1, y - 8 + bob, 1, 4);
  ctx.fillRect(x - 4, y - 11 + bob, 1, 1);
  ctx.fillStyle = '#6c6f74';
  ctx.fillRect(x + 5, y - 12 + bob, 3, 9);
  ctx.fillStyle = '#9b9d9e';
  ctx.fillRect(x + 6, y - 11 + bob, 1, 7);
}

function drawWisp(e) {
  const x = Math.round(e.x), y = Math.round(e.y + Math.sin(state.time * 3 + e.seed) * 2);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const grad = ctx.createRadialGradient(x, y - 9, 1, x, y - 9, 14);
  grad.addColorStop(0, '#d7f5e5cc');
  grad.addColorStop(0.35, '#72c7b466');
  grad.addColorStop(1, '#2f6a6200');
  ctx.fillStyle = grad;
  ctx.fillRect(x - 15, y - 24, 30, 30);
  ctx.fillStyle = e.hitFlash > 0 ? '#ffffff' : '#bcead8';
  ctx.fillRect(x - 2, y - 12, 4, 4);
  ctx.fillStyle = '#79c7b4';
  ctx.fillRect(x - 1, y - 8, 2, 2);
  ctx.restore();
}

function drawBoss(e) {
  const x = Math.round(e.x), y = Math.round(e.y);
  const bob = Math.sin(state.time * 2.4) * 2;
  fillEllipse(x, y + 1, 15, 4, '#070b12c0');
  if (e.telegraph > 0) {
    ctx.strokeStyle = `rgba(211,120,103,${0.35 + 0.45 * Math.sin(state.time * 18)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 36, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const aura = ctx.createRadialGradient(x, y - 22, 3, x, y - 22, 36);
  aura.addColorStop(0, '#a66b8f44');
  aura.addColorStop(1, '#a66b8f00');
  ctx.fillStyle = aura;
  ctx.fillRect(x - 40, y - 62, 80, 80);
  ctx.restore();
  ctx.fillStyle = '#171521';
  ctx.beginPath();
  ctx.moveTo(x - 14, y);
  ctx.lineTo(x - 11, y - 30 + bob);
  ctx.lineTo(x - 3, y - 37 + bob);
  ctx.lineTo(x + 5, y - 36 + bob);
  ctx.lineTo(x + 13, y - 28 + bob);
  ctx.lineTo(x + 15, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#272134';
  ctx.fillRect(x - 8, y - 28 + bob, 16, 22);
  ctx.fillStyle = '#3b2c4a';
  ctx.fillRect(x - 5, y - 30 + bob, 10, 4);
  ctx.fillStyle = '#d4c3a8';
  ctx.fillRect(x - 5, y - 36 + bob, 10, 8);
  ctx.fillStyle = '#8f7c72';
  ctx.fillRect(x - 5, y - 36 + bob, 2, 8);
  ctx.fillStyle = '#1b1420';
  ctx.fillRect(x - 4, y - 33 + bob, 2, 2);
  ctx.fillRect(x + 2, y - 33 + bob, 2, 2);
  ctx.fillStyle = '#6e3f52';
  ctx.fillRect(x - 2, y - 30 + bob, 4, 1);
  ctx.fillStyle = '#bca77f';
  ctx.fillRect(x - 11, y - 42 + bob, 2, 9);
  ctx.fillRect(x + 9, y - 42 + bob, 2, 9);
  ctx.fillRect(x - 13, y - 44 + bob, 6, 2);
  ctx.fillRect(x + 7, y - 44 + bob, 6, 2);
  ctx.fillStyle = '#2b2138';
  ctx.fillRect(x - 18, y - 24 + bob, 4, 16);
  ctx.fillRect(x + 14, y - 24 + bob, 4, 16);
  ctx.fillStyle = '#6d6a71';
  ctx.fillRect(x - 22, y - 48 + bob, 2, 34);
  ctx.fillStyle = '#9a969c';
  ctx.fillRect(x - 26, y - 50 + bob, 11, 3);
  ctx.fillRect(x - 25, y - 47 + bob, 3, 2);
}

function drawPickup(p) {
  const t = state.time;
  const bob = Math.sin(t * 3 + p.seed) * 2;
  if (p.type === 'coin') {
    ctx.fillStyle = '#d9b86b';
    const w = 2 + Math.abs(Math.sin(t * 4 + p.seed)) * 3;
    ctx.fillRect(Math.round(p.x - w / 2), Math.round(p.y - 4 + bob), Math.max(1, w), 4);
    ctx.fillStyle = '#f6e2a1';
    ctx.fillRect(Math.round(p.x - 1), Math.round(p.y - 3 + bob), 1, 2);
  } else if (p.type === 'relic') {
    ctx.save();
    ctx.translate(Math.round(p.x), Math.round(p.y - 8 + bob));
    ctx.rotate(t * 0.8);
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, 22);
    grad.addColorStop(0, '#fff4c9');
    grad.addColorStop(0.3, '#d9b86b88');
    grad.addColorStop(1, '#d9b86b00');
    ctx.fillStyle = grad;
    ctx.fillRect(-24, -24, 48, 48);
    ctx.fillStyle = '#f2dda0';
    ctx.fillRect(-4, -6, 8, 12);
    ctx.fillStyle = '#b98d48';
    ctx.fillRect(-2, -4, 4, 8);
    ctx.restore();
  } else {
    ctx.fillStyle = '#d9d3bc';
    ctx.fillRect(Math.round(p.x - 3), Math.round(p.y - 3 + bob), 6, 2);
    ctx.fillRect(Math.round(p.x - 1), Math.round(p.y - 5 + bob), 2, 6);
  }
}

function drawProjectile(p) {
  const x = Math.round(p.x), y = Math.round(p.y);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const grad = ctx.createRadialGradient(x, y, 1, x, y, 13);
  grad.addColorStop(0, p.color || '#c8f0dc');
  grad.addColorStop(0.3, `${p.color || '#7fb8b4'}66`);
  grad.addColorStop(1, '#00000000');
  ctx.fillStyle = grad;
  ctx.fillRect(x - 14, y - 14, 28, 28);
  ctx.fillStyle = '#f4ffe8';
  ctx.fillRect(x - 1, y - 1, 2, 2);
  ctx.restore();
}

function drawParticle(p) {
  const alpha = clamp(p.life / p.maxLife, 0, 1);
  ctx.globalAlpha = alpha * (p.alpha ?? 1);
  if (p.type === 'leaf') {
    ctx.fillStyle = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 1);
  } else if (p.type === 'soul') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
    ctx.restore();
  } else if (p.type === 'spark') {
    ctx.fillStyle = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  } else {
    ctx.fillStyle = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size || 1, p.size || 1);
  }
  ctx.globalAlpha = 1;
}

function drawFloater(f) {
  const alpha = clamp(f.life / f.maxLife, 0, 1);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = f.color || '#f2dfaa';
  ctx.font = '600 6px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(f.text, Math.round(f.x), Math.round(f.y));
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawWater(camX, camY) {
  const world = state.world;
  const x0 = Math.max(0, Math.floor(camX / TILE) - 1);
  const y0 = Math.max(0, Math.floor(camY / TILE) - 1);
  const x1 = Math.min(world.w - 1, Math.ceil((camX + vw) / TILE) + 1);
  const y1 = Math.min(world.h - 1, Math.ceil((camY + vh) / TILE) + 1);
  ctx.save();
  ctx.globalAlpha = 0.55;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (getTile(world, x, y) !== T.WATER) continue;
      const phase = state.time * 0.7 + x * 0.8 + y * 0.4;
      const ox = Math.round(Math.sin(phase) * 2);
      ctx.fillStyle = '#4f7f83';
      ctx.fillRect(Math.round(x * TILE + 3 + ox), Math.round(y * TILE + 5), 4, 1);
      ctx.fillStyle = '#6d9997';
      ctx.fillRect(Math.round(x * TILE + 9 - ox), Math.round(y * TILE + 11), 3, 1);
    }
  }
  ctx.restore();
}

function drawWorld() {
  const world = state.world;
  const shakeX = camera.shake ? (Math.random() - 0.5) * camera.shake : 0;
  const shakeY = camera.shake ? (Math.random() - 0.5) * camera.shake : 0;
  const camX = Math.round(camera.x + shakeX);
  const camY = Math.round(camera.y + shakeY);
  ctx.save();
  ctx.translate(-camX, -camY);
  const ground = groundCache.get(world.id);
  if (ground) ctx.drawImage(ground, 0, 0);
  drawWater(camX, camY);
  for (const item of world.decor) {
    if (item.x < camX - 20 || item.x > camX + vw + 20 || item.y < camY - 20 || item.y > camY + vh + 20) continue;
    drawDecor(item);
  }
  const drawables = [];
  for (const object of world.objects) {
    if (object.x < camX - 180 || object.x > camX + vw + 180 || object.y < camY - 200 || object.y > camY + vh + 80) continue;
    if (object.type === 'barrier' && isBossBarrierOpen(world)) continue;
    drawables.push({ y: object.y, draw: () => drawObject(object) });
  }
  for (const npc of world.npcs) {
    if (npc.x < camX - 40 || npc.x > camX + vw + 40 || npc.y < camY - 40 || npc.y > camY + vh + 40) continue;
    drawables.push({ y: npc.y, draw: () => drawSexton(npc) });
  }
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    if (enemy.x < camX - 50 || enemy.x > camX + vw + 50 || enemy.y < camY - 60 || enemy.y > camY + vh + 50) continue;
    drawables.push({ y: enemy.y, draw: () => (enemy.type === 'boss' ? drawBoss(enemy) : drawEnemy(enemy)) });
  }
  for (const pickup of state.pickups) {
    drawables.push({ y: pickup.y, draw: () => drawPickup(pickup) });
  }
  if (state.player && state.mode !== 'dead') {
    drawables.push({ y: state.player.y, draw: () => drawPlayer(state.player) });
  }
  drawables.sort((a, b) => a.y - b.y);
  for (const item of drawables) item.draw();
  for (const projectile of state.projectiles) drawProjectile(projectile);
  for (const particle of state.particles) drawParticle(particle);
  for (const floater of state.floaters) drawFloater(floater);
  ctx.restore();
  drawFog(camX, camY);
  drawLighting(camX, camY);
  drawGlow(camX, camY);
  drawFireflies(camX, camY);
  if (state.mode === 'playing' || state.mode === 'dead' || state.mode === 'victory') drawObjectiveMarker(camX, camY);
  drawScreenEffects();
}

function drawFog(camX, camY) {
  const t = state.time;
  ctx.save();
  for (let i = 0; i < 5; i++) {
    const speed = 4 + i * 2.2;
    const x = ((t * speed + i * 173) % (vw + 260)) - 130;
    const y = 36 + i * (vh / 5) + Math.sin(t * 0.18 + i * 2) * 10;
    const r = 70 + i * 18;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, state.world.id === 'dungeon' ? 'rgba(100,150,150,0.028)' : 'rgba(176,190,186,0.038)');
    grad.addColorStop(1, 'rgba(120,140,140,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
}

function drawLighting(camX, camY) {
  const world = state.world;
  const darkness = world.ambient;
  lctx.clearRect(0, 0, vw, vh);
  lctx.fillStyle = `rgba(4, 6, 14, ${darkness})`;
  lctx.fillRect(0, 0, vw, vh);
  lctx.globalCompositeOperation = 'destination-out';
  const lights = [];
  for (const light of world.lights) {
    lights.push({ x: light.x, y: light.y, radius: light.radius, color: light.color, flicker: light.flicker, phase: light.phase });
  }
  const p = state.player;
  if (p && state.mode !== 'dead') {
    lights.push({ x: p.x, y: p.y - 10, radius: 64 + p.lantern * 22, color: '#f1c87a', flicker: 0.08, phase: 1 });
  }
  if (world.id === 'overworld') {
    const sexton = world.npcs[0];
    if (sexton) lights.push({ x: sexton.x, y: sexton.y - 12, radius: 38, color: '#8fd2c4', flicker: 0.12, phase: 2 });
  }
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    if (enemy.type === 'boss') lights.push({ x: enemy.x, y: enemy.y - 20, radius: 68, color: '#a66b8f', flicker: 0.1, phase: 3 });
    else if (enemy.type === 'wisp') lights.push({ x: enemy.x, y: enemy.y - 9, radius: 28, color: '#7fc3b4', flicker: 0.2, phase: enemy.seed });
  }
  for (const projectile of state.projectiles) {
    lights.push({ x: projectile.x, y: projectile.y, radius: 20, color: projectile.color || '#7fb8b4', flicker: 0.25, phase: projectile.x });
  }
  for (const pickup of state.pickups) {
    if (pickup.type === 'relic') lights.push({ x: pickup.x, y: pickup.y - 8, radius: 46, color: '#d9b86b', flicker: 0.12, phase: 4 });
  }
  for (const light of lights) {
    const sx = light.x - camX, sy = light.y - camY;
    const r = light.radius * (1 + Math.sin(state.time * 4.5 + (light.phase || 0)) * (light.flicker || 0));
    if (sx + r < 0 || sx - r > vw || sy + r < 0 || sy - r > vh) continue;
    const grad = lctx.createRadialGradient(sx, sy, r * 0.03, sx, sy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.98)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.62)');
    grad.addColorStop(0.82, 'rgba(255,255,255,0.2)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    lctx.fillStyle = grad;
    lctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  }
  lctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(lightCanvas, 0, 0);
}

function drawGlow(camX, camY) {
  const lights = state.world.lights;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const light of lights) {
    const sx = light.x - camX, sy = light.y - camY;
    const r = light.radius * 0.45;
    if (sx + r < 0 || sx - r > vw || sy + r < 0 || sy - r > vh) continue;
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    grad.addColorStop(0, `${light.color}22`);
    grad.addColorStop(1, `${light.color}00`);
    ctx.fillStyle = grad;
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  }
  const p = state.player;
  if (p && state.mode !== 'dead') {
    const sx = p.x - camX, sy = p.y - 10 - camY;
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 42);
    grad.addColorStop(0, '#f2c87a1c');
    grad.addColorStop(1, '#f2c87a00');
    ctx.fillStyle = grad;
    ctx.fillRect(sx - 42, sy - 42, 84, 84);
  }
  ctx.restore();
}

function drawFireflies(camX, camY) {
  if (state.world.id !== 'overworld') return;
  const t = state.time;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const fly of state.fireflies) {
    const x = fly.x + Math.sin(t * fly.speed + fly.phase) * fly.drift - camX;
    const y = fly.y + Math.cos(t * fly.speed * 0.8 + fly.phase) * fly.drift * 0.6 - camY;
    if (x < -5 || x > vw + 5 || y < -5 || y > vh + 5) continue;
    const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 2.3 + fly.phase * 2));
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#e8d48b';
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    ctx.globalAlpha = pulse * 0.24;
    ctx.fillStyle = '#e8d48b';
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
  }
  ctx.restore();
}

function currentGoal() {
  const q = state.quest;
  const world = state.world;
  const p = state.player;
  if (q.stage === 'wake') {
    const sexton = world.npcs[0];
    return sexton ? { x: sexton.x, y: sexton.y - 18, kind: 'talk' } : null;
  }
  if (q.stage === 'gather') {
    if (p.remains > 0) {
      const empty = world.objects.filter((o) => o.type === 'grave' && o.state === 'empty');
      if (empty.length) {
        const nearest = empty.reduce((a, b) => (distance(p.x, p.y, a.x, a.y) < distance(p.x, p.y, b.x, b.y) ? a : b));
        return { x: nearest.x, y: nearest.y - 18, kind: 'bury' };
      }
    }
    const restless = world.objects.filter((o) => o.type === 'grave' && o.state === 'restless');
    if (restless.length) {
      const nearest = restless.reduce((a, b) => (distance(p.x, p.y, a.x, a.y) < distance(p.x, p.y, b.x, b.y) ? a : b));
      return { x: nearest.x, y: nearest.y - 18, kind: 'dig' };
    }
    return { x: world.props.church.x, y: world.props.church.y - 28, kind: 'church' };
  }
  if (q.stage === 'crypt') {
    if (world.id === 'dungeon') return { x: world.props.exit.x, y: world.props.exit.y - 18, kind: 'church' };
    return { x: world.props.church.x, y: world.props.church.y - 18, kind: 'church' };
  }
  if (q.stage === 'braziers') {
    if (world.id !== 'dungeon') return { x: world.props.church.x, y: world.props.church.y - 18, kind: 'church' };
    const braziers = world.objects.filter((o) => o.type === 'brazier' && !o.lit);
    if (braziers.length) {
      const nearest = braziers.reduce((a, b) => (distance(p.x, p.y, a.x, a.y) < distance(p.x, p.y, b.x, b.y) ? a : b));
      return { x: nearest.x, y: nearest.y - 22, kind: 'brazier' };
    }
    return { x: world.props.boss.x, y: world.props.boss.y - 30, kind: 'boss' };
  }
  if (q.stage === 'boss') {
    if (state.boss && !state.boss.dead) return { x: state.boss.x, y: state.boss.y - 40, kind: 'boss' };
    return { x: world.props.boss.x, y: world.props.boss.y - 30, kind: 'boss' };
  }
  if (q.stage === 'relic') {
    const relic = state.pickups.find((item) => item.type === 'relic');
    if (relic) return { x: relic.x, y: relic.y - 18, kind: 'relic' };
  }
  return null;
}

function drawObjectiveMarker(camX, camY) {
  const goal = currentGoal();
  if (!goal) return;
  const sx = goal.x - camX, sy = goal.y - camY;
  const color = goal.kind === 'boss' ? '#d98a78' : goal.kind === 'brazier' ? '#8fd2c4' : '#e7c978';
  const pulse = 0.5 + 0.5 * Math.sin(state.time * 3.4);
  if (sx > 18 && sx < vw - 18 && sy > 20 && sy < vh - 18) {
    ctx.save();
    ctx.translate(Math.round(sx), Math.round(sy - 6 + Math.sin(state.time * 2.5) * 2));
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.72 + pulse * 0.28;
    ctx.fillRect(-3, -3, 6, 6);
    ctx.globalAlpha = 0.28;
    ctx.fillRect(-6, -6, 12, 12);
    ctx.restore();
    return;
  }
  const cx = vw / 2, cy = vh / 2;
  const dx = sx - cx, dy = sy - cy;
  const angle = Math.atan2(dy, dx);
  const margin = 20;
  const rx = (vw / 2 - margin) / Math.max(0.001, Math.abs(Math.cos(angle)));
  const ry = (vh / 2 - margin) / Math.max(0.001, Math.abs(Math.sin(angle)));
  const reach = Math.min(rx, ry);
  const ax = cx + Math.cos(angle) * reach;
  const ay = cy + Math.sin(angle) * reach;
  ctx.save();
  ctx.translate(Math.round(ax), Math.round(ay));
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.6 + pulse * 0.35;
  ctx.beginPath();
  ctx.moveTo(6, 0);
  ctx.lineTo(-4, -5);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-4, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawScreenEffects() {
  const p = state.player;
  if (!p) return;
  const hurt = p.hurtFlash > 0 ? p.hurtFlash / 0.24 : 0;
  if (hurt > 0.01) {
    const grad = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.28, vw / 2, vh / 2, vh * 0.72);
    grad.addColorStop(0, '#a4575100');
    grad.addColorStop(1, `rgba(150, 58, 54, ${hurt * 0.42})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, vw, vh);
  }
  if (p.hp <= 1 && state.mode === 'playing') {
    const pulse = 0.06 + 0.04 * Math.sin(state.time * 4);
    const grad = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.3, vw / 2, vh / 2, vh * 0.75);
    grad.addColorStop(0, '#6b202000');
    grad.addColorStop(1, `rgba(120, 38, 38, ${pulse})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, vw, vh);
  }
}

function tileColor(tile, world) {
  if (tile === T.WATER) return '#234653';
  if (tile === T.PATH) return '#756347';
  if (tile === T.DIRT) return '#4c3e30';
  if (tile === T.STONE) return '#55565e';
  if (tile === T.WALL) return world.id === 'dungeon' ? '#202433' : '#2b2e38';
  if (tile === T.FLOOR) return '#403d48';
  if (tile === T.BRIDGE) return '#5d4832';
  if (tile === T.MOSS) return '#2d4c3b';
  if (tile === T.MEADOW) return '#3c5a3b';
  return '#34503a';
}

function renderMinimap() {
  if (!state.world) return;
  const world = state.world;
  const w = minimap.width, h = minimap.height;
  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = '#080b13';
  mctx.fillRect(0, 0, w, h);
  const sx = w / world.w, sy = h / world.h;
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      mctx.fillStyle = tileColor(getTile(world, x, y), world);
      mctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.ceil(sx), Math.ceil(sy));
    }
  }
  for (const object of world.objects) {
    const ox = object.x / TILE * sx, oy = object.y / TILE * sy;
    if (object.type === 'church') {
      mctx.fillStyle = state.quest.souls >= 3 || state.quest.stage !== 'crypt' ? '#a78a56' : '#a45751';
      mctx.fillRect(Math.floor(ox - 8), Math.floor(oy - 7), 16, 10);
    } else if (object.type === 'grave') {
      if (object.state === 'restless') {
        mctx.fillStyle = '#e7c978';
        mctx.fillRect(Math.floor(ox), Math.floor(oy), 2, 2);
      } else if (object.state === 'empty' && state.player.remains > 0) {
        mctx.fillStyle = '#7fb8b4';
        mctx.fillRect(Math.floor(ox), Math.floor(oy), 2, 2);
      }
    } else if (object.type === 'brazier' && object.lit) {
      mctx.fillStyle = '#e7c978';
      mctx.fillRect(Math.floor(ox) - 1, Math.floor(oy) - 1, 2, 2);
    } else if (object.type === 'shrine') {
      mctx.fillStyle = '#7fb8b4';
      mctx.fillRect(Math.floor(ox) - 1, Math.floor(oy) - 1, 2, 2);
    }
  }
  for (const npc of world.npcs) {
    mctx.fillStyle = '#8fd2c4';
    mctx.fillRect(Math.floor(npc.x / TILE * sx) - 1, Math.floor(npc.y / TILE * sy) - 1, 2, 2);
  }
  const goal = currentGoal();
  if (goal) {
    mctx.fillStyle = '#f2d68a';
    mctx.fillRect(Math.floor(goal.x / TILE * sx) - 1, Math.floor(goal.y / TILE * sy) - 1, 3, 3);
  }
  if (state.player) {
    mctx.fillStyle = '#f8f0d8';
    mctx.fillRect(Math.floor(state.player.x / TILE * sx) - 1, Math.floor(state.player.y / TILE * sy) - 1, 3, 3);
    mctx.strokeStyle = '#f8f0d85c';
    mctx.lineWidth = 1;
    mctx.strokeRect(Math.floor(camera.x / TILE * sx), Math.floor(camera.y / TILE * sy), Math.ceil(vw / TILE * sx), Math.ceil(vh / TILE * sy));
  }
  const label = $('minimap-label');
  if (label) label.textContent = world.id === 'dungeon' ? 'THE OSSUARY' : 'HOLLOWMERE';
}

function drawBigMap() {
  const world = state.world;
  if (!world) return;
  const w = bigMap.width, h = bigMap.height;
  bctx.clearRect(0, 0, w, h);
  bctx.fillStyle = '#070a11';
  bctx.fillRect(0, 0, w, h);
  const pad = 20;
  const scale = Math.min((w - pad * 2) / world.w, (h - pad * 2) / world.h);
  const ox = (w - world.w * scale) / 2, oy = (h - world.h * scale) / 2;
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      bctx.fillStyle = tileColor(getTile(world, x, y), world);
      bctx.fillRect(Math.floor(ox + x * scale), Math.floor(oy + y * scale), Math.ceil(scale), Math.ceil(scale));
    }
  }
  bctx.strokeStyle = '#d8c58c2e';
  bctx.lineWidth = 1;
  bctx.strokeRect(Math.floor(ox), Math.floor(oy), Math.floor(world.w * scale), Math.floor(world.h * scale));
  for (const object of world.objects) {
    const x = ox + object.x / TILE * scale, y = oy + object.y / TILE * scale;
    if (object.type === 'church' || object.type === 'house') {
      bctx.fillStyle = object.type === 'church' ? (state.quest.souls < 3 ? '#a45751' : '#b18f55') : '#625a4e';
      bctx.fillRect(Math.floor(x - 9), Math.floor(y - 8), 18, 11);
    } else if (object.type === 'shrine') {
      bctx.fillStyle = '#7fb8b4';
      bctx.fillRect(Math.floor(x) - 1, Math.floor(y) - 1, 3, 3);
    } else if (object.type === 'grave') {
      bctx.fillStyle = object.state === 'restless' ? '#e7c978' : object.state === 'resting' ? '#a8b79b' : '#777468';
      bctx.fillRect(Math.floor(x) - 1, Math.floor(y) - 1, 2, 2);
    } else if (object.type === 'tree') {
      bctx.fillStyle = '#2f4c37';
      bctx.fillRect(Math.floor(x) - 2, Math.floor(y) - 2, 4, 4);
    } else if (object.type === 'brazier') {
      bctx.fillStyle = object.lit ? '#e7c978' : '#696168';
      bctx.fillRect(Math.floor(x) - 1, Math.floor(y) - 1, 2, 2);
    }
  }
  for (const npc of world.npcs) {
    bctx.fillStyle = '#8fd2c4';
    bctx.fillRect(Math.floor(ox + npc.x / TILE * scale) - 2, Math.floor(oy + npc.y / TILE * scale) - 2, 4, 4);
  }
  const goal = currentGoal();
  if (goal) {
    bctx.strokeStyle = '#f2d68a';
    bctx.lineWidth = 1;
    bctx.beginPath();
    bctx.arc(Math.floor(ox + goal.x / TILE * scale), Math.floor(oy + goal.y / TILE * scale), 5, 0, Math.PI * 2);
    bctx.stroke();
  }
  if (state.player) {
    bctx.fillStyle = '#f8f0d8';
    bctx.fillRect(Math.floor(ox + state.player.x / TILE * scale) - 2, Math.floor(oy + state.player.y / TILE * scale) - 2, 5, 5);
  }
  bctx.fillStyle = '#d8c58c';
  bctx.font = '600 10px monospace';
  bctx.textAlign = 'center';
  bctx.fillText(world.id === 'dungeon' ? 'THE SUNKEN OSSUARY' : 'HOLLOWMERE CEMETERY', w / 2, 13);
  bctx.textAlign = 'left';
}

function render() {
  if (!state.world) return;
  ctx.clearRect(0, 0, vw, vh);
  drawWorld();
  if (state.mode === 'playing' && !state.paused) {
    state.hudTick -= 1 / 60;
    if (state.hudTick <= 0) {
      state.hudTick = 0.1;
      updateHud();
      renderMinimap();
    }
  }
}

function createPlayer(world) {
  return {
    x: world.spawn.x,
    y: world.spawn.y,
    dirX: 0,
    dirY: -1,
    moving: false,
    hp: 5,
    maxHp: 5,
    coins: 0,
    remains: 0,
    wood: 0,
    stone: 0,
    souls: 0,
    invuln: 0,
    attackCd: 0,
    attackAnim: 0,
    dashCd: 0,
    dashTime: 0,
    dashX: 0,
    dashY: 0,
    animTime: 0,
    hurtFlash: 0,
    lantern: 1,
    blade: 1,
    kills: 0,
  };
}

function makeFireflies() {
  const list = [];
  for (let i = 0; i < 46; i++) {
    list.push({
      x: 120 + Math.random() * 800,
      y: 170 + Math.random() * 420,
      speed: 0.35 + Math.random() * 0.8,
      drift: 4 + Math.random() * 10,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return list;
}

function resetGame() {
  const overworld = createOverworld();
  const dungeon = createDungeon();
  state.overworld = overworld;
  state.dungeon = dungeon;
  state.world = overworld;
  state.player = createPlayer(overworld);
  state.boss = null;
  state.enemies = [];
  state.projectiles = [];
  state.particles = [];
  state.pickups = [];
  state.floaters = [];
  state.quest = { stage: 'wake', souls: 0, braziers: 0, bossDown: false, relic: false, talked: false };
  state.dialogue = null;
  state.interaction = null;
  state.interactionProgress = 0;
  state.mode = 'title';
  state.paused = false;
  state.overlay = null;
  state.overlayReturn = null;
  state.time = 0;
  state.kills = 0;
  state.startTime = 0;
  state.shake = 0;
  state.hitstop = 0;
  state.bossActive = false;
  state.victoryShown = false;
  state.dungeonSpawned = false;
  state.transitioning = false;
  state.transitionToken = (state.transitionToken || 0) + 1;
  state.fireflies = makeFireflies();
  state.lastObjective = '';
  keys.clear();
  pressed.clear();
  groundCache.clear();
  buildGround(overworld);
  buildGround(dungeon);
  for (const id of ['help-panel', 'pause-panel', 'death-panel', 'victory-panel', 'map-panel', 'shrine-panel']) {
    $(id).classList.add('hidden');
  }
  $('dialogue').classList.add('hidden');
  $('title-screen').classList.remove('hidden');
  $('hud').classList.add('hidden');
  $('prompt').classList.add('hidden');
  $('boss-hud').classList.add('hidden');
  $('toast').classList.remove('show');
  $('fade').classList.remove('opaque');
  snapCamera();
  updateHud();
  updateObjective();
}

function startRun() {
  if (state.mode !== 'title') return;
  state.mode = 'playing';
  state.paused = false;
  state.startTime = state.time;
  $('title-screen').classList.add('hidden');
  $('hud').classList.remove('hidden');
  initAudio();
  if (ac && ac.state === 'suspended') ac.resume();
  startAmbient();
  snapCamera();
  showLocation('HOLLOWMERE CEMETERY', 'THE QUIET BELL WAITS');
  toast('WASD to walk · E to tend · Space to swing', 4300);
  updateHud();
  updateObjective();
}

function newRun() {
  resetGame();
  startRun();
}

function showLocation(name, subtitle) {
  const el = $('location-banner');
  el.innerHTML = `${name}<small>${subtitle}</small>`;
  el.classList.add('show');
  clearTimeout(state.locationTimer);
  state.locationTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function toast(text, duration = 2700, gold = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('gold', gold);
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function burst(x, y, color, count = 7, speed = 34, life = 0.6, type = 'dust', size = 1) {
  for (let i = 0; i < count; i++) {
    state.particles.push({
      x, y,
      vx: rand(-speed, speed),
      vy: rand(-speed, speed),
      life: life * rand(1.2, 0.6),
      maxLife: life,
      color,
      type,
      size,
      alpha: 1,
    });
  }
}

function soulBurst(x, y, count = 14) {
  for (let i = 0; i < count; i++) {
    state.particles.push({
      x: x + rand(-6, 6),
      y: y - rand(0, 8),
      vx: rand(-8, 8),
      vy: rand(-26, -10),
      life: rand(1.1, 0.6),
      maxLife: 1.2,
      color: i % 3 ? '#d9e8cc' : '#e7c978',
      type: 'soul',
      size: 1,
      alpha: 1,
    });
  }
}

function addFloater(x, y, text, color = '#f2dfaa') {
  state.floaters.push({ x, y, text, color, life: 0.9, maxLife: 0.9 });
}

function updateParticles(dt) {
  for (const p of state.particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.96;
    p.vy *= 0.96;
    if (p.type === 'leaf') {
      p.vy += 12 * dt;
      p.vx += Math.sin(state.time * 3 + p.y * 0.05) * 4 * dt;
    } else if (p.type === 'soul') {
      p.vy -= 3 * dt;
    }
  }
  state.particles = state.particles.filter((p) => p.life > 0);
  if (state.particles.length > 380) state.particles.splice(0, state.particles.length - 380);
}

function updateFloaters(dt) {
  for (const f of state.floaters) {
    f.life -= dt;
    f.y -= 13 * dt;
  }
  state.floaters = state.floaters.filter((f) => f.life > 0);
}

function updatePlayer(dt) {
  const p = state.player;
  p.invuln = Math.max(0, p.invuln - dt);
  p.attackCd = Math.max(0, p.attackCd - dt);
  p.attackAnim = Math.max(0, p.attackAnim - dt);
  p.dashCd = Math.max(0, p.dashCd - dt);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt);
  if (p.dashTime > 0) {
    p.dashTime -= dt;
    moveEntity(state.world, p, p.dashX * 190 * dt, p.dashY * 190 * dt, 5);
    p.moving = true;
    p.animTime += dt * 1.6;
    if (Math.random() > 0.55) burst(p.x, p.y - 6, '#9fc6bd', 1, 10, 0.3, 'dust');
    return;
  }
  let ix = 0, iy = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iy -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iy += 1;
  const length = Math.hypot(ix, iy);
  p.moving = length > 0.01;
  if (p.moving) {
    ix /= length;
    iy /= length;
    p.dirX = ix;
    p.dirY = iy;
    const speed = p.attackAnim > 0 ? 40 : 78;
    moveEntity(state.world, p, ix * speed * dt, iy * speed * dt, 5);
    p.animTime += dt * (1 + speed / 90);
    if (state.time - state.lastFootstep > 0.31) {
      state.lastFootstep = state.time;
      sfx('step');
      if (Math.random() > 0.72) burst(p.x, p.y, '#6b735d', 1, 8, 0.35, 'dust');
    }
  } else {
    p.animTime += dt * 0.4;
  }
  if (p.hp <= 0) die();
}

function startDash() {
  const p = state.player;
  if (state.mode !== 'playing' || state.paused || state.overlay || state.dialogue || p.dashCd > 0 || p.dashTime > 0) return;
  p.dashTime = 0.16;
  p.dashCd = 0.8;
  p.invuln = Math.max(p.invuln, 0.3);
  p.dashX = p.dirX || 0;
  p.dashY = p.dirY || -1;
  burst(p.x, p.y - 6, '#b8d8c8', 5, 18, 0.4, 'dust');
  noise(0.12, 0.07, 'highpass', 1400);
}

function playerAttack() {
  const p = state.player;
  if (state.mode !== 'playing' || state.paused || state.overlay || state.dialogue || p.attackCd > 0 || p.dashTime > 0) return;
  let aimX = p.dirX, aimY = p.dirY;
  let nearest = null, nearestDist = 44;
  for (const e of state.enemies) {
    if (e.dead) continue;
    const d = distance(p.x, p.y, e.x, e.y);
    if (d < nearestDist && hasLineOfSight(p.x, p.y - 9, e.x, e.y - 8)) {
      nearest = e;
      nearestDist = d;
    }
  }
  if (nearest) {
    aimX = nearest.x - p.x;
    aimY = nearest.y - p.y;
    const l = Math.hypot(aimX, aimY) || 1;
    aimX /= l;
    aimY /= l;
    p.dirX = aimX;
    p.dirY = aimY;
  }
  if (!aimX && !aimY) {
    aimX = 0;
    aimY = -1;
  }
  p.attackCd = 0.33;
  p.attackAnim = 0.24;
  const range = 25 + (p.blade - 1) * 4;
  let hit = false;
  for (const e of state.enemies) {
    if (e.dead) continue;
    if (!inSwordArc(p.x, p.y - 9, aimX, aimY, e.x, e.y - 8, range + (e.radius || 0), 0.1)) continue;
    if (!hasLineOfSight(p.x, p.y - 9, e.x, e.y - 8)) continue;
    damageEnemy(e, 16 + (p.blade - 1) * 7, aimX, aimY);
    hit = true;
  }
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const projectile = state.projectiles[i];
    if (distance(p.x, p.y - 9, projectile.x, projectile.y) < range + 4) {
      burst(projectile.x, projectile.y, projectile.color, 7, 30, 0.45, 'spark');
      state.projectiles.splice(i, 1);
      hit = true;
    }
  }
  sfx('slash');
  burst(p.x + aimX * 16, p.y - 9 + aimY * 16, '#f2dfaa', 4, 22, 0.35, 'spark');
  if (hit) {
    state.hitstop = 0.035;
    camera.shake = 2.6;
  }
}

function damageEnemy(enemy, amount, dx, dy) {
  if (!enemy || enemy.dead) return;
  enemy.hp -= amount;
  enemy.hitFlash = 0.14;
  const l = Math.hypot(dx, dy) || 1;
  moveEntity(state.world, enemy, (dx / l) * 7, (dy / l) * 7, enemy.radius || 6);
  addFloater(enemy.x, enemy.y - 26, `-${Math.round(amount)}`, '#f2dfaa');
  burst(enemy.x, enemy.y - 10, enemy.type === 'wisp' ? '#9ed8c4' : '#9a8d6f', 7, 30, 0.55, 'dust');
  sfx('hit');
  if (enemy.hp > 0) return;
  enemy.dead = true;
  enemy.deathTimer = 0;
  state.kills++;
  state.player.kills++;
  soulBurst(enemy.x, enemy.y - 8, 10);
  if (enemy.type === 'boss') {
    bossDefeated(enemy);
  } else {
    dropCoins(enemy.x, enemy.y - 5, enemy.type === 'skeleton' ? 3 : 2);
    if (Math.random() > 0.55) state.pickups.push({ type: 'bone', x: enemy.x, y: enemy.y - 3, vx: rand(-12, 12), vy: rand(-20, -8), life: 999, seed: Math.random() * 9 });
  }
}

function dropCoins(x, y, count) {
  for (let i = 0; i < count; i++) {
    state.pickups.push({
      type: 'coin',
      x: x + rand(-5, 5),
      y: y + rand(-3, 3),
      vx: rand(-24, 24),
      vy: rand(-36, -12),
      life: 18,
      value: 1,
      seed: Math.random() * 9,
    });
  }
}

function updatePickups(dt) {
  const p = state.player;
  for (const item of state.pickups) {
    item.life -= dt;
    if (item.type === 'coin' || item.type === 'bone') {
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      item.vy += 42 * dt;
      item.vx *= 0.94;
      if (item.y > state.world.h * TILE) item.life = 0;
      const d = distance(p.x, p.y - 5, item.x, item.y);
      if (item.type === 'coin' && d < 58) {
        const l = Math.max(1, d);
        item.x += (p.x - item.x) / l * 120 * dt;
        item.y += (p.y - 5 - item.y) / l * 120 * dt;
      }
      if (d < 9) {
        if (item.type === 'coin') {
          p.coins += item.value || 1;
          sfx('coin');
          addFloater(item.x, item.y - 10, '+1', '#e7c978');
        } else {
          p.remains++;
          sfx('coin');
          addFloater(item.x, item.y - 10, '+bone', '#d9d3bc');
        }
        item.life = 0;
      }
    }
  }
  state.pickups = state.pickups.filter((item) => item.life > 0);
}

function updateProjectiles(dt) {
  const p = state.player;
  for (const projectile of state.projectiles) {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.life -= dt;
    if (projectile.life <= 0) continue;
    if (isBlocked(state.world, projectile.x, projectile.y, 1)) {
      projectile.life = 0;
      burst(projectile.x, projectile.y, projectile.color, 4, 18, 0.3, 'spark');
      continue;
    }
    if (distance(p.x, p.y - 6, projectile.x, projectile.y) < 8) {
      projectile.life = 0;
      damagePlayer(projectile.damage || 1, projectile);
    }
  }
  state.projectiles = state.projectiles.filter((projectile) => projectile.life > 0);
}

function damagePlayer(amount, source) {
  const p = state.player;
  if (state.mode !== 'playing' || p.invuln > 0) return;
  p.hp -= amount;
  p.invuln = 1.0;
  p.hurtFlash = 0.24;
  camera.shake = 5.5;
  state.hitstop = 0.03;
  sfx('hurt');
  addFloater(p.x, p.y - 28, `-${amount}`, '#e08b80');
  burst(p.x, p.y - 8, '#a45751', 9, 34, 0.55, 'dust');
  if (source) {
    const dx = p.x - source.x, dy = p.y - source.y;
    const l = Math.hypot(dx, dy) || 1;
    moveEntity(state.world, p, (dx / l) * 12, (dy / l) * 12, 5);
  }
  if (p.hp <= 0) die();
  updateHud();
}

function die() {
  if (state.mode !== 'playing') return;
  state.player.hp = 0;
  state.mode = 'dead';
  state.paused = false;
  keys.clear();
  $('prompt').classList.add('hidden');
  $('death-panel').classList.remove('hidden');
  tone(90, 1.1, 'sawtooth', 0.16, -48);
}

function rise() {
  if (state.mode !== 'dead') return;
  const p = state.player;
  const world = state.world;
  p.hp = p.maxHp;
  p.invuln = 2;
  p.coins = Math.max(0, p.coins - 12);
  const spawn = world.id === 'dungeon' ? world.spawn : world.spawn;
  p.x = spawn.x;
  p.y = spawn.y;
  p.dirX = 0;
  p.dirY = -1;
  state.projectiles = [];
  state.mode = 'playing';
  state.paused = false;
  $('death-panel').classList.add('hidden');
  snapCamera();
  showLocation(world.id === 'dungeon' ? 'THE SUNKEN OSSUARY' : 'HOLLOWMERE CEMETERY', 'THE EARTH GIVES YOU BACK');
  updateHud();
}

function hasLineOfSight(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(d / 7));
  const world = state.world;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const tile = getTile(world, Math.floor(x / TILE), Math.floor(y / TILE));
    if (tile === T.WALL || tile === T.VOID) return false;
  }
  return true;
}

function spawnEnemy(type, tx, ty) {
  const base = {
    ghoul: { hp: 30, speed: 27, radius: 6, damage: 1 },
    skeleton: { hp: 44, speed: 31, radius: 6, damage: 1 },
    wisp: { hp: 20, speed: 19, radius: 5, damage: 1 },
  }[type];
  const enemy = {
    id: `enemy-${Math.random().toString(36).slice(2)}`,
    type,
    x: (tx + 0.5) * TILE,
    y: (ty + 0.85) * TILE,
    hp: base.hp,
    maxHp: base.hp,
    speed: base.speed,
    radius: base.radius,
    damage: base.damage,
    attackCd: rand(0.5, 1.2),
    shootCd: rand(0.8, 1.8),
    hitFlash: 0,
    dead: false,
    deathTimer: 0,
    seed: Math.random() * 9,
  };
  state.enemies.push(enemy);
  return enemy;
}

function spawnDungeonEnemies() {
  state.enemies = state.enemies.filter((enemy) => enemy.type === 'boss');
  spawnEnemy('ghoul', 16, 13);
  spawnEnemy('skeleton', 24, 18);
  spawnEnemy('wisp', 20, 18);
  spawnEnemy('ghoul', 6, 14);
  spawnEnemy('wisp', 8, 18);
  spawnEnemy('skeleton', 34, 14);
  spawnEnemy('ghoul', 32, 18);
  state.dungeonSpawned = true;
}

function spawnBoss() {
  if (state.boss && !state.boss.dead) return;
  const world = state.dungeon;
  const boss = {
    id: 'hollow-warden',
    type: 'boss',
    x: world.props.boss.x,
    y: world.props.boss.y,
    hp: 260,
    maxHp: 260,
    speed: 24,
    radius: 12,
    damage: 2,
    attackCd: 1.5,
    shootCd: 2.4,
    telegraph: 0,
    hitFlash: 0,
    dead: false,
    deathTimer: 0,
    seed: 4.2,
    summoned66: false,
    summoned33: false,
  };
  state.boss = boss;
  state.bossActive = true;
  state.enemies.push(boss);
  state.quest.stage = 'boss';
  $('boss-hud').classList.remove('hidden');
  sfx('boss');
  camera.shake = 9;
  showLocation('THE HOLLOW WARDEN', 'IT HAS BEEN WAITING');
}

function updateEnemies(dt) {
  const p = state.player;
  for (const enemy of state.enemies) {
    if (enemy.dead) {
      enemy.deathTimer += dt;
      continue;
    }
    enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
    if (enemy.type === 'boss') {
      updateBoss(enemy, dt);
      continue;
    }
    const d = distance(enemy.x, enemy.y, p.x, p.y);
    if (enemy.type === 'wisp') {
      enemy.shootCd -= dt;
      if (d < 190 && hasLineOfSight(enemy.x, enemy.y - 10, p.x, p.y - 8)) {
        if (d > 66) {
          enemyMove(enemy, (p.x - enemy.x) / d * enemy.speed * dt, (p.y - enemy.y) / d * enemy.speed * dt);
        } else {
          const angle = Math.atan2(p.y - enemy.y, p.x - enemy.x) + Math.PI / 2;
          enemyMove(enemy, Math.cos(angle) * 8 * dt, Math.sin(angle) * 8 * dt);
        }
        if (enemy.shootCd <= 0) {
          enemy.shootCd = 2.2;
          const angle = Math.atan2(p.y - 7 - (enemy.y - 9), p.x - enemy.x);
          state.projectiles.push({
            x: enemy.x,
            y: enemy.y - 9,
            vx: Math.cos(angle) * 54,
            vy: Math.sin(angle) * 54,
            life: 4,
            damage: 1,
            color: '#7fc3b4',
          });
          tone(300, 0.16, 'sine', 0.05, 60);
        }
      }
      continue;
    }
    if (d < 190) {
      if (d > 14) {
        enemyMove(enemy, (p.x - enemy.x) / d * enemy.speed * dt, (p.y - enemy.y) / d * enemy.speed * dt);
      }
      enemy.attackCd -= dt;
      if (d < 18 && enemy.attackCd <= 0) {
        enemy.attackCd = 1.15;
        damagePlayer(enemy.damage, enemy);
        burst(enemy.x, enemy.y - 9, '#d5c797', 4, 20, 0.35, 'spark');
      }
    }
  }
  state.enemies = state.enemies.filter((enemy) => !enemy.dead || enemy.deathTimer < 0.4);
}

function enemyMove(enemy, dx, dy) {
  const radius = enemy.radius || 6;
  if (!moveEntity(state.world, enemy, dx, dy, radius)) {
    if (!moveEntity(state.world, enemy, dx, 0, radius)) moveEntity(state.world, enemy, 0, dy, radius);
  }
}

function updateBoss(boss, dt) {
  const p = state.player;
  const d = distance(boss.x, boss.y, p.x, p.y);
  boss.attackCd = Math.max(0, boss.attackCd - dt);
  boss.shootCd = Math.max(0, boss.shootCd - dt);
  if (boss.telegraph > 0) {
    boss.telegraph -= dt;
    if (boss.telegraph <= 0) {
      if (d < 48) damagePlayer(2, boss);
      burst(boss.x, boss.y, '#b98179', 16, 50, 0.7, 'dust');
      camera.shake = 8;
      tone(70, 0.4, 'sawtooth', 0.14, -20);
    }
    return;
  }
  const enraged = boss.hp < boss.maxHp * 0.34;
  const speed = enraged ? 34 : boss.speed;
  if (d > 30) {
    enemyMove(boss, (p.x - boss.x) / d * speed * dt, (p.y - boss.y) / d * speed * dt);
  }
  if (d < 42 && boss.attackCd <= 0) {
    boss.attackCd = enraged ? 1.25 : 1.7;
    boss.telegraph = 0.55;
    tone(150, 0.4, 'sawtooth', 0.08, -50);
  }
  if (boss.shootCd <= 0 && d < 220) {
    boss.shootCd = enraged ? 2.1 : 2.9;
    const baseAngle = Math.atan2(p.y - 7 - (boss.y - 20), p.x - boss.x);
    const count = enraged ? 10 : 8;
    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (i / count) * Math.PI * 2;
      state.projectiles.push({
        x: boss.x,
        y: boss.y - 20,
        vx: Math.cos(angle) * (enraged ? 60 : 48),
        vy: Math.sin(angle) * (enraged ? 60 : 48),
        life: 4.5,
        damage: 1,
        color: '#a66b8f',
      });
    }
    tone(180, 0.3, 'sine', 0.07, -60);
  }
  if (!boss.summoned66 && boss.hp < boss.maxHp * 0.66) {
    boss.summoned66 = true;
    spawnEnemy('wisp', 16, 5);
    spawnEnemy('wisp', 24, 5);
    soulBurst(boss.x, boss.y - 20, 20);
  }
  if (!boss.summoned33 && boss.hp < boss.maxHp * 0.33) {
    boss.summoned33 = true;
    spawnEnemy('ghoul', 16, 6);
    spawnEnemy('ghoul', 24, 6);
    soulBurst(boss.x, boss.y - 20, 20);
    camera.shake = 7;
  }
  const room = state.dungeon.props.bossRoom;
  boss.x = clamp(boss.x, (room.x0 + 1) * TILE, (room.x1) * TILE);
  boss.y = clamp(boss.y, (room.y0 + 1.5) * TILE, (room.y1 + 0.7) * TILE);
}

function bossDefeated(boss) {
  state.bossActive = false;
  state.quest.bossDown = true;
  state.quest.stage = 'relic';
  $('boss-hud').classList.add('hidden');
  soulBurst(boss.x, boss.y - 20, 46);
  burst(boss.x, boss.y - 10, '#a66b8f', 30, 60, 1.2, 'soul');
  state.projectiles = [];
  state.pickups.push({ type: 'relic', x: boss.x, y: boss.y - 4, life: 9999, seed: 2.1 });
  showLocation('THE WARDEN FALLS', 'CLAIM THE RELIC OF THE PAST');
  sfx('victory');
  camera.shake = 10;
}

function updateQuest() {
  const q = state.quest;
  if (state.world.id === 'dungeon') q.braziers = countLitBraziers(state.world);
  if (q.stage === 'gather' && q.souls >= 3) {
    q.stage = 'crypt';
    showLocation('THE SEAL BREAKS', 'THE CHURCH DOOR STANDS OPEN');
    toast('Three souls rest. The church door is open.', 3400, true);
    sfx('open');
  }
  if (q.stage === 'braziers' && q.braziers >= 3) {
    q.stage = 'boss';
    const barrier = state.dungeon.objects.find((o) => o.type === 'barrier');
    if (barrier) barrier.solid = false;
    if (!state.bossActive) spawnBoss();
  }
}

function findInteraction() {
  if (state.mode !== 'playing' || state.paused || state.dialogue || state.overlay) return null;
  const p = state.player;
  const world = state.world;
  let best = null;
  const consider = (x, y, radius, data) => {
    const d = distance(p.x, p.y, x, y);
    if (d > radius) return;
    if (!best || d < best.d) best = { ...data, x, y, d };
  };
  if (world.id === 'overworld') {
    const sexton = world.npcs[0];
    if (sexton) consider(sexton.x, sexton.y, 38, { type: 'talk', label: 'Speak with the Sexton' });
    consider(world.props.church.x, world.props.church.y, 31, {
      type: 'church',
      label: state.quest.souls >= 3 ? 'Enter the sealed church' : 'Try the church door',
    });
  } else {
    consider(world.props.exit.x, world.props.exit.y, 20, { type: 'exit', label: 'Climb back to the churchyard' });
  }
  for (const object of world.objects) {
    if (object.type === 'grave') {
      if (object.state === 'restless') {
        consider(object.x, object.y, 28, { type: 'dig', label: 'Dig the restless grave', hold: 1.15, target: object });
      } else if (object.state === 'empty') {
        const canBury = p.remains > 0;
        consider(object.x, object.y, 25, {
          type: 'empty',
          label: canBury ? 'Bury the remains' : 'An empty plot. It needs remains.',
          hold: canBury ? 1.35 : 0,
          target: object,
        });
      } else if (object.state === 'full' || object.state === 'resting') {
        consider(object.x, object.y, 24, { type: 'read', label: object.state === 'resting' ? 'A soul at rest' : 'Read the headstone', target: object });
      }
    } else if (object.type === 'tree' && !object.chopped) {
      consider(object.x, object.y, 30, { type: 'chop', label: 'Chop for wood', hold: 1.2, target: object });
    } else if (object.type === 'rock' && !object.mined) {
      consider(object.x, object.y, 28, { type: 'mine', label: 'Mine for stone', hold: 1.1, target: object });
    } else if (object.type === 'chest' && !object.opened) {
      consider(object.x, object.y, 26, { type: 'chest', label: 'Open the chest', target: object });
    } else if (object.type === 'shrine') {
      consider(object.x, object.y, 34, { type: 'shrine', label: 'Consult the Keeper’s Stone' });
    } else if (object.type === 'brazier' && !object.lit) {
      consider(object.x, object.y, 29, { type: 'brazier', label: 'Light the sepulchral brazier', hold: 1.0, target: object });
    } else if (object.type === 'sign') {
      consider(object.x, object.y, 28, { type: 'sign', label: 'Read the sign', target: object });
    } else if (object.type === 'bench') {
      consider(object.x, object.y, 26, { type: 'bench', label: 'Rest a moment', target: object });
    } else if (object.type === 'statue') {
      consider(object.x, object.y, 28, { type: 'statue', label: 'Touch the weathered statue', target: object });
    }
  }
  for (const pickup of state.pickups) {
    if (pickup.type === 'relic') consider(pickup.x, pickup.y, 27, { type: 'relic', label: 'Claim the Relic of the Past', target: pickup });
  }
  return best;
}

function updateInteraction(dt) {
  const found = findInteraction();
  if (!found) {
    state.interaction = null;
    state.interactionProgress = 0;
    $('prompt').classList.add('hidden');
    return;
  }
  if (!state.interaction || state.interaction.type !== found.type || state.interaction.target !== found.target || state.interaction.label !== found.label) {
    state.interaction = found;
    state.interactionProgress = 0;
  }
  const prompt = $('prompt');
  prompt.classList.remove('hidden');
  $('prompt-text').textContent = found.label;
  const fill = $('prompt-progress');
  if (found.hold) {
    if (keys.has('KeyE')) {
      state.interactionProgress += dt / found.hold;
      if (state.interactionProgress >= 1) {
        state.interactionProgress = 0;
        performInteraction(found);
        pressed.delete('KeyE');
        return;
      }
    } else {
      state.interactionProgress = 0;
    }
    fill.style.width = `${clamp(state.interactionProgress, 0, 1) * 100}%`;
  } else {
    fill.style.width = '0%';
    if (pressed.has('KeyE')) {
      pressed.delete('KeyE');
      performInteraction(found);
    }
  }
}

function performInteraction(interaction) {
  if (!interaction) return;
  const type = interaction.type;
  if (type === 'talk') talkToSexton();
  else if (type === 'dig') digGrave(interaction.target);
  else if (type === 'empty') {
    if (state.player.remains > 0) buryRemains(interaction.target);
    else toast('The plot is empty. You need remains to bury.', 2200);
  } else if (type === 'read') toast(pick(EPITAPHS), 3200);
  else if (type === 'chop') chopTree(interaction.target);
  else if (type === 'mine') mineRock(interaction.target);
  else if (type === 'chest') openChest(interaction.target);
  else if (type === 'shrine') openOverlay('shrine-panel');
  else if (type === 'brazier') lightBrazier(interaction.target);
  else if (type === 'sign') toast(interaction.target.text, 3600);
  else if (type === 'bench') restAtBench();
  else if (type === 'statue') toast('The stone angel has no eyes left. You feel watched anyway.', 3200);
  else if (type === 'exit') exitDungeon();
  else if (type === 'church') enterChurch();
  else if (type === 'relic') claimRelic(interaction.target);
  state.interaction = null;
  state.interactionProgress = 0;
  $('prompt').classList.add('hidden');
  updateHud();
}

function digGrave(grave) {
  if (!grave || grave.state !== 'restless') return;
  const p = state.player;
  grave.state = 'dug';
  grave.solid = false;
  p.remains++;
  p.coins += 8;
  burst(grave.x, grave.y - 4, '#6b5337', 14, 32, 0.7, 'dust');
  soulBurst(grave.x, grave.y - 10, 8);
  sfx('dig');
  addFloater(grave.x, grave.y - 20, '+remains', '#d9d3bc');
  addFloater(grave.x + 8, grave.y - 14, '+8', '#e7c978');
  toast('Remains gathered. Carry them to an empty plot.', 3000);
  updateObjective();
}

function buryRemains(grave) {
  if (!grave || grave.state !== 'empty' || state.player.remains <= 0) return;
  const p = state.player;
  grave.state = 'resting';
  grave.solid = true;
  p.remains--;
  p.souls++;
  p.coins += 14;
  state.quest.souls = p.souls;
  state.world.lights.push({
    x: grave.x,
    y: grave.y - 14,
    radius: 46,
    color: '#e7c978',
    flicker: 0.14,
    phase: Math.random() * 6,
  });
  soulBurst(grave.x, grave.y - 10, 22);
  burst(grave.x, grave.y - 4, '#6b5337', 12, 26, 0.7, 'dust');
  sfx('bury');
  addFloater(grave.x, grave.y - 22, '+14', '#e7c978');
  toast(`A soul finds rest. ${p.souls} of 3.`, 3200, true);
  updateQuest();
  updateObjective();
}

function chopTree(tree) {
  if (!tree || tree.chopped) return;
  const p = state.player;
  tree.chopped = true;
  tree.solid = false;
  p.wood += 3;
  burst(tree.x, tree.y - 14, '#6f5531', 13, 34, 0.7, 'leaf');
  sfx('dig');
  addFloater(tree.x, tree.y - 20, '+3 wood', '#c9a26a');
  toast('Three good lengths of wood.', 2100);
  updateHud();
}

function mineRock(rock) {
  if (!rock || rock.mined) return;
  const p = state.player;
  rock.mined = true;
  rock.solid = false;
  p.stone += 3;
  burst(rock.x, rock.y - 6, '#8e8f92', 12, 30, 0.6, 'spark');
  sfx('dig');
  addFloater(rock.x, rock.y - 16, '+3 stone', '#c4c5c0');
  toast('Three good pieces of stone.', 2100);
  updateHud();
}

function openChest(chest) {
  if (!chest || chest.opened) return;
  chest.opened = true;
  state.player.coins += chest.coins;
  sfx('open');
  sfx('coin');
  burst(chest.x, chest.y - 8, '#e7c978', 16, 34, 0.8, 'spark');
  addFloater(chest.x, chest.y - 20, `+${chest.coins}`, '#e7c978');
  toast(`A tin box of coins. +${chest.coins}.`, 2300, true);
  updateHud();
}

function lightBrazier(brazier) {
  if (!brazier || brazier.lit) return;
  brazier.lit = true;
  state.quest.braziers = countLitBraziers(state.world);
  state.world.lights.push({
    x: brazier.x,
    y: brazier.y - 14,
    radius: 82,
    color: '#f2c879',
    flicker: 0.16,
    phase: Math.random() * 6,
  });
  sfx('brazier');
  camera.shake = 4;
  soulBurst(brazier.x, brazier.y - 16, 16);
  const waves = {
    'brazier-left': [['wisp', 8, 13], ['ghoul', 7, 17]],
    'brazier-right': [['wisp', 32, 13], ['ghoul', 33, 17]],
    'brazier-hall': [['skeleton', 17, 16], ['skeleton', 23, 16]],
  };
  for (const [type, tx, ty] of waves[brazier.id] || []) spawnEnemy(type, tx, ty);
  toast(`Brazier lit. ${state.quest.braziers} of 3.`, 2600, true);
  updateQuest();
  updateObjective();
}

function restAtBench() {
  const p = state.player;
  if (p.hp >= p.maxHp) {
    toast('The bench is cold. The rest is still welcome.', 2200);
    return;
  }
  p.hp = Math.min(p.maxHp, p.hp + 1);
  sfx('heal');
  soulBurst(p.x, p.y - 10, 8);
  toast('A moment’s rest. One heart returns.', 2200);
  updateHud();
}

function talkToSexton() {
  const q = state.quest;
  let lines;
  let onEnd = null;
  if (q.stage === 'wake') {
    lines = [
      'Ah. The new keeper. I was beginning to think the parish had been left to the crows.',
      'Three souls here will not sleep. Their graves were disturbed when the crypt below cracked open.',
      'Dig them up. Carry what remains to the empty plots, and give them proper earth.',
      'Lay all three to rest, and the church seal will yield. Then we shall see what the dark has kept.',
    ];
    onEnd = () => {
      q.stage = 'gather';
      q.talked = true;
      showLocation('THE VIGIL BEGINS', 'THREE SOULS AWAIT');
      toast('Follow the golden wisps. E digs and buries.', 3800, true);
      updateObjective();
    };
  } else if (q.stage === 'gather') {
    lines = [
      `${q.souls} of three are resting. The wisps will lead you to the others.`,
      'An empty plot needs remains. A restless grave needs a shovel. The Keeper’s Stone may hone your blade, if you have the coin.',
    ];
  } else if (q.stage === 'crypt') {
    lines = [
      'The seal is broken. The church door stands open.',
      'Below is the Sunken Ossuary. Light the three sepulchral braziers, and the Warden will come to you.',
      'It has been waiting a very long time.',
    ];
  } else if (q.stage === 'braziers' || q.stage === 'boss') {
    lines = [
      'The braziers below are cold. Light them, keeper. But do not linger in the dark.',
      'If the Warden wakes, do not meet its stare. Meet its ribs with your blade.',
    ];
  } else if (q.stage === 'relic') {
    lines = [
      'The bell is quiet. That is either mercy or a warning.',
      'Take the relic. It belongs to the living now.',
    ];
  } else {
    lines = ['The bell is quiet. The graves are tended. Rest, keeper. You have earned it.'];
  }
  startDialogue(lines, { onEnd });
}

function startDialogue(lines, options = {}) {
  if (!lines || !lines.length) return;
  state.dialogue = {
    lines,
    index: 0,
    reveal: 0,
    speaker: options.speaker || 'The Sexton',
    title: options.title || 'KEEPER OF THE QUIET BELL',
    onEnd: options.onEnd || null,
  };
  keys.clear();
  $('prompt').classList.add('hidden');
  $('dialogue').classList.remove('hidden');
  $('dialogue-name').textContent = state.dialogue.speaker;
  $('dialogue-title').textContent = state.dialogue.title;
  renderDialogue();
  sfx('talk');
}

function renderDialogue() {
  const dialogue = state.dialogue;
  if (!dialogue) return;
  const line = dialogue.lines[dialogue.index] || '';
  const visible = line.slice(0, Math.floor(dialogue.reveal));
  $('dialogue-text').textContent = visible;
  const complete = dialogue.reveal >= line.length;
  $('dialogue-hint').innerHTML = complete
    ? (dialogue.index >= dialogue.lines.length - 1 ? 'Press <kbd>E</kbd> to close' : 'Press <kbd>E</kbd> to continue')
    : 'Press <kbd>E</kbd> to reveal';
}

function updateDialogue(dt) {
  const dialogue = state.dialogue;
  if (!dialogue) return;
  const line = dialogue.lines[dialogue.index] || '';
  if (dialogue.reveal < line.length) {
    dialogue.reveal = Math.min(line.length, dialogue.reveal + dt * 44);
    renderDialogue();
  }
}

function advanceDialogue() {
  const dialogue = state.dialogue;
  if (!dialogue) return;
  const line = dialogue.lines[dialogue.index] || '';
  if (dialogue.reveal < line.length) {
    dialogue.reveal = line.length;
    renderDialogue();
    return;
  }
  dialogue.index++;
  if (dialogue.index >= dialogue.lines.length) {
    const onEnd = dialogue.onEnd;
    state.dialogue = null;
    $('dialogue').classList.add('hidden');
    if (onEnd) onEnd();
    updateHud();
    return;
  }
  dialogue.reveal = 0;
  sfx('talk');
  renderDialogue();
}

function enterChurch() {
  if (state.quest.souls < 3) {
    toast('The seal is cold. Three souls still wander.', 2800);
    tone(120, 0.2, 'sine', 0.06, -30);
    return;
  }
  if (state.world.id !== 'overworld') return;
  if (state.quest.stage === 'crypt') state.quest.stage = 'braziers';
  changeWorld(state.dungeon, state.dungeon.spawn, {
    location: ['THE SUNKEN OSSUARY', 'BENEATH THE QUIET BELL'],
    after: () => {
      if (state.quest.stage === 'braziers') {
        toast('Light the three sepulchral braziers.', 3400, true);
      }
    },
  });
}

function exitDungeon() {
  if (state.world.id !== 'dungeon') return;
  changeWorld(state.overworld, state.overworld.returnPoint, {
    location: ['HOLLOWMERE CEMETERY', 'THE NIGHT AIR TASTES SWEET'],
  });
}

function changeWorld(world, spawn, options = {}) {
  if (state.transitioning) return;
  state.transitioning = true;
  state.mode = 'transition';
  keys.clear();
  $('prompt').classList.add('hidden');
  $('fade').classList.add('opaque');
  const token = ++state.transitionToken;
  setTimeout(() => {
    if (token !== state.transitionToken) return;
    state.world = world;
    const p = state.player;
    p.x = spawn.x;
    p.y = spawn.y;
    p.dirX = 0;
    p.dirY = -1;
    p.invuln = Math.max(p.invuln, 1);
    state.enemies = [];
    state.projectiles = [];
    state.interaction = null;
    state.interactionProgress = 0;
    if (world.id === 'dungeon') {
      if (state.quest.stage === 'crypt') state.quest.stage = 'braziers';
      spawnDungeonEnemies();
      if (state.quest.braziers >= 3 && state.quest.stage === 'boss' && !state.quest.bossDown) spawnBoss();
    } else {
      state.dungeonSpawned = false;
      state.bossActive = false;
      state.boss = null;
      $('boss-hud').classList.add('hidden');
    }
    state.mode = 'playing';
    state.transitioning = false;
    snapCamera();
    $('fade').classList.remove('opaque');
    if (options.location) showLocation(options.location[0], options.location[1]);
    if (options.after) options.after();
    updateHud();
    updateObjective();
  }, 330);
}

function claimRelic(pickup) {
  const index = state.pickups.indexOf(pickup);
  if (index >= 0) state.pickups.splice(index, 1);
  state.quest.relic = true;
  state.quest.stage = 'done';
  winGame();
}

function winGame() {
  state.mode = 'victory';
  keys.clear();
  $('prompt').classList.add('hidden');
  $('victory-panel').classList.remove('hidden');
  $('victory-time').textContent = formatTime(state.time - state.startTime);
  $('victory-souls').textContent = String(state.quest.souls);
  $('victory-kills').textContent = String(state.kills);
  $('boss-hud').classList.add('hidden');
  sfx('victory');
}

function keepPlaying() {
  $('victory-panel').classList.add('hidden');
  state.mode = 'playing';
  state.quest.stage = 'done';
  showLocation('THE PARISH IS QUIET', 'WANDER AS LONG AS YOU LIKE');
  updateObjective();
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function ensureHearts() {
  const row = $('hearts');
  if (row.childElementCount !== 5) {
    row.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const heart = document.createElement('i');
      heart.className = 'heart';
      row.appendChild(heart);
    }
  }
}

function updateHud() {
  if (!state.player) return;
  const p = state.player;
  ensureHearts();
  const hearts = $('hearts').children;
  for (let i = 0; i < hearts.length; i++) hearts[i].classList.toggle('empty', i >= p.hp);
  $('coin-count').textContent = String(p.coins);
  $('remains-count').textContent = String(p.remains);
  $('wood-count').textContent = String(p.wood);
  $('stone-count').textContent = String(p.stone);
  const bossHud = $('boss-hud');
  if (state.bossActive && state.boss && !state.boss.dead) {
    bossHud.classList.remove('hidden');
    $('boss-value').textContent = String(Math.max(0, Math.ceil(state.boss.hp)));
    $('boss-fill').style.width = `${clamp(state.boss.hp / state.boss.maxHp, 0, 1) * 100}%`;
  } else {
    bossHud.classList.add('hidden');
  }
  updateObjective();
}

function updateObjective() {
  const q = state.quest;
  let text = 'Speak with the Sexton.';
  let fill = 0.04;
  if (q.stage === 'wake') {
    text = 'Find the Sexton at the church gate.';
    fill = 0.05;
  } else if (q.stage === 'gather') {
    text = `Lay three souls to rest. (${q.souls} / 3)`;
    fill = q.souls / 3;
  } else if (q.stage === 'crypt') {
    text = 'Enter the sealed church.';
    fill = 0.78;
  } else if (q.stage === 'braziers') {
    text = state.world.id === 'dungeon'
      ? `Light the sepulchral braziers. (${q.braziers} / 3)`
      : 'Return to the church and descend.';
    fill = q.braziers / 3;
  } else if (q.stage === 'boss') {
    text = 'Defeat the Hollow Warden.';
    fill = 0.9;
  } else if (q.stage === 'relic') {
    text = 'Claim the Relic of the Past.';
    fill = 0.97;
  } else if (q.stage === 'done') {
    text = 'The parish is quiet. Wander as long as you like.';
    fill = 1;
  }
  $('objective-text').textContent = text;
  $('objective-fill').style.width = `${clamp(fill, 0, 1) * 100}%`;
  $('minimap-label').textContent = state.world && state.world.id === 'dungeon' ? 'THE OSSUARY' : 'HOLLOWMERE';
}

function openOverlay(id, returnTo = null) {
  if (!id) return;
  if (state.overlay && state.overlay !== id) $(state.overlay).classList.add('hidden');
  state.overlay = id;
  state.overlayReturn = returnTo;
  state.paused = true;
  keys.clear();
  pressed.clear();
  $('prompt').classList.add('hidden');
  $(id).classList.remove('hidden');
  if (id === 'pause-panel') updatePauseStats();
  if (id === 'shrine-panel') updateShrinePanel();
  if (id === 'map-panel') drawBigMap();
  sfx('click');
}

function closeOverlay(id = state.overlay) {
  if (!id) return;
  $(id).classList.add('hidden');
  if (state.overlay === id) state.overlay = null;
  const returnTo = state.overlayReturn;
  state.overlayReturn = null;
  if (returnTo) {
    openOverlay(returnTo);
    return;
  }
  state.paused = false;
  keys.clear();
  pressed.clear();
  updateHud();
}

function togglePause() {
  if (state.mode !== 'playing' || state.dialogue) return;
  if (state.overlay === 'pause-panel') closeOverlay('pause-panel');
  else if (!state.overlay) openOverlay('pause-panel');
}

function updatePauseStats() {
  $('pause-souls').textContent = `${state.quest.souls} / 3`;
  $('pause-braziers').textContent = `${state.quest.braziers} / 3`;
  $('pause-coins').textContent = String(state.player.coins);
}

function updateShrinePanel() {
  const p = state.player;
  $('shrine-coins').textContent = String(p.coins);
  $('shrine-wood').textContent = String(p.wood);
  $('shrine-stone').textContent = String(p.stone);
  for (const [kind, data] of Object.entries(UPGRADES)) {
    const button = document.querySelector(`.upgrade[data-upgrade="${kind}"]`);
    if (!button) continue;
    const owned = kind === 'blade' ? p.blade > 1 : p.lantern > 1;
    button.classList.toggle('owned', owned);
    button.disabled = owned || p.coins < data.coins || p.wood < data.wood || p.stone < data.stone;
  }
}

function purchaseUpgrade(kind) {
  const data = UPGRADES[kind];
  const p = state.player;
  if (!data) return;
  const owned = kind === 'blade' ? p.blade > 1 : p.lantern > 1;
  if (owned) return;
  if (p.coins < data.coins || p.wood < data.wood || p.stone < data.stone) {
    toast('The stone is not persuaded. Bring more.', 2200);
    return;
  }
  p.coins -= data.coins;
  p.wood -= data.wood;
  p.stone -= data.stone;
  if (kind === 'blade') p.blade = 2;
  else p.lantern = 2;
  sfx('heal');
  burst(p.x, p.y - 12, '#8fd0c6', 18, 30, 0.8, 'soul');
  toast(kind === 'blade' ? 'The blade drinks the light. +7 damage.' : 'The lantern opens its eye. The dark recedes.', 3000, true);
  updateShrinePanel();
  updateHud();
}

function toggleMute() {
  setMuted(!muted);
  if (!muted) {
    initAudio();
    if (ac && ac.state === 'suspended') ac.resume();
    startAmbient();
  }
}

function bindEvents() {
  addEventListener('resize', resize);
  addEventListener('keydown', (event) => {
    const code = event.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(code)) event.preventDefault();
    if (event.repeat) return;
    keys.add(code);
    pressed.add(code);
    if (state.dialogue) {
      if (code === 'KeyE' || code === 'Space' || code === 'Enter') {
        event.preventDefault();
        keys.delete(code);
        pressed.delete(code);
        advanceDialogue();
      }
      return;
    }
    if (state.overlay) {
      if (code === 'Escape') {
        event.preventDefault();
        closeOverlay(state.overlay);
      }
      return;
    }
    if (state.mode === 'title') {
      if (code === 'Enter') {
        event.preventDefault();
        startRun();
      } else if (code === 'KeyH') {
        openOverlay('help-panel');
      }
      return;
    }
    if (state.mode === 'dead') {
      if (code === 'Enter' || code === 'KeyE' || code === 'Space') {
        event.preventDefault();
        keys.delete(code);
        pressed.delete(code);
        rise();
      }
      return;
    }
    if (state.mode === 'victory') {
      if (code === 'Enter') {
        event.preventDefault();
        keepPlaying();
      }
      return;
    }
    if (state.mode !== 'playing') return;
    if (code === 'Escape' || code === 'KeyP') {
      event.preventDefault();
      togglePause();
    } else if (code === 'KeyM') {
      openOverlay('map-panel');
    } else if (code === 'KeyH') {
      openOverlay('help-panel');
    } else if (code === 'KeyF') {
      toggleMute();
    } else if (code === 'Space' || code === 'KeyJ') {
      event.preventDefault();
      playerAttack();
    } else if (code === 'ShiftLeft' || code === 'ShiftRight') {
      startDash();
    }
  });
  addEventListener('keyup', (event) => keys.delete(event.code));
  addEventListener('blur', () => {
    keys.clear();
    pressed.clear();
    if (state.mode === 'playing' && !state.overlay && !state.dialogue) openOverlay('pause-panel');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.mode === 'playing' && !state.overlay && !state.dialogue) openOverlay('pause-panel');
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button === 0) {
      initAudio();
      if (ac && ac.state === 'suspended') ac.resume();
      playerAttack();
    }
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  $('begin-button').addEventListener('click', () => {
    initAudio();
    startRun();
  });
  $('help-open').addEventListener('click', () => openOverlay('help-panel'));
  $('dialogue-next').addEventListener('click', advanceDialogue);
  $('resume-button').addEventListener('click', () => closeOverlay('pause-panel'));
  $('restart-button').addEventListener('click', () => {
    closeOverlay('pause-panel');
    newRun();
  });
  $('pause-help').addEventListener('click', () => openOverlay('help-panel', 'pause-panel'));
  $('rise-button').addEventListener('click', rise);
  $('keep-playing').addEventListener('click', keepPlaying);
  $('play-again').addEventListener('click', () => {
    $('victory-panel').classList.add('hidden');
    newRun();
  });
  $('sound-toggle').addEventListener('click', toggleMute);
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeOverlay(button.dataset.close));
  });
  document.querySelectorAll('.upgrade').forEach((button) => {
    button.addEventListener('click', () => purchaseUpgrade(button.dataset.upgrade));
  });
}

let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
  lastFrame = now;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

function update(dt) {
  state.time += dt;
  if (state.mode !== 'title' && !state.paused) {
    updateParticles(dt);
    updateFloaters(dt);
  }
  updateCamera(dt);
  if (state.dialogue) {
    updateDialogue(dt);
    pressed.clear();
    return;
  }
  if (state.mode === 'title') {
    pressed.clear();
    return;
  }
  if (state.mode === 'dead' || state.mode === 'victory' || state.mode === 'transition') {
    pressed.clear();
    return;
  }
  if (state.paused) {
    pressed.clear();
    return;
  }
  if (state.hitstop > 0) {
    state.hitstop -= dt;
    pressed.clear();
    return;
  }
  updatePlayer(dt);
  updateInteraction(dt);
  updateEnemies(dt);
  updateProjectiles(dt);
  updatePickups(dt);
  updateQuest();
  pressed.clear();
}

bindEvents();
resize();
resetGame();
requestAnimationFrame(loop);
