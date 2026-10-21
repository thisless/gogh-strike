export const TILE = 16;
export const T = Object.freeze({
  GRASS: 0, MEADOW: 1, PATH: 2, DIRT: 3, WATER: 4, STONE: 5,
  WALL: 6, FLOOR: 7, BRIDGE: 8, MOSS: 9, VOID: 10,
});
const SOLID_TILES = new Set([T.WATER, T.WALL, T.VOID]);

export function createRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tileIndex(world, tx, ty) {
  return ty * world.w + tx;
}

export function getTile(world, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return T.VOID;
  return world.tiles[ty * world.w + tx];
}

export function setTile(world, tx, ty, tile) {
  if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return;
  world.tiles[ty * world.w + tx] = tile;
}

export function isSolidTile(tile) {
  return SOLID_TILES.has(tile);
}

export function solidRect(object) {
  if (!object || !object.solid) return null;
  const w = object.bw ?? (object.type === 'tree' ? 8 : object.type === 'fence' ? 15 : object.w ?? 10);
  const h = object.bh ?? (object.type === 'tree' ? 7 : object.type === 'fence' ? 5 : object.h ?? 6);
  if (object.type === 'church' || object.type === 'house' || object.type === 'mausoleum') {
    return { x: object.x - object.w / 2, y: object.y - object.h, w: object.w, h: object.h };
  }
  return { x: object.x - w / 2, y: object.y - h, w, h };
}

export function isBlocked(world, x, y, radius = 5) {
  const points = [
    [x - radius, y - 1], [x + radius, y - 1], [x, y - 2], [x, y + 1],
  ];
  for (const [px, py] of points) {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    if (isSolidTile(getTile(world, tx, ty))) return true;
  }
  const left = x - radius, right = x + radius, top = y - 5, bottom = y + 2;
  for (const object of world.objects) {
    const r = solidRect(object);
    if (!r) continue;
    if (right > r.x && left < r.x + r.w && bottom > r.y && top < r.y + r.h) return true;
  }
  return false;
}

export function moveEntity(world, entity, dx, dy, radius = 5) {
  let moved = false;
  if (dx) {
    const nx = entity.x + dx;
    if (!isBlocked(world, nx, entity.y, radius)) { entity.x = nx; moved = true; }
  }
  if (dy) {
    const ny = entity.y + dy;
    if (!isBlocked(world, entity.x, ny, radius)) { entity.y = ny; moved = true; }
  }
  return moved;
}

export function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

export function inSwordArc(ax, ay, dx, dy, tx, ty, range = 24, arc = 0.2) {
  const vx = tx - ax, vy = ty - ay;
  const length = Math.hypot(vx, vy);
  if (length > range || length < 0.001) return false;
  const facing = Math.hypot(dx, dy) || 1;
  const dot = (vx / length) * (dx / facing) + (vy / length) * (dy / facing);
  return dot >= arc;
}

function createBaseWorld(id, name, w, h, seed) {
  return {
    id, name, w, h,
    tiles: new Uint8Array(w * h).fill(T.GRASS),
    objects: [], decor: [], lights: [], npcs: [], props: {},
    seed, ambient: 0.42,
  };
}

function rect(world, x0, y0, x1, y1, tile) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setTile(world, x, y, tile);
}

function disc(world, cx, cy, rx, ry, tile) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) setTile(world, x, y, tile);
    }
  }
}

function pathLine(world, x0, y0, x1, y1, radius, tile = T.PATH) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (Math.hypot(x - cx, y - cy) <= radius + 0.2) setTile(world, x, y, tile);
      }
    }
  }
}

function addObject(world, type, x, y, props = {}) {
  const object = {
    id: `${world.id}-${world.objects.length + 1}`,
    type, x, y,
    ...props,
  };
  world.objects.push(object);
  return object;
}

function addDecor(world, type, x, y, props = {}) {
  world.decor.push({ type, x, y, ...props });
}

