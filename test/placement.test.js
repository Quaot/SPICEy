import { test } from 'node:test';
import assert from 'node:assert/strict';
import { place_by_click, reversed } from '../src/placement.js';

const wire = (id, x1, y1, x2, y2) => ({ id, type: 'wire', x1, y1, x2, y2 });
const ends = (placed) => [placed.x1, placed.y1, placed.x2, placed.y2];

// A rail along y = 0 from x = 0 to x = 8, with ground at (0, 4) under a source.
const rail = () => [
  { id: 's', type: 'source', x1: 0, y1: 4, x2: 0, y2: 0, wave: { shape: 'dc', value: 5 } },
  { id: 'g', type: 'ground', x1: 0, y1: 4, x2: 0, y2: 5 },
  wire('w', 0, 0, 8, 0),
];
const info = {
  node: (key) => (key === '0,4' ? 0 : 1),
  voltage: (key) => (key === '0,4' ? 0 : 5),
};

test('a click far from everything places nothing smart', () => {
  assert.equal(place_by_click(rail(), 'resistor', { x: 30, y: 30 }, info), null);
});

test('a resistor at the end of a wire carries the line on', () => {
  assert.deepEqual(ends(place_by_click(rail(), 'resistor', { x: 8, y: 0 }, info)), [8, 0, 12, 0]);
});

test('a click one point away still snaps to the end', () => {
  assert.deepEqual(ends(place_by_click(rail(), 'resistor', { x: 9, y: 1 }, info)), [8, 0, 12, 0]);
});

test('a capacitor hangs down from the rail', () => {
  assert.deepEqual(ends(place_by_click(rail(), 'capacitor', { x: 8, y: 0 }, info)), [8, 0, 8, 4]);
});

test('a click in the middle of a wire splits it there', () => {
  const placed = place_by_click(rail(), 'capacitor', { x: 4, y: 0 }, info);
  assert.deepEqual(ends(placed), [4, 0, 4, 4]);
  assert.equal(placed.split.id, 'w');
});

test('an LED from a positive point puts its anode there', () => {
  const placed = place_by_click(rail(), 'led', { x: 8, y: 0 }, info);
  assert.deepEqual(ends(placed), [8, 0, 8, 4]);   // x1 is the anode
});

test('an LED from a ground point points its cathode at ground', () => {
  const placed = place_by_click(rail(), 'led', { x: 0, y: 4 }, info);
  assert.equal(placed.x2, 0);
  assert.equal(placed.y2, 4);                     // cathode on the ground point
});

test('a source from the rail puts its positive end on the rail', () => {
  const placed = place_by_click(rail(), 'source', { x: 8, y: 0 }, info);
  assert.deepEqual([placed.x2, placed.y2], [8, 0]);
  assert.deepEqual([placed.x1, placed.y1], [8, 4]);
});

test('ground drops below a point and avoids parts in the way', () => {
  assert.deepEqual(ends(place_by_click(rail(), 'ground', { x: 8, y: 0 }, info)), [8, 0, 8, 1]);
});

test('a part never runs back over the wire it starts from', () => {
  const placed = place_by_click(rail(), 'inductor', { x: 0, y: 0 }, info);
  assert.notDeepEqual([placed.x2, placed.y2], [4, 0]);
});

test('reversing swaps the ends, and turns single-ended parts around', () => {
  assert.deepEqual(reversed({ type: 'diode', x1: 0, y1: 0, x2: 4, y2: 0 }), { x1: 4, y1: 0, x2: 0, y2: 0 });
  assert.deepEqual(reversed({ type: 'ground', x1: 2, y1: 2, x2: 2, y2: 3 }), { x2: 2, y2: 1 });
});
