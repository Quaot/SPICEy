// Where a part goes when it is placed with a single click. A click on or next to an existing point starts the part
// there, pointing the way it most likely should, so its ends never need dragging into place.

import { part_points, point_key, adjust_point } from './netlist.js';

const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // right, down, left, up (y grows downward)
const series = new Set(['resistor', 'inductor', 'diode', 'switch', 'regulator']);
const shunt = new Set(['capacitor', 'led', 'source', 'current']);
const single = { ground: [0, 1], rail: [0, -1], logic: [0, -1] };

const length_of = (type) => (single[type] ? 1 : type === 'regulator' ? 6 : 4);

// Every straight piece of every part, in grid units, for the overlap tests.
function segments(parts) {
  const result = [];
  for (const part of parts) {
    result.push({ part, x1: part.x1, y1: part.y1, x2: part.x2, y2: part.y2 });
    if (part.type === 'regulator') {
      const [ax, ay] = adjust_point(part);
      result.push({ part, x1: (part.x1 + part.x2) / 2, y1: (part.y1 + part.y2) / 2, x2: ax, y2: ay });
    }
  }
  return result;
}

function on_segment(x, y, s) {
  const cross = (s.x2 - s.x1) * (y - s.y1) - (s.y2 - s.y1) * (x - s.x1);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (x - s.x1) * (s.x2 - s.x1) + (y - s.y1) * (s.y2 - s.y1);
  const length_squared = (s.x2 - s.x1) ** 2 + (s.y2 - s.y1) ** 2;
  return dot > 0 && dot < length_squared;   // strictly inside, not at an end
}

// The directions in which existing parts leave a point.
function leaving(parts, key) {
  const result = [];
  for (const part of parts) {
    const points = part_points(part);
    const index = points.indexOf(key);
    if (index < 0) continue;
    const [x, y] = key.split(',').map(Number);
    let to = index === 0 ? [part.x2, part.y2] : [part.x1, part.y1];
    if (part.type === 'regulator' && index === 2) to = [(part.x1 + part.x2) / 2, (part.y1 + part.y2) / 2];
    result.push([Math.sign(to[0] - x), Math.sign(to[1] - y)]);
  }
  return result;
}

function find_anchor(parts, point) {
  const ends = new Set(parts.flatMap((part) => part_points(part)));
  const exact = point_key(point.x, point.y);
  if (ends.has(exact)) return { x: point.x, y: point.y };
  for (const part of parts) {
    if (part.type === 'wire' && on_segment(point.x, point.y, part)) return { x: point.x, y: point.y, split: part };
  }
  let best = null;
  for (const key of ends) {
    const [x, y] = key.split(',').map(Number);
    const distance = Math.max(Math.abs(x - point.x), Math.abs(y - point.y));
    if (distance <= 1 && (!best || distance < best.distance)) best = { x, y, distance };
  }
  return best ? { x: best.x, y: best.y } : null;
}

// How bad it would be to run a new part from a to b.
function clash(parts, a, b) {
  let penalty = 0;
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const ends = new Set(parts.flatMap((part) => part_points(part)));
  const pieces = segments(parts);
  for (let i = 1; i <= steps; i++) {
    const x = a.x + Math.sign(b.x - a.x) * i, y = a.y + Math.sign(b.y - a.y) * i;
    const at_end = i === steps;
    if (ends.has(point_key(x, y))) penalty += at_end ? 2 : 10;   // landing on a point joins it; passing one looks joined
    if (pieces.some((s) => on_segment(x, y, s))) penalty += 10;  // runs along or across another part
  }
  return penalty;
}

// info.node(key) gives the node at a point (0 is ground), info.voltage(key) its voltage, both possibly undefined.
export function place_by_click(parts, type, point, info = {}) {
  const anchor = find_anchor(parts, point);
  if (!anchor) return null;
  const key = point_key(anchor.x, anchor.y);
  const taken = leaving(parts, key);
  const length = length_of(type);
  const is_taken = (d) => taken.some((t) => t[0] === d[0] && t[1] === d[1]);

  let best = null;
  for (const d of directions) {
    const far = { x: anchor.x + d[0] * length, y: anchor.y + d[1] * length };
    let score = -clash(parts, anchor, far);
    if (is_taken(d)) score -= 20;
    if (single[type]) {
      if (d[0] === single[type][0] && d[1] === single[type][1]) score += 4;
    } else if (series.has(type)) {
      // carry on a line that ends here, otherwise run to the right
      if (taken.length === 1 && d[0] === -taken[0][0] && d[1] === -taken[0][1]) score += 4;
      else if (d[0] === 1) score += 1;
    } else if (shunt.has(type)) {
      // shunt parts hang down toward ground, or up from a ground point
      const at_ground = info.node?.(key) === 0;
      if (at_ground ? d[1] === -1 : d[1] === 1) score += 4;
      else if (d[1] !== 0) score += 1;
    }
    if (!best || score > best.score) best = { d, far, score };
  }

  const far = best.far;
  let x1 = anchor.x, y1 = anchor.y, x2 = far.x, y2 = far.y;
  const at_ground = info.node?.(key) === 0;
  const below_ground = (info.voltage?.(key) ?? 0) < 0;
  // Which end belongs at the clicked point. A source's positive end is its second, a diode's anode its first.
  if (type === 'source' || type === 'current') {
    if (!at_ground) [x1, y1, x2, y2] = [x2, y2, x1, y1];
  } else if (type === 'diode' || type === 'led') {
    if (at_ground || below_ground) [x1, y1, x2, y2] = [x2, y2, x1, y1];
  }
  return { x1, y1, x2, y2, split: anchor.split || null, anchor };
}

// Turns a part around: its ends swap, or a single-ended part points the other way.
export function reversed(part) {
  if (single[part.type]) return { x2: 2 * part.x1 - part.x2, y2: 2 * part.y1 - part.y2 };
  return { x1: part.x2, y1: part.y2, x2: part.x1, y2: part.y1 };
}