function addLight(world, x, y, radius, color, flicker = 0.08) {
  world.lights.push({ x, y, radius, color, flicker, phase: world.lights.length * 1.73 });
}

function groundObject(world, type, tx, ty, props = {}) {
  return addObject(world, type, (tx + 0.5) * TILE, (ty + 0.92) * TILE, props);
}

export function createOverworld(seed = 1107) {
  const world = createBaseWorld('overworld', 'Hollowmere Cemetery', 64, 44, seed);
  const rng = createRng(seed);
  world.ambient = 0.4;

  rect(world, 0, 0, world.w - 1, world.h - 1, T.GRASS);
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      const n = rng();
      if (n > 0.84) setTile(world, x, y, T.MEADOW);
      if (n < 0.018 && x > 2 && x < world.w - 3 && y > 2 && y < world.h - 3) setTile(world, x, y, T.MOSS);
    }
  }

  disc(world, 11.5, 37, 6.4, 4.8, T.WATER);
  disc(world, 15.5, 35.5, 3.4, 3.2, T.WATER);
  for (let x = 5; x <= 20; x++) for (let y = 37; y <= 38; y++) {
    if (getTile(world, x, y) === T.WATER) setTile(world, x, y, T.BRIDGE);
  }

  pathLine(world, 34, 43, 33, 36, 2.2);
  pathLine(world, 33, 36, 35, 30, 2.1);
  pathLine(world, 35, 30, 34, 24, 2.1);
  pathLine(world, 34, 24, 33, 18, 2.0);
  pathLine(world, 33, 18, 34, 13, 2.1);
  pathLine(world, 33, 22, 17, 22, 1.45);
  pathLine(world, 35, 26.5, 51, 26.5, 1.45);
  pathLine(world, 35, 32, 58, 32, 1.45);
  pathLine(world, 52, 32, 52, 24, 1.3);
  pathLine(world, 34, 42, 26, 43, 1.4);
  pathLine(world, 34, 42, 44, 43, 1.4);

  rect(world, 27, 4, 40, 12, T.STONE);
  rect(world, 30, 5, 37, 11, T.FLOOR);
  for (let x = 29; x <= 38; x++) {
    if (getTile(world, x, 12) === T.STONE) setTile(world, x, 12, T.PATH);
  }

  for (let x = 43; x <= 59; x++) for (let y = 34; y <= 42; y++) {
    if (rng() > 0.8) setTile(world, x, y, T.PATH);
  }

  const graves = [
    [10, 16], [14, 16], [18, 16], [22, 16],
    [10, 20], [14, 20], [18, 20], [22, 20],
    [10, 24], [14, 24], [18, 24], [22, 24],
    [46, 16], [50, 16], [54, 16],
    [46, 20], [50, 20], [54, 20],
    [46, 24], [50, 24], [54, 24],
    [13, 27], [20, 28], [48, 28],
  ];
  const restless = new Set(['14,20', '22,16', '50,24']);
  const empty = new Set(['10,24', '18,16', '46,20']);
  const kinds = ['headstone', 'cross', 'headstone', 'cracked', 'cross', 'headstone'];
  graves.forEach(([tx, ty], index) => {
    const key = `${tx},${ty}`;
    const state = restless.has(key) ? 'restless' : empty.has(key) ? 'empty' : 'full';
    rect(world, tx - 1, ty - 1, tx, ty, T.DIRT);
    groundObject(world, 'grave', tx, ty, {
      state, kind: kinds[index % kinds.length], solid: state !== 'empty',
      variant: Math.floor(rng() * 4), flowers: state === 'full' && rng() > 0.45,
    });
  });

  const treeSpots = [];
  for (let x = 1; x < world.w - 1; x += 2) {
    treeSpots.push([x + Math.floor(rng() * 2), 1 + Math.floor(rng() * 2)]);
    treeSpots.push([x + Math.floor(rng() * 2), world.h - 2 - Math.floor(rng() * 2)]);
  }
  for (let y = 3; y < world.h - 3; y += 2) {
    treeSpots.push([1 + Math.floor(rng() * 2), y + Math.floor(rng() * 2)]);
    treeSpots.push([world.w - 2 - Math.floor(rng() * 2), y + Math.floor(rng() * 2)]);
  }
  const clusters = [
    [5, 10], [5, 14], [7, 25], [4, 29], [22, 33], [24, 36], [27, 40],
    [42, 8], [46, 9], [57, 12], [60, 16], [60, 20], [60, 28], [57, 39],
    [42, 30], [40, 37], [24, 31], [8, 20],
  ];
  for (const [cx, cy] of clusters) {
    for (let i = 0; i < 3; i++) {
      treeSpots.push([cx + Math.floor(rng() * 4) - 2, cy + Math.floor(rng() * 4) - 2]);
    }
  }
  const occupied = new Set();
  for (const [tx, ty] of treeSpots) {
    if (tx < 2 || ty < 2 || tx >= world.w - 2 || ty >= world.h - 2) continue;
    if (getTile(world, tx, ty) !== T.GRASS && getTile(world, tx, ty) !== T.MEADOW && getTile(world, tx, ty) !== T.MOSS) continue;
    if (Math.abs(tx - 34) < 6 && ty > 12) continue;
    if (tx >= 26 && tx <= 41 && ty <= 14) continue;
    if (tx >= 5 && tx <= 21 && ty >= 31 && ty <= 42) continue;
    if (tx >= 42 && ty >= 34) continue;
    if (tx >= 8 && tx <= 23 && ty >= 14 && ty <= 29) continue;
    if (tx >= 44 && tx <= 56 && ty >= 14 && ty <= 29) continue;
    const key = `${tx},${ty}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    groundObject(world, 'tree', tx, ty, { variant: Math.floor(rng() * 5), solid: true });
  }

  groundObject(world, 'church', 34, 12.94, { w: 14 * TILE, h: 8 * TILE, solid: true });
  addLight(world, 34 * TILE, 8.3 * TILE, 105, '#e8b968', 0.04);
  addLight(world, 34 * TILE, 13.2 * TILE, 52, '#d9a95f', 0.08);

  groundObject(world, 'house', 47, 36.9, { w: 5 * TILE, h: 4 * TILE, solid: true, variant: 0 });
  groundObject(world, 'house', 54, 38.9, { w: 6 * TILE, h: 4 * TILE, solid: true, variant: 1 });
  groundObject(world, 'house', 58, 28.9, { w: 5 * TILE, h: 4 * TILE, solid: true, variant: 2 });
  groundObject(world, 'house', 43, 28.9, { w: 5 * TILE, h: 4 * TILE, solid: true, variant: 3 });
  groundObject(world, 'well', 51, 30.6, { solid: true });
  groundObject(world, 'market', 56, 33.4, { solid: false });
  addLight(world, 47 * TILE, 34.6 * TILE, 50, '#e4b06d', 0.12);
  addLight(world, 54 * TILE, 36.6 * TILE, 46, '#d8a15c', 0.1);

  const lanterns = [[31, 16], [37, 17], [30, 25], [38, 26], [33, 30], [29, 36], [39, 37], [34, 41]];
  lanterns.forEach(([tx, ty], i) => {
    groundObject(world, 'lantern', tx, ty, { solid: true, lit: true });
    addLight(world, (tx + 0.5) * TILE, (ty + 0.3) * TILE, i < 4 ? 58 : 48, '#f2c879', 0.16);
  });

  groundObject(world, 'shrine', 28, 21.4, { solid: true });
  addLight(world, 28.5 * TILE, 20.8 * TILE, 64, '#8fc6c3', 0.09);

  groundObject(world, 'sign', 35, 36.8, { solid: false, text: 'Hollowmere Cemetery — Rest, and be remembered.' });
  groundObject(world, 'sign', 33, 15.5, { solid: false, text: 'Church of the Quiet Bell. Sealed since the earth turned.' });
  groundObject(world, 'bench', 30, 17.8, { solid: true });
  groundObject(world, 'bench', 38, 17.8, { solid: true });
  groundObject(world, 'statue', 24, 18.2, { solid: true });

  const chests = [[8, 29], [58, 36], [22, 34], [41, 40]];
  chests.forEach(([tx, ty], i) => groundObject(world, 'chest', tx, ty, { solid: true, opened: false, coins: 18 + i * 9 }));

  const rocks = [[20, 30], [44, 30], [9, 29], [40, 34], [24, 27], [57, 23]];
  rocks.forEach(([tx, ty]) => groundObject(world, 'rock', tx, ty, { solid: true, variant: Math.floor(rng() * 3) }));

  const fences = [];
  for (let x = 26; x <= 30; x++) fences.push([x, 14]);
  for (let x = 38; x <= 42; x++) fences.push([x, 14]);
  for (let y = 15; y <= 18; y++) fences.push([25, y]);
  for (let y = 15; y <= 18; y++) fences.push([43, y]);
  fences.forEach(([tx, ty]) => groundObject(world, 'fence', tx, ty, { solid: true }));

  for (let i = 0; i < 130; i++) {
    const tx = 3 + Math.floor(rng() * (world.w - 6));
    const ty = 3 + Math.floor(rng() * (world.h - 6));
    const tile = getTile(world, tx, ty);
    if (tile !== T.GRASS && tile !== T.MEADOW && tile !== T.MOSS) continue;
    addDecor(world, rng() > 0.72 ? 'flowers' : 'tuft', (tx + rng()) * TILE, (ty + rng()) * TILE, {
      color: ['#b78aa6', '#d9c36f', '#9db4c7', '#b9d28f'][Math.floor(rng() * 4)],
      variant: Math.floor(rng() * 3),
    });
  }
  for (let i = 0; i < 22; i++) {
    const tx = 8 + Math.floor(rng() * 48), ty = 13 + Math.floor(rng() * 22);
    addDecor(world, 'bones', (tx + rng()) * TILE, (ty + rng()) * TILE, { variant: Math.floor(rng() * 3) });
  }
  addDecor(world, 'shovel', 32.4 * TILE, 20.2 * TILE, {});

  world.props.church = { x: 34 * TILE, y: 13.15 * TILE };
  world.props.shrine = { x: 28.5 * TILE, y: 21.4 * TILE };
  world.props.sexton = { x: 34 * TILE, y: 16.6 * TILE };
  world.spawn = { x: 34 * TILE, y: 20.2 * TILE };
  world.titleCamera = { x: 34 * TILE - 86, y: 13 * TILE };
  world.npcs.push({ type: 'sexton', x: 34 * TILE, y: 16.6 * TILE, name: 'The Sexton', bob: 0 });
  world.returnPoint = { x: 34 * TILE, y: 14.2 * TILE };
  return world;
}

export function createDungeon(seed = 2209) {
  const world = createBaseWorld('dungeon', 'The Sunken Ossuary', 40, 32, seed);
  const rng = createRng(seed);
  world.ambient = 0.68;
  world.tiles.fill(T.WALL);
  rect(world, 16, 24, 24, 30, T.FLOOR);
  rect(world, 19, 20, 21, 24, T.FLOOR);
  rect(world, 12, 10, 28, 21, T.FLOOR);
  rect(world, 3, 12, 10, 19, T.FLOOR);
  rect(world, 10, 15, 12, 17, T.FLOOR);
  rect(world, 30, 12, 37, 19, T.FLOOR);
  rect(world, 28, 15, 30, 17, T.FLOOR);
  rect(world, 19, 9, 21, 10, T.FLOOR);
  rect(world, 12, 2, 28, 9, T.FLOOR);
  rect(world, 17, 24, 23, 29, T.MOSS);
  rect(world, 13, 11, 27, 20, T.MOSS);
  rect(world, 4, 13, 9, 18, T.MOSS);
  rect(world, 31, 13, 36, 18, T.MOSS);
  rect(world, 13, 3, 27, 8, T.MOSS);

  for (let i = 0; i < 28; i++) {
    const x = 13 + Math.floor(rng() * 14), y = 11 + Math.floor(rng() * 9);
    setTile(world, x, y, T.FLOOR);
  }
  for (let i = 0; i < 8; i++) {
    const x = 14 + Math.floor(rng() * 12), y = 3 + Math.floor(rng() * 5);
    if (rng() > 0.5) setTile(world, x, y, T.FLOOR);
  }

  const columns = [[14, 13], [26, 13], [14, 19], [26, 19], [16, 4], [24, 4]];
  columns.forEach(([tx, ty]) => groundObject(world, 'column', tx, ty, { solid: true }));

  groundObject(world, 'brazier', 6, 16, { solid: true, lit: false, id: 'brazier-left' });
  groundObject(world, 'brazier', 34, 16, { solid: true, lit: false, id: 'brazier-right' });
  groundObject(world, 'brazier', 20, 13, { solid: true, lit: false, id: 'brazier-hall' });
  groundObject(world, 'barrier', 20, 9.7, { solid: true, id: 'boss-barrier' });
  groundObject(world, 'ossuary', 20, 3.2, { solid: true });
  groundObject(world, 'ossuary', 8, 4.2, { solid: true, small: true });
  groundObject(world, 'ossuary', 32, 4.2, { solid: true, small: true });
  groundObject(world, 'bones-pile', 10, 18, { solid: false });
  groundObject(world, 'bones-pile', 30, 18, { solid: false });
  groundObject(world, 'bones-pile', 20, 8, { solid: false });

  for (const [tx, ty] of [[12, 6], [28, 6], [5, 13], [35, 13], [13, 17], [27, 17], [20, 25]]) {
    addLight(world, (tx + 0.5) * TILE, (ty + 0.2) * TILE, 52, '#7fc3bf', 0.13);
  }
  addLight(world, 20 * TILE, 4 * TILE, 96, '#a66b8f', 0.18);

  for (let i = 0; i < 38; i++) {
    const x = 3 + Math.floor(rng() * 34), y = 3 + Math.floor(rng() * 27);
    if (getTile(world, x, y) !== T.FLOOR && getTile(world, x, y) !== T.MOSS) continue;
    addDecor(world, rng() > 0.72 ? 'bones' : 'rubble', (x + rng()) * TILE, (y + rng()) * TILE, { variant: Math.floor(rng() * 3) });
  }

  world.props.braziers = ['brazier-left', 'brazier-right', 'brazier-hall'];
  world.props.barrier = { x: 20 * TILE, y: 9.7 * TILE };
  world.props.boss = { x: 20 * TILE, y: 5.2 * TILE };
  world.props.exit = { x: 20 * TILE, y: 29.65 * TILE };
  world.props.bossRoom = { x0: 12, y0: 2, x1: 28, y1: 9 };
  world.spawn = { x: 20 * TILE, y: 28.2 * TILE };
  world.returnPoint = { x: 34 * TILE, y: 14.2 * TILE };
  world.titleCamera = { x: 20 * TILE, y: 13 * TILE };
  return world;
}

export function nearestUnlitBrazier(world) {
  return world.objects.filter((o) => o.type === 'brazier' && !o.lit);
}

export function countLitBraziers(world) {
  return world.objects.filter((o) => o.type === 'brazier' && o.lit).length;
}

export function isBossBarrierOpen(world) {
  return countLitBraziers(world) >= 3;
}

export const UPGRADES = Object.freeze({
  blade: { name: 'Hone the Blade', coins: 25, wood: 0, stone: 8, description: 'A keener edge. +7 sword damage.' },
  lantern: { name: 'Trim the Lantern', coins: 20, wood: 4, stone: 0, description: 'A wider, warmer circle of light.' },
});
