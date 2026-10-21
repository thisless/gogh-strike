import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE, T, createOverworld, createDungeon, getTile, isBlocked, moveEntity,
  countLitBraziers, isBossBarrierOpen, UPGRADES, inSwordArc, distance,
} from '../src/grave-world.js';

test('Hollowmere is deterministic and starts with a complete tending loop', () => {
  const a = createOverworld();
  const b = createOverworld();
  assert.equal(a.w, 64);
  assert.equal(a.h, 44);
  assert.deepEqual([...a.tiles], [...b.tiles]);
  assert.deepEqual(
    a.objects.map((o) => [o.type, o.x, o.y, o.state ?? null]),
    b.objects.map((o) => [o.type, o.x, o.y, o.state ?? null]),
  );
  assert.equal(a.objects.filter((o) => o.type === 'grave' && o.state === 'restless').length, 3);
  assert.equal(a.objects.filter((o) => o.type === 'grave' && o.state === 'empty').length, 3);
  assert.equal(a.objects.filter((o) => o.type === 'brazier').length, 0);
  assert.equal(a.npcs[0].name, 'The Sexton');
  assert.equal(a.props.church.x, 34 * TILE);
  assert.equal(distance(a.spawn.x, a.spawn.y, a.npcs[0].x, a.npcs[0].y) > 38, true);
});

test('the churchyard spawn and every quest grave are reachable ground', () => {
  const world = createOverworld();
  assert.equal(isBlocked(world, world.spawn.x, world.spawn.y), false);
  assert.equal(isBlocked(world, world.returnPoint.x, world.returnPoint.y), false);
  for (const grave of world.objects.filter((o) => o.type === 'grave' && (o.state === 'restless' || o.state === 'empty'))) {
    assert.equal(isBlocked(world, grave.x, grave.y + 8), false);
  }
});

test('solid church geometry stops a keeper walking through the nave', () => {
  const world = createOverworld();
  const keeper = { x: world.props.church.x, y: world.props.church.y + 30 };
  const before = keeper.y;
  for (let i = 0; i < 80; i++) moveEntity(world, keeper, 0, -1, 5);
  assert.equal(keeper.y < before, true);
  assert.equal(keeper.y > world.props.church.y + 12, true);
});

test('the ossuary barrier opens only after all three braziers are lit', () => {
  const world = createDungeon();
  assert.equal(world.w, 40);
  assert.equal(world.h, 32);
  assert.equal(isBlocked(world, world.spawn.x, world.spawn.y), false);
  assert.equal(countLitBraziers(world), 0);
  assert.equal(isBossBarrierOpen(world), false);
  const braziers = world.objects.filter((o) => o.type === 'brazier');
  assert.equal(braziers.length, 3);
  braziers[0].lit = true;
  braziers[1].lit = true;
  assert.equal(countLitBraziers(world), 2);
  assert.equal(isBossBarrierOpen(world), false);
  braziers[2].lit = true;
  assert.equal(countLitBraziers(world), 3);
  assert.equal(isBossBarrierOpen(world), true);
  assert.notEqual(getTile(world, 20, 5), T.WALL);
});

test('the sword arc rewards facing and ignores targets behind the keeper', () => {
  assert.equal(inSwordArc(0, 0, 0, -1, 0, -20, 30, 0.2), true);
  assert.equal(inSwordArc(0, 0, 0, -1, 0, 20, 30, 0.2), false);
  assert.equal(inSwordArc(0, 0, 0, -1, 40, 0, 30, 0.2), false);
});

test('keeper upgrades are paid, finite, and materially distinct', () => {
  assert.deepEqual(Object.keys(UPGRADES).sort(), ['blade', 'lantern']);
  assert.equal(UPGRADES.blade.coins > 0 && UPGRADES.blade.stone > 0, true);
  assert.equal(UPGRADES.lantern.coins > 0 && UPGRADES.lantern.wood > 0, true);
  assert.notDeepEqual(UPGRADES.blade, UPGRADES.lantern);
});
