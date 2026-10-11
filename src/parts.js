// What each part is called, how it is drawn and what can be edited. Symbols are drawn along +x, centred on 0.

export const grid = 20;

const dc = (value) => ({ shape: 'dc', value });

export const tools = [
  { type: 'select', name: 'Select', key: 'Escape', hint: 'Esc' },
  { type: 'wire', name: 'Wire', key: 'w' },
  { type: 'resistor', name: 'Resistor', key: 'r', prefix: 'R', make: () => ({ resistance: 1e3 }) },
  { type: 'capacitor', name: 'Capacitor', key: 'c', prefix: 'C', make: () => ({ capacitance: 1e-6 }) },
  { type: 'inductor', name: 'Inductor', key: 'l', prefix: 'L', make: () => ({ inductance: 1e-3 }) },
  { type: 'source', name: 'Voltage source', short: 'Source', key: 'v', prefix: 'V', make: () => ({ wave: dc(5) }), upright: true },
  { type: 'current', name: 'Current source', short: 'Current', key: 'i', prefix: 'I', make: () => ({ wave: dc(1e-3) }), upright: true },
  { type: 'diode', name: 'Diode', key: 'd', prefix: 'D', make: () => ({}) },
  { type: 'led', name: 'LED', key: 'e', prefix: 'LED', make: () => ({ color: 'red' }) },
  { type: 'switch', name: 'Switch', key: 's', prefix: 'S', make: () => ({ closed: false }) },
  { type: 'ground', name: 'Ground', key: 'g', single: true, down: true },
  { type: 'rail', name: 'Supply', key: 'p', prefix: 'P', make: () => ({ wave: dc(5) }), single: true },
  { type: 'logic', name: 'Logic input', short: 'Logic', key: 'n', prefix: 'IN', make: () => ({ high: 5, on: false, clock: false, frequency: 1 }), single: true },
  { type: 'probe', name: 'Scope probe', short: 'Probe', key: 'o', hint: 'O' },
];

export const tool_of = Object.fromEntries(tools.map((tool) => [tool.type, tool]));

export const led_colors = {
  red: '#ff3b2f', green: '#2fd15a', blue: '#3b8bff', amber: '#ffb020', white: '#fff6e0',
};

const zigzag = (() => {
  const xs = [-20, -17.5, -12.5, -7.5, -2.5, 2.5, 7.5, 12.5, 17.5, 20];
  return 'M' + xs.map((x, i) => `${x} ${i === 0 || i === xs.length - 1 ? 0 : i % 2 ? -7 : 7}`).join(' L');
})();

const wave_glyph = {
  sine: 'M-9 0 C-6 -10 -3 -10 0 0 S6 10 9 0',
  square: 'M-9 4 V-5 H-1 V5 H8 V-4',
  triangle: 'M-9 4 L-4.5 -5 L0 4 L4.5 -5 L9 4',
};

// Half the body's length along the part, and the path drawn in body coordinates. A glyph is drawn upright.
export function body_of(part) {
  switch (part.type) {
    case 'resistor': return { half: 20, d: zigzag };
    case 'capacitor': return { half: 5, d: 'M-5 -13 V13 M5 -13 V13', thick: true };
    case 'inductor': return { half: 20, d: 'M-20 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0' };
    case 'diode':
    case 'led': return { half: 9, d: 'M-9 -9 L-9 9 L8 0 Z M9 -9 V9', filled: true };
    case 'switch': {
      const lever = part.closed ? 'L14 0' : 'L11 -13';
      return { half: 14, d: `M-14 0 ${lever}`, contacts: true };
    }
    case 'source': {
      if (part.wave.shape === 'dc') return { half: 6, d: 'M6 -14 V14 M-6 -7 V7', thick: true };
      return { half: 16, d: 'M16 0 A16 16 0 1 1 -16 0 A16 16 0 1 1 16 0', glyph: wave_glyph[part.wave.shape] };
    }
    case 'current': return { half: 15, d: 'M15 0 A15 15 0 1 1 -15 0 A15 15 0 1 1 15 0 M-8 0 H8 M3 -5 L8.5 0 L3 5' };
    default: return { half: 0, d: '' };
  }
}

export const value_fields = {
  resistor: [{ field: 'resistance', label: 'Resistance', unit: 'Ω' }],
  capacitor: [{ field: 'capacitance', label: 'Capacitance', unit: 'F' }],
  inductor: [{ field: 'inductance', label: 'Inductance', unit: 'H' }],
};

export function wave_fields(wave, unit) {
  if (wave.shape === 'dc') return [{ field: 'value', label: 'Value', unit }];
  const fields = [
    { field: 'offset', label: 'Offset', unit },
    { field: 'amplitude', label: 'Amplitude', unit },
    { field: 'frequency', label: 'Frequency', unit: 'Hz' },
  ];
  if (wave.shape === 'square') fields.push({ field: 'duty', label: 'Duty', unit: '' });
  return fields;
}

export function wave_from(shape, old) {
  const level = old.shape === 'dc' ? old.value : old.offset + old.amplitude;
  if (shape === 'dc') return { shape, value: level };
  return {
    shape,
    offset: old.shape === 'dc' ? 0 : old.offset,
    amplitude: old.shape === 'dc' ? old.value : old.amplitude,
    frequency: old.frequency ?? 1000,
    duty: old.duty ?? 0.5,
  };
}
