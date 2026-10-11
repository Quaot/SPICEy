import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulator, SolveError } from '../src/solver.js';
import { build_netlist, wire_currents } from '../src/netlist.js';
import { parse_value, format_value } from '../src/units.js';

const close = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);
const dc = (value) => ({ shape: 'dc', value });

test('units', () => {
  close(parse_value('4.7k'), 4700, 1e-9);
  close(parse_value('10u'), 10e-6, 1e-15);
  close(parse_value('1M'), 1e6, 1e-6);
  close(parse_value('1m'), 1e-3, 1e-15);
  close(parse_value('100n'), 100e-9, 1e-18);
  assert.ok(Number.isNaN(parse_value('abc')));
  assert.equal(format_value(4700, 'Ω'), '4.7 kΩ');
  assert.equal(format_value(0.0033, 'A'), '3.3 mA');
  assert.equal(format_value(1e-6, 'F'), '1 µF');
});

test('voltage divider', () => {
  const sim = new Simulator({ node_count: 3, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(10) },
    { id: 'r1', kind: 'R', a: 1, b: 2, resistance: 1000 },
    { id: 'r2', kind: 'R', a: 2, b: 0, resistance: 3000 },
  ] });
  sim.operating_point();
  close(sim.voltage(2), 7.5, 1e-6);
  close(sim.elements[1].current, 2.5e-3, 1e-9);
  close(sim.elements[0].current, -2.5e-3, 1e-9, 'source current flows a to b inside');
});

test('current source into resistor', () => {
  const sim = new Simulator({ node_count: 2, elements: [
    { id: 'i', kind: 'I', a: 0, b: 1, wave: dc(2e-3) },
    { id: 'r', kind: 'R', a: 1, b: 0, resistance: 1000 },
  ] });
  sim.operating_point();
  close(sim.voltage(1), 2, 1e-6);
});

test('RC charging follows 1 - exp(-t/RC)', () => {
  const sim = new Simulator({ node_count: 3, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(0) },
    { id: 'r', kind: 'R', a: 1, b: 2, resistance: 1000 },
    { id: 'c', kind: 'C', a: 2, b: 0, capacitance: 1e-6 },
  ] });
  sim.operating_point();
  sim.set_value('v', 'wave', dc(5));
  const dt = 1e-6;
  for (let i = 0; i < 1000; i++) sim.step(dt);
  close(sim.voltage(2), 5 * (1 - Math.exp(-1)), 5e-3);
  for (let i = 0; i < 4000; i++) sim.step(dt);
  close(sim.voltage(2), 5 * (1 - Math.exp(-5)), 5e-3);
});

test('RL current rises with time constant L/R', () => {
  const sim = new Simulator({ node_count: 3, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(0) },
    { id: 'r', kind: 'R', a: 1, b: 2, resistance: 100 },
    { id: 'l', kind: 'L', a: 2, b: 0, inductance: 10e-3 },
  ] });
  sim.operating_point();
  sim.set_value('v', 'wave', dc(1));
  for (let i = 0; i < 1000; i++) sim.step(1e-7);
  close(sim.elements[2].current, 0.01 * (1 - Math.exp(-1)), 2e-5);
});

test('LC tank rings at 1/(2π√LC) and keeps its amplitude', () => {
  const L = 1e-3, C = 1e-6;
  const sim = new Simulator({ node_count: 2, elements: [
    { id: 'c', kind: 'C', a: 1, b: 0, capacitance: C },
    { id: 'l', kind: 'L', a: 1, b: 0, inductance: L },
  ] });
  sim.operating_point();
  // start with the capacitor at 1 V and no current
  sim.elements[0].v_prev = 1;
  sim.elements[0].i_prev = 0;
  sim.elements[1].i_prev = 0;
  sim.elements[1].v_prev = 1;
  sim.euler_steps = 0;
  const period = 2 * Math.PI * Math.sqrt(L * C);
  const dt = period / 400;
  const crossings = [];
  let previous = 1;
  let peak = 0;
  for (let i = 0; i < 4000; i++) {
    sim.step(dt);
    const v = sim.voltage(1);
    if (previous > 0 && v <= 0) crossings.push(sim.time);
    peak = Math.max(peak, Math.abs(v));
    previous = v;
  }
  const measured = (crossings.at(-1) - crossings[0]) / (crossings.length - 1);
  close(measured, period, period * 0.005);
  close(peak, 1, 0.01);
});

