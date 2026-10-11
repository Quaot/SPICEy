// Coordinates are grid points; y grows downward. A source runs from its negative end (x1, y1) to its positive
// end (x2, y2). Ground, supplies and logic inputs connect at (x1, y1) and draw their symbol toward (x2, y2).

const dc = (value) => ({ shape: 'dc', value });
const wire = (x1, y1, x2, y2) => ({ type: 'wire', x1, y1, x2, y2 });
const part = (type, x1, y1, x2, y2, extra = {}) => ({ type, x1, y1, x2, y2, ...extra });
const ground = (x, y) => part('ground', x, y, x, y + 1);
const volts = (x, y) => ({ kind: 'voltage', x, y });

function loop_back(x_right, y_bottom) {
  return [wire(x_right, y_bottom, 0, y_bottom), ground(0, y_bottom)];
}

export const presets = [
  {
    id: 'r2r-dac',
    name: '4-bit R-2R DAC',
    note: 'Four logic inputs drive a 10 kΩ / 20 kΩ ladder. A binary counter steps the output through all 16 codes, '
      + 'so the scope shows a staircase from 0 to 3.09 V. Click an input to set it by hand.',
    settings: { timestep: 5e-6, span: 16e-3 },
    parts: (() => {
      const items = [];
      const bits = [4, 8, 12, 16];
      bits.forEach((x, bit) => {
        items.push(part('logic', x, 0, x, -1, {
          high: 3.3, on: false, clock: true, frequency: 1000 / 2 ** bit, label: `b${bit}`,
        }));
        items.push(part('resistor', x, 0, x, 5, { resistance: 20e3 }));
        if (bit < 3) items.push(part('resistor', x, 5, x + 4, 5, { resistance: 10e3 }));
      });
      items.push(part('resistor', 4, 5, 4, 9, { resistance: 20e3 }));
      items.push(ground(4, 9));
      items.push(wire(16, 5, 20, 5));
      return items;
    })(),
    probes: [volts(20, 5)],
  },
  {
    id: 'divider',
    name: 'Voltage divider',
    note: 'The output is 9 V × 4.7k / (10k + 4.7k) = 2.88 V. Select a resistor to change its value.',
    settings: { timestep: 1e-4, span: 0.2 },
    parts: [
      part('source', 0, 7, 0, 3, { wave: dc(9) }),
      wire(0, 3, 0, 1), wire(0, 1, 6, 1),
      part('resistor', 6, 1, 6, 5, { resistance: 10e3 }),
      part('resistor', 6, 5, 6, 9, { resistance: 4.7e3 }),
      wire(6, 9, 0, 9), wire(0, 9, 0, 7), ground(0, 9),
      wire(6, 5, 10, 5),
    ],
    probes: [volts(10, 5)],
  },
  {
    id: 'charging',
    name: 'Capacitor charging',
    note: 'Close the switch to charge 100 µF through 1 kΩ (τ = 0.1 s). Open it and the 10 kΩ bleeder '
      + 'discharges the capacitor ten times more slowly.',
    settings: { timestep: 5e-4, span: 3 },
    parts: [
      part('source', 0, 6, 0, 2, { wave: dc(5) }),
      wire(0, 2, 3, 2),
      part('switch', 3, 2, 7, 2, { closed: false }),
      part('resistor', 7, 2, 11, 2, { resistance: 1e3 }),
      part('capacitor', 11, 2, 11, 6, { capacitance: 100e-6 }),
      wire(11, 2, 17, 2),
      part('resistor', 17, 2, 17, 6, { resistance: 10e3 }),
      wire(17, 6, 11, 6),
      ...loop_back(11, 6),
    ],
    probes: [volts(11, 2)],
  },
  {
    id: 'low-pass',
    name: 'RC low-pass filter',
    note: 'A 1 kHz square wave through 1 kΩ into 220 nF. The time constant is 220 µs, so the output '
      + 'rounds off each edge.',
    settings: { timestep: 2e-6, span: 4e-3 },
    parts: [
      part('source', 0, 6, 0, 2, { wave: { shape: 'square', offset: 2.5, amplitude: 2.5, frequency: 1000, duty: 0.5 } }),
      wire(0, 2, 3, 2),
      part('resistor', 3, 2, 7, 2, { resistance: 1e3 }),
      wire(7, 2, 10, 2),
      part('capacitor', 10, 2, 10, 6, { capacitance: 220e-9 }),
      ...loop_back(10, 6),
    ],
    probes: [volts(0, 2), volts(10, 2)],
  },
  {
    id: 'rlc',
    name: 'RLC ringing',
    note: '10 mH and 1 µF resonate at 1.59 kHz. With 20 Ω in series the damping ratio is 0.1, so every edge of the '
      + 'square wave sets the capacitor ringing.',
    settings: { timestep: 2e-6, span: 10e-3 },
    parts: [
      part('source', 0, 6, 0, 2, { wave: { shape: 'square', offset: 2.5, amplitude: 2.5, frequency: 200, duty: 0.5 } }),
      wire(0, 2, 2, 2),
      part('resistor', 2, 2, 6, 2, { resistance: 20 }),
      part('inductor', 6, 2, 10, 2, { inductance: 10e-3 }),
      wire(10, 2, 12, 2),
      part('capacitor', 12, 2, 12, 6, { capacitance: 1e-6 }),
      ...loop_back(12, 6),
    ],
    probes: [volts(0, 2), volts(12, 2)],
  },
  {
    id: 'rectifier',
    name: 'Half-wave rectifier',
    note: 'A 60 Hz, 10 V sine through a diode into 100 µF and a 1 kΩ load. The capacitor carries the load between '
      + 'peaks, and the ripple is about 1.5 V.',
    settings: { timestep: 2e-5, span: 0.05 },
    parts: [
      part('source', 0, 6, 0, 2, { wave: { shape: 'sine', offset: 0, amplitude: 10, frequency: 60 } }),
      wire(0, 2, 2, 2),
      part('diode', 2, 2, 6, 2),
      wire(6, 2, 9, 2),
      part('capacitor', 9, 2, 9, 6, { capacitance: 100e-6 }),
      wire(9, 2, 15, 2),
      part('resistor', 15, 2, 15, 6, { resistance: 1e3 }),
      wire(15, 6, 9, 6),
      ...loop_back(9, 6),
    ],
    probes: [volts(0, 2), volts(9, 2)],
  },
  {
    id: 'led',
    name: 'LED and resistor',
    note: 'Close the switch. A red LED drops about 2 V, so 150 Ω sets the current near 20 mA. Try 1 kΩ and watch it dim.',
    settings: { timestep: 1e-4, span: 0.2 },
    parts: [
      part('rail', 0, 2, 0, 1, { wave: dc(5) }),
      part('switch', 0, 2, 4, 2, { closed: false }),
      part('resistor', 4, 2, 8, 2, { resistance: 150 }),
      wire(8, 2, 10, 2),
      part('led', 10, 2, 10, 6, { color: 'red' }),
      ground(10, 6),
    ],
    probes: [volts(10, 2)],
  },
];