test('diode forward drop near 0.65 V at about 4 mA', () => {
  const sim = new Simulator({ node_count: 3, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(5) },
    { id: 'r', kind: 'R', a: 1, b: 2, resistance: 1000 },
    { id: 'd', kind: 'D', a: 2, b: 0 },
  ] });
  sim.operating_point();
  const vd = sim.voltage(2);
  const id = sim.elements[2].current;
  close(id, (5 - vd) / 1000, 1e-7, 'KCL');
  assert.ok(vd > 0.6 && vd < 0.72, `drop ${vd}`);
});

test('reverse diode blocks', () => {
  const sim = new Simulator({ node_count: 3, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(-5) },
    { id: 'r', kind: 'R', a: 1, b: 2, resistance: 1000 },
    { id: 'd', kind: 'D', a: 2, b: 0 },
  ] });
  sim.operating_point();
  close(sim.voltage(2), -5, 1e-6);
});

test('half-wave rectifier passes only the positive half', () => {
  const sim = new Simulator({ node_count: 3, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: { shape: 'sine', offset: 0, amplitude: 5, frequency: 50 } },
    { id: 'd', kind: 'D', a: 1, b: 2 },
    { id: 'r', kind: 'R', a: 2, b: 0, resistance: 1000 },
  ] });
  sim.operating_point();
  let high = -Infinity, low = Infinity;
  for (let i = 0; i < 2000; i++) {
    sim.step(1e-5);
    high = Math.max(high, sim.voltage(2));
    low = Math.min(low, sim.voltage(2));
  }
  assert.ok(high > 4.2 && high < 4.5, `peak ${high}`);
  assert.ok(low > -1e-6, `lowest ${low}`);
});

test('shorted source is reported', () => {
  const sim = new Simulator({ node_count: 2, elements: [
    { id: 'v1', kind: 'V', a: 1, b: 0, wave: dc(5) },
    { id: 'v2', kind: 'V', a: 1, b: 0, wave: dc(3) },
  ] });
  assert.throws(() => sim.operating_point(), SolveError);
});

// A 4-bit R-2R ladder like the one on the portfolio: 10k and 20k, 3.3 V logic, Vout = 3.3 × code / 16.
function ladder(code) {
  const parts = [];
  let id = 0;
  const part = (type, x1, y1, x2, y2, extra = {}) => parts.push({ id: `p${id++}`, type, x1, y1, x2, y2, ...extra });
  part('ground', 0, 10, 0, 11);
  part('resistor', 0, 10, 0, 0, { resistance: 20e3 });
  for (let bit = 0; bit < 4; bit++) {
    part('resistor', bit, 0, bit, -10, { resistance: 20e3 });
    part('logic', bit, -10, bit, -11, { on: Boolean(code & (1 << bit)), high: 3.3 });
    if (bit < 3) part('resistor', bit, 0, bit + 1, 0, { resistance: 10e3 });
  }
  return parts;
}

test('R-2R ladder gives 3.3 × code / 16 for every code', () => {
  for (let code = 0; code < 16; code++) {
    const built = build_netlist(ladder(code));
    const sim = new Simulator(built.netlist);
    sim.operating_point();
    close(sim.voltage(built.point_node.get('3,0')), 3.3 * code / 16, 1e-6, `code ${code}`);
  }
});

test('wire currents follow Kirchhoff', () => {
  const parts = [
    { id: 's', type: 'source', x1: 0, y1: 5, x2: 0, y2: 0, wave: dc(10) },
    { id: 'w1', type: 'wire', x1: 0, y1: 0, x2: 5, y2: 0 },
    { id: 'r', type: 'resistor', x1: 5, y1: 0, x2: 5, y2: 5, resistance: 1000 },
    { id: 'w2', type: 'wire', x1: 5, y1: 5, x2: 0, y2: 5 },
    { id: 'g', type: 'ground', x1: 0, y1: 5, x2: 0, y2: 6 },
  ];
  const built = build_netlist(parts);
  const sim = new Simulator(built.netlist);
  sim.operating_point();
  const by_id = new Map(sim.elements.map((element) => [element.id, element.current]));
  const currents = wire_currents(parts, built, (id) => by_id.get(id));
  close(by_id.get('r'), 0.01, 1e-9);
  close(currents.get('w1'), 0.01, 1e-9, 'top wire runs left to right');
  close(currents.get('w2'), 0.01, 1e-9, 'bottom wire runs right to left');
});

test('switch joins only when closed', () => {
  const parts = (closed) => [
    { id: 'g', type: 'ground', x1: 0, y1: 0, x2: 0, y2: 1 },
    { id: 'rail', type: 'rail', x1: 0, y1: -4, x2: 0, y2: -5, wave: dc(5) },
    { id: 'sw', type: 'switch', x1: 0, y1: -4, x2: 0, y2: -2, closed },
    { id: 'r', type: 'resistor', x1: 0, y1: -2, x2: 0, y2: 0, resistance: 100 },
  ];
  for (const closed of [true, false]) {
    const built = build_netlist(parts(closed));
    const sim = new Simulator(built.netlist);
    sim.operating_point();
    close(sim.voltage(built.point_node.get('0,-2')), closed ? 5 : 0, 1e-6, `closed=${closed}`);
  }
});

test('every preset builds and runs', async () => {
  const { presets } = await import('../src/presets.js');
  for (const preset of presets) {
    const parts = preset.parts.map((item, i) => ({ id: `p${i}`, ...item }));
    const built = build_netlist(parts);
    assert.deepEqual(built.problems, [], preset.id);
    const sim = new Simulator(built.netlist);
    for (let i = 0; i < 500; i++) sim.step(preset.settings.timestep);
    for (const probe of preset.probes) assert.ok(built.point_node.has(`${probe.x},${probe.y}`), `${preset.id} probe`);
  }
});

test('clocked R-2R counts up through all 16 codes', async () => {
  const { presets } = await import('../src/presets.js');
  const preset = presets.find((item) => item.id === 'r2r-dac');
  const parts = preset.parts.map((item, i) => ({ id: `p${i}`, ...item }));
  const built = build_netlist(parts);
  const sim = new Simulator(built.netlist);
  const out = built.point_node.get('20,5');
  const dt = preset.settings.timestep;
  for (let code = 0; code < 16; code++) {
    const middle = (code + 0.5) * 0.5e-3;   // the count changes every 0.5 ms
    while (sim.time < middle - dt / 2) sim.step(dt);
    close(sim.voltage(out), 3.3 * code / 16, 1e-6, `code ${code}`);
  }
});

test('square wave straight across a capacitor settles between edges', () => {
  const sim = new Simulator({ node_count: 2, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: { shape: 'square', offset: 0, amplitude: 1, frequency: 10, duty: 0.5 } },
    { id: 'c', kind: 'C', a: 1, b: 0, capacitance: 1e-6 },
  ] });
  for (let i = 0; i < 300; i++) sim.step(1e-4);
  close(sim.elements[1].current, 0, 1e-9);
});

test('opening the switch on an inductor does not ring forever', () => {
  const elements = [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(1) },
    { id: 'r', kind: 'R', a: 1, b: 2, resistance: 10 },
    { id: 'l', kind: 'L', a: 2, b: 0, inductance: 1e-3 },
  ];
  const sim = new Simulator({ node_count: 3, elements });
  for (let i = 0; i < 2000; i++) sim.step(1e-5);
  sim.set_value('v', 'wave', dc(0));
  const after = [];
  for (let i = 0; i < 50; i++) { sim.step(1e-5); after.push(sim.voltage(2)); }
  const flips = after.slice(10).filter((v, i, list) => i && Math.sign(v) !== Math.sign(list[i - 1])).length;
  assert.equal(flips, 0);
});

test('a diode straight across a source still solves', () => {
  const sim = new Simulator({ node_count: 2, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(5) },
    { id: 'd', kind: 'D', a: 1, b: 0 },
  ] });
  sim.operating_point();
  assert.ok(sim.elements[1].current > 1);
});

test('settle leaves time and state alone', () => {
  const sim = new Simulator({ node_count: 3, elements: [
    { id: 'v', kind: 'V', a: 1, b: 0, wave: dc(5) },
    { id: 'r', kind: 'R', a: 1, b: 2, resistance: 1000 },
    { id: 'c', kind: 'C', a: 2, b: 0, capacitance: 1e-6 },
  ] });
  for (let i = 0; i < 100; i++) sim.step(1e-5);
  const before = [sim.time, sim.elements[2].v_prev];
  sim.settle(1e-5);
  assert.deepEqual([sim.time, sim.elements[2].v_prev], before);
});
