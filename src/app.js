import { Simulator, SolveError } from './solver.js';
import { build_netlist, wire_currents, part_points, point_key } from './netlist.js';
import { parse_value, format_value } from './units.js';
import { grid, tools, tool_of, body_of, led_colors, value_fields, wave_fields, wave_from } from './parts.js';
import { presets } from './presets.js';
import { place_by_click, reversed } from './placement.js';

const svg_ns = 'http://www.w3.org/2000/svg';
const $ = (selector) => document.querySelector(selector);
const single_ended = new Set(['ground', 'rail', 'logic']);
const storage_key = 'kirchhoff:circuit';

function el(name, attributes = {}, parent = null) {
  const node = document.createElementNS(svg_ns, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (parent) parent.append(node);
  return node;
}

function html(tag, attributes = {}, text = '') {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text) node.textContent = text;
  return node;
}

// ---------- State ----------

const state = {
  parts: [],
  probes: [],
  settings: { timestep: 1e-5, span: 0.01 },
  note: '',
  tool: 'select',
  selected: null,
  running: true,
  speed_factor: 1,
};
let next_id = 1;
let built = null;
let sim = null;
let error = null;
let flows = new Map();
let undo_stack = [];
let redo_stack = [];
const view = { x: -200, y: -200, zoom: 1 };

const snapshot = () => JSON.stringify({ parts: state.parts, probes: state.probes, settings: state.settings, note: state.note });

function restore(text) {
  const data = JSON.parse(text);
  state.parts = data.parts;
  state.probes = data.probes || [];
  state.settings = { ...state.settings, ...data.settings };
  state.note = data.note || '';
  next_id = 1 + Math.max(0, ...state.parts.map((part) => Number(String(part.id).slice(1)) || 0));
  if (!state.parts.some((part) => part.id === state.selected)) state.selected = null;
  clear_scope();
}

function commit() {
  undo_stack.push(snapshot());
  if (undo_stack.length > 200) undo_stack.shift();
  redo_stack = [];
}

function undo() {
  if (!undo_stack.length) return;
  hide_flip();
  redo_stack.push(snapshot());
  restore(undo_stack.pop());
  changed({ reset: true });
}

function redo() {
  if (!redo_stack.length) return;
  hide_flip();
  undo_stack.push(snapshot());
  restore(redo_stack.pop());
  changed({ reset: true });
}

function save_local() {
  try { localStorage.setItem(storage_key, snapshot()); } catch { /* storage may be off */ }
}

function new_id() { return `p${next_id++}`; }

function names() {
  const counts = {};
  const result = new Map();
  for (const part of state.parts) {
    const prefix = tool_of[part.type]?.prefix;
    if (!prefix) continue;
    counts[prefix] = (counts[prefix] || 0) + 1;
    result.set(part.id, part.label || `${prefix}${counts[prefix]}`);
  }
  return result;
}
let part_names = new Map();

// ---------- Simulation ----------

const scope_buffer = { times: [], series: [] };

function clear_scope() {
  scope_buffer.times = [];
  scope_buffer.series = state.probes.map(() => []);
}

function rebuild({ reset = false } = {}) {
  const previous = sim;
  built = build_netlist(state.parts);
  error = built.problems.length ? { message: built.problems[0].message, id: built.problems[0].id } : null;
  sim = new Simulator(built.netlist);
  if (previous && !reset) {
    sim.time = previous.time;
    const old_by_id = new Map(previous.elements.map((element) => [element.id, element]));
    for (const element of sim.elements) {
      const old = old_by_id.get(element.id);
      if (!old || old.kind !== element.kind) continue;
      for (const field of ['v_prev', 'i_prev', 'v_guess', 'current', 'state']) if (field in old) element[field] = old[field];
    }
  }
  if (reset || !previous || scope_buffer.series.length !== state.probes.length) clear_scope();
  sim_lookup = new Map(sim.elements.map((element) => [element.id, element]));
  flows = new Map();
  if (!error) {
    try {
      if (state.running) sim.step(state.settings.timestep);
      else sim.settle(state.settings.timestep);
    } catch (problem) { set_solve_error(problem); }
    if (!error) update_flows();
  }
}
let sim_lookup = new Map();

function set_solve_error(problem) {
  if (!(problem instanceof SolveError)) throw problem;
  error = problem.message === 'singular'
    ? { message: 'This circuit has no solution. Look for a shorted source, or sources joined in a loop of wires.' }
    : { message: 'The solver could not settle on an answer. Try a smaller time step.' };
}

function element_current(id) {
  return sim_lookup.get(id)?.current ?? 0;
}

function update_flows() {
  flows = wire_currents(state.parts, built, element_current);
}

function node_voltage_at(key) {
  const node = built?.point_node.get(key);
  return node === undefined || !sim ? null : sim.voltage(node);
}

function probe_value(probe) {
  if (probe.kind === 'voltage') return node_voltage_at(point_key(probe.x, probe.y)) ?? 0;
  return part_current(state.parts.find((part) => part.id === probe.id)) ?? 0;
}

// Current along the part from end 1 to end 2.
function part_current(part) {
  if (!part) return null;
  if (part.type === 'wire' || part.type === 'switch') return flows.get(part.id) ?? 0;
  if (part.type === 'ground') return null;
  const current = element_current(part.id);
  return part.type === 'source' ? -current : current;
}

const speed = () => state.settings.span / 4 * state.speed_factor;
let step_carry = 0;
let slowed = false;

function advance(wall_dt) {
  if (!state.running || error || !sim) return;
  const dt = state.settings.timestep;
  let wanted = speed() * wall_dt / dt + step_carry;
  let count = Math.floor(wanted);
  step_carry = wanted - count;
  const started = performance.now();
  const sample_every = state.settings.span / 1500;
  let done = 0;
  try {
    for (; done < count; done++) {
      sim.step(dt);
      const last = scope_buffer.times.at(-1);
      if (last === undefined || sim.time - last >= sample_every || sim.time < last) {
        if (last !== undefined && sim.time < last) clear_scope();
        scope_buffer.times.push(sim.time);
        if (probes_on_wires()) update_flows();
        state.probes.forEach((probe, i) => scope_buffer.series[i].push(probe_value(probe)));
      }
      if ((done & 31) === 31 && performance.now() - started > 10) { done++; break; }
    }
  } catch (problem) {
    set_solve_error(problem);
    show_banner();
  }
  slowed = done < count;
  if (slowed) step_carry = 0;
  update_flows();
  trim_scope();
}

function probes_on_wires() {
  return state.probes.some((probe) => probe.kind === 'current'
    && ['wire', 'switch'].includes(state.parts.find((part) => part.id === probe.id)?.type));
}

function trim_scope() {
  const oldest = sim.time - state.settings.span * 1.02;
  let cut = 0;
  while (cut < scope_buffer.times.length && scope_buffer.times[cut] < oldest) cut++;
  if (cut > 400) {
    scope_buffer.times.splice(0, cut);
    for (const series of scope_buffer.series) series.splice(0, cut);
  }
}

// ---------- Board drawing ----------

const board = $('#board');
const defs = el('defs', {}, board);
const pattern = el('pattern', { id: 'grid-dots', width: grid, height: grid, patternUnits: 'userSpaceOnUse', x: -grid / 2, y: -grid / 2 }, defs);
el('circle', { class: 'grid-dot', cx: grid / 2, cy: grid / 2, r: 1.1 }, pattern);
el('rect', { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: 'url(#grid-dots)', class: 'paper' }, board);
const parts_layer = el('g', { id: 'parts' }, board);
const junction_layer = el('g', { id: 'junctions' }, board);
const dots_path = el('path', { id: 'current-dots', d: '' }, board);
const probe_layer = el('g', { id: 'probes' }, board);
const overlay = el('g', { id: 'overlay' }, board);
const hover_ring = el('circle', { class: 'hover-point', r: 6, cx: -9999, cy: -9999 }, board);

let views = new Map();

function geometry(part) {
  const x1 = part.x1 * grid, y1 = part.y1 * grid, x2 = part.x2 * grid, y2 = part.y2 * grid;
  const dx = x2 - x1, dy = y2 - y1;
  return { x1, y1, x2, y2, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) * 180 / Math.PI, ux: dx / (Math.hypot(dx, dy) || 1), uy: dy / (Math.hypot(dx, dy) || 1) };
}

function value_label(part) {
  const wave_label = (wave, unit) => {
    if (wave.shape === 'dc') return format_value(wave.value, unit);
    const swing = wave.offset === 0
      ? `±${format_value(Math.abs(wave.amplitude), unit)}`
      : `${format_value(wave.offset - Math.abs(wave.amplitude), '')} to ${format_value(wave.offset + Math.abs(wave.amplitude), unit)}`;
    return [`${wave.shape} ${swing}`, format_value(wave.frequency, 'Hz')];
  };
  switch (part.type) {
    case 'resistor': return format_value(part.resistance, 'Ω');
    case 'capacitor': return format_value(part.capacitance, 'F');
    case 'inductor': return format_value(part.inductance, 'H');
    case 'source': return wave_label(part.wave, 'V');
    case 'current': return wave_label(part.wave, 'A');
    default: return '';
  }
}

function draw_part(part, parent, ghost = false) {
  const g = el('g', { class: `part ${part.type}${ghost ? ' ghost-part' : ''}`, 'data-id': part.id ?? '' }, parent);
  const shape = geometry(part);
  const { x1, y1, x2, y2, length, angle, ux, uy } = shape;
  const refs = { g, leads: [], part };
  el('line', { class: 'hit', x1, y1, x2, y2 }, g);
  const inner = el('g', { transform: `translate(${x1} ${y1}) rotate(${angle})` }, g);
  const lead = (from, to, end) => {
    const line = el('line', { class: 'lead', x1: from, y1: 0, x2: to, y2: 0 }, inner);
    refs.leads.push({ line, end });
  };

  if (single_ended.has(part.type)) {
    lead(0, length, 1);
    const ex = x2, ey = y2;
    if (part.type === 'ground') {
      el('path', { class: 'body', d: `M${length} -11 V11 M${length + 5} -7 V7 M${length + 10} -3 V3` }, inner);
    } else if (part.type === 'rail') {
      el('circle', { class: 'body filled', cx: length, cy: 0, r: 3 }, inner);
      const text = el('text', { class: 'rail-text', x: ex + ux * 12, y: ey + uy * 12 + 4, 'text-anchor': text_anchor(ux) }, g);
      text.textContent = rail_text(part);
    } else {
      const cx = ex + ux * 15, cy = ey + uy * 11;
      refs.box = el('rect', { class: 'logic-box', x: cx - 15, y: cy - 11, width: 30, height: 22, rx: 5 }, g);
      refs.box_text = el('text', { class: 'logic-text', x: cx, y: cy + 4, 'text-anchor': 'middle' }, g);
      refs.box_text.textContent = part.on ? '1' : '0';
      const label = el('text', { class: 'label', x: cx + 21, y: cy + 4 }, g);
      label.textContent = part_names.get(part.id) || '';
      if (part.clock) {
        const clock = el('text', { class: 'label', x: cx + 21, y: cy + 17 }, g);
        clock.textContent = format_value(part.frequency, 'Hz');
      }
    }
  } else if (part.type === 'wire') {
    lead(0, length, 1);
  } else {
    const body = body_of(part);
    const half = Math.min(body.half, length / 2);
    const scale = body.half ? half / body.half : 1;
    lead(0, length / 2 - half, 1);
    lead(length / 2 + half, length, 2);
    const body_group = el('g', { transform: `translate(${length / 2} 0) scale(${scale})` }, inner);
    if (part.type === 'led') {
      refs.glow = el('circle', { class: 'glow', cx: 0, cy: 0, r: 16 }, body_group);
    }
    refs.body = el('path', { class: `body${body.thick ? ' thick' : ''}${body.filled ? ' filled' : ''}`, d: body.d }, body_group);
    if (part.type === 'led') {
      el('path', { class: 'body', d: 'M-1 -12 L5 -20 M3 -10 L9 -18 M5 -20 l-3.5 0.6 M5 -20 l-0.4 3.6 M9 -18 l-3.5 0.6 M9 -18 l-0.4 3.6' }, body_group);
    }
    if (body.glyph) {
      el('path', { class: 'body', d: body.glyph, transform: `translate(${(x1 + x2) / 2} ${(y1 + y2) / 2}) scale(${scale})` }, g);
    }
    if (part.type === 'regulator') {
      const adjust_lead = el('line', { class: 'lead', x1: length / 2, y1: 20 * scale, x2: length / 2, y2: 2 * grid }, inner);
      refs.leads.push({ line: adjust_lead, end: 3 });
      const world = (lx, ly) => [x1 + ux * lx - uy * ly, y1 + uy * lx + ux * ly];
      const pin_text = (text, lx, ly, size = 'pin') => {
        const [px, py] = world(lx, ly);
        const node = el('text', { class: size, x: px, y: py + 3.5, 'text-anchor': 'middle' }, g);
        node.textContent = text;
      };
      pin_text('LM1117', length / 2, 0, 'chip');
      pin_text('IN', length / 2 - 32 * scale - 10, -8);
      pin_text('OUT', length / 2 + 32 * scale + 12, -8);
      pin_text('ADJ', length / 2 + 14, 32);
    }
    if (body.contacts) {
      el('circle', { class: 'contact', cx: -14, cy: 0, r: 2.6 }, body_group);
      el('circle', { class: 'contact', cx: 14, cy: 0, r: 2.6 }, body_group);
    }
    if (!ghost) {
      const name = part_names.get(part.id) || '';
      const value = value_label(part);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const horizontal = Math.abs(ux) > Math.abs(uy);
      // Labels sit above horizontal parts and right of vertical ones, unless the part asks for the other side.
      const flipped = part.label_side === 'below' || part.label_side === 'left';
      const gap = part.type === 'led' ? 30 : part.type === 'regulator' ? 32 : 22;
      const label = el('text', {
        class: 'label',
        x: horizontal ? mx : mx + (flipped ? -gap : gap),
        y: horizontal ? my + (flipped ? 26 : -(part.type === 'led' ? 26 : part.type === 'regulator' ? 30 : 20)) : my + 4,
        'text-anchor': horizontal ? 'middle' : flipped ? 'end' : 'start',
      }, g);
      const name_span = el('tspan', { class: 'name' }, label);
      name_span.textContent = name;
      if (value) {
        // beside a vertical part each line of the value goes under the name, so the label stays narrow
        const lines = [value].flat();
        if (horizontal) el('tspan', {}, label).textContent = ` ${lines.join(' ')}`;
        else {
          for (const line of lines) el('tspan', { x: label.getAttribute('x'), dy: '1.25em' }, label).textContent = line;
          label.setAttribute('y', my - 3 - (lines.length - 1) * 7);
        }
      }
      if (part.type === 'switch') {
        const hint = el('text', { class: 'label', x: horizontal ? mx : mx + 22, y: horizontal ? my + 24 : my + 18, 'text-anchor': horizontal ? 'middle' : 'start' }, g);
        hint.textContent = part.closed ? 'closed' : 'open';
      }
    }
  }
  return refs;
}

function text_anchor(ux) {
  if (ux > 0.5) return 'start';
  if (ux < -0.5) return 'end';
  return 'middle';
}

function rail_text(part) {
  const wave = part.wave;
  if (wave.shape === 'dc') return `${wave.value > 0 ? '+' : ''}${format_value(wave.value, 'V')}`;
  return `${wave.shape} ${format_value(wave.amplitude, 'V')}`;
}

function render_board() {
  part_names = names();
  parts_layer.replaceChildren();
  views = new Map();
  for (const part of state.parts) {
    const refs = draw_part(part, parts_layer);
    if (part.id === state.selected) refs.g.classList.add('selected');
    if (error?.id === part.id) refs.g.classList.add('problem');
    views.set(part.id, refs);
  }
  render_junctions();
  render_probes();
  render_handles();
  board.classList.toggle('select-tool', state.tool === 'select');
  board.classList.toggle('placing', state.tool !== 'select');
}

function render_junctions() {
  junction_layer.replaceChildren();
  const ends = new Map();
  for (const part of state.parts) {
    for (const key of part_points(part)) ends.set(key, (ends.get(key) || 0) + 1);
  }
  const probed = new Set(state.probes.filter((probe) => probe.kind === 'voltage').map((probe) => point_key(probe.x, probe.y)));
  for (const [key, count] of ends) {
    const [x, y] = key.split(',').map(Number);
    if (count >= 3) el('circle', { class: 'junction', cx: x * grid, cy: y * grid, r: 3.6 }, junction_layer);
    else if (count === 1 && !probed.has(key)) el('circle', { class: 'loose-end', cx: x * grid, cy: y * grid, r: 3 }, junction_layer);
  }
}

function probe_color(index) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--probe-${index}`).trim();
}

function probe_letter(index) { return 'ABCD'[index]; }

function probe_name(probe, index) {
  if (probe.kind === 'voltage') return `${probe_letter(index)}`;
  return `I(${part_names.get(probe.id) || '?'})`;
}

function render_probes() {
  probe_layer.replaceChildren();
  state.probes.forEach((probe, index) => {
    const color = probe_color(index);
    let x, y;
    if (probe.kind === 'voltage') { x = probe.x * grid; y = probe.y * grid; }
    else {
      const part = state.parts.find((item) => item.id === probe.id);
      if (!part) return;
      x = (part.x1 + part.x2) / 2 * grid; y = (part.y1 + part.y2) / 2 * grid;
    }
    const g = el('g', { class: 'probe-flag', transform: `translate(${x} ${y})` }, probe_layer);
    el('circle', { r: 4.5, fill: color, stroke: 'var(--paper)', 'stroke-width': 1.5 }, g);
    if (probe.kind === 'voltage') {
      el('path', { d: 'M0 0 L10 -14 H26 V-30 H6 V-14', fill: color, stroke: 'none' }, g);
      const text = el('text', { x: 16, y: -18, 'text-anchor': 'middle' }, g);
      text.textContent = probe_letter(index);
    } else {
      el('rect', { x: 8, y: -26, width: 20, height: 16, rx: 3, fill: color }, g);
      const text = el('text', { x: 18, y: -14, 'text-anchor': 'middle' }, g);
      text.textContent = 'I';
    }
  });
}

function render_handles() {
  overlay.replaceChildren();
  const part = selected_part();
  if (!part || state.tool !== 'select') return;
  for (const [x, y, end] of [[part.x1, part.y1, 1], [part.x2, part.y2, 2]]) el('circle', { class: 'handle', cx: x * grid, cy: y * grid, r: 5, 'data-end': end }, overlay);
}

// Voltage colours: blue below ground, grey at ground, orange above.
let palette = { negative: [47, 109, 181], neutral: [154, 145, 127], positive: [228, 87, 46] };
function read_palette() {
  const style = getComputedStyle(document.documentElement);
  const rgb = (name) => {
    const hex = style.getPropertyValue(name).trim().replace('#', '');
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  };
  palette = { negative: rgb('--negative'), neutral: rgb('--neutral'), positive: rgb('--accent') };
}

function voltage_color(v, scale) {
  if (v === null) return `rgb(${palette.neutral})`;
  const t = Math.max(-1, Math.min(1, v / scale));
  const target = t >= 0 ? palette.positive : palette.negative;
  const amount = Math.pow(Math.abs(t), 0.8);
  const mix = palette.neutral.map((channel, i) => Math.round(channel + (target[i] - channel) * amount));
  return `rgb(${mix})`;
}

let voltage_scale = 1;
let current_scale = 1e-3;
const dot_phase = new Map();

function paint(wall_dt) {
  if (!sim || !built) return;
  let v_max = 0;
  for (let node = 1; node < sim.node_count; node++) v_max = Math.max(v_max, Math.abs(sim.voltage(node)));
  voltage_scale += (Math.max(v_max, 0.5) - voltage_scale) * Math.min(1, wall_dt * 3);
  let i_max = 0;
  for (const part of state.parts) {
    const current = part_current(part);
    if (current !== null) i_max = Math.max(i_max, Math.abs(current));
  }
  current_scale += (Math.max(i_max, 1e-9) - current_scale) * Math.min(1, wall_dt * 3);

  let dots = '';
  const spacing = 18;
  for (const part of state.parts) {
    const refs = views.get(part.id);
    if (!refs) continue;
    const points = part_points(part);
    const v1 = error ? null : node_voltage_at(points[0]);
    const end_voltage = (end) => (error ? null : points[end - 1] === undefined ? v1 : node_voltage_at(points[end - 1]));
    for (const { line, end } of refs.leads) line.setAttribute('stroke', voltage_color(end_voltage(end), voltage_scale));

    if (part.type === 'led' && refs.glow) {
      const current = error ? 0 : element_current(part.id);
      const level = Math.max(0, Math.min(1, current / 0.02));
      refs.glow.style.opacity = (level ** 0.6 * 0.9).toFixed(3);
      refs.glow.style.fill = led_colors[part.color] || led_colors.red;
      refs.body.style.fill = level > 0.02 ? (led_colors[part.color] || led_colors.red) : '';
    }
    if (part.type === 'logic' && refs.box) {
      const high = part.clock ? (v1 ?? 0) > part.high / 2 : part.on;
      refs.box.classList.toggle('on', high);
      refs.box_text.classList.toggle('on', high);
      refs.box_text.textContent = high ? '1' : '0';
    }

    if (error || part.type === 'ground') continue;
    const current = part_current(part);
    if (current === null || Math.abs(current) < 1e-9 || Math.abs(current) < current_scale * 1e-3) continue;
    const { x1, y1, length, ux, uy } = geometry(part);
    const rate = Math.sign(current) * 110 * Math.sqrt(Math.abs(current) / current_scale);
    let phase = (dot_phase.get(part.id) || 0) + (state.running ? rate * wall_dt : 0);
    phase = ((phase % spacing) + spacing) % spacing;
    dot_phase.set(part.id, phase);
    const boxed = (part.type === 'source' && part.wave.shape !== 'dc') || part.type === 'current' || part.type === 'regulator';
    const circle = boxed ? Math.min(body_of(part).half, length / 2) + 2 : 0;
    for (let s = phase; s < length; s += spacing) {
      if (circle && Math.abs(s - length / 2) < circle) continue;
      const x = x1 + ux * s, y = y1 + uy * s;
      dots += `M${x.toFixed(1)} ${y.toFixed(1)}h0`;
    }
  }
  dots_path.setAttribute('d', dots);
}

// ---------- View ----------

function apply_view() {
  const rect = board.getBoundingClientRect();
  board.setAttribute('viewBox', `${view.x} ${view.y} ${rect.width / view.zoom} ${rect.height / view.zoom}`);
}

function fit_view() {
  const rect = board.getBoundingClientRect();
  if (!state.parts.length || !rect.width) {
    view.zoom = 1.5; view.x = -rect.width / 2 / view.zoom; view.y = -rect.height / 2 / view.zoom;
    apply_view();
    return;
  }
  // The drawn parts with their labels, in board units.
  const box = parts_layer.getBBox();
  const pad = 2.5 * grid;
  const width = box.width + pad * 2;
  const height = box.height + pad * 2 + 30;   // room for the probe flags
  const inspector_room = window.innerWidth > 760 ? 270 : 0;
  const usable = Math.max(200, rect.width - inspector_room);
  view.zoom = Math.max(0.4, Math.min(2.2, usable / width, rect.height / height));
  const centre_x = box.x + box.width / 2;
  const centre_y = box.y + box.height / 2 - 15;
  view.x = centre_x - usable / 2 / view.zoom;
  view.y = centre_y - rect.height / 2 / view.zoom;
  apply_view();
}

function to_world(event) {
  const rect = board.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / view.zoom + view.x, y: (event.clientY - rect.top) / view.zoom + view.y };
}

const snap = (world) => ({ x: Math.round(world.x / grid), y: Math.round(world.y / grid) });

function zoom_at(client_x, client_y, factor) {
  const rect = board.getBoundingClientRect();
  const wx = (client_x - rect.left) / view.zoom + view.x;
  const wy = (client_y - rect.top) / view.zoom + view.y;
  view.zoom = Math.max(0.25, Math.min(4, view.zoom * factor));
  view.x = wx - (client_x - rect.left) / view.zoom;
  view.y = wy - (client_y - rect.top) / view.zoom;
  apply_view();
}

// ---------- Editing ----------

function selected_part() {
  return state.parts.find((part) => part.id === state.selected) || null;
}

function changed({ reset = false, keep_inspector = false } = {}) {
  // a shared link in the address bar would replace these edits on the next reload
  if (location.hash.startsWith('#c=')) history.replaceState(null, '', location.pathname);
  rebuild({ reset });
  render_board();
  if (!keep_inspector) render_inspector();
  render_legend();
  show_banner();
  save_local();
}

function new_part(tool, start, end) {
  const part = { id: new_id(), type: tool.type, x1: start.x, y1: start.y, x2: end.x, y2: end.y, ...(tool.make ? tool.make() : {}) };
  if (start.x === end.x && start.y === end.y) {
    if (tool.single) { part.y2 = start.y + (tool.down ? 1 : -1); }
    else if (tool.upright) { part.y1 = start.y + 2; part.y2 = start.y - 2; }
    else { part.x1 = start.x - 2; part.x2 = start.x + 2; }
  }
  return part;
}

function smart_placement(tool, point) {
  if (tool.type === 'wire' || tool.type === 'select' || tool.type === 'probe') return null;
  return place_by_click(state.parts, tool.type, point, {
    node: (key) => built?.point_node.get(key),
    voltage: (key) => node_voltage_at(key) ?? 0,
  });
}

function split_wire(wire, at) {
  const index = state.parts.indexOf(wire);
  if (index < 0) return;
  state.parts.splice(index, 1,
    { id: wire.id, type: 'wire', x1: wire.x1, y1: wire.y1, x2: at.x, y2: at.y },
    { id: new_id(), type: 'wire', x1: at.x, y1: at.y, x2: wire.x2, y2: wire.y2 });
}

function reverse_part(part) {
  if (!part || part.type === 'wire') return;
  commit();
  Object.assign(part, reversed(part));
  changed();
}

function toggle(part) {
  if (part.type === 'switch') part.closed = !part.closed;
  else if (part.type === 'logic') {
    if (part.clock) {
      part.on = !((node_voltage_at(point_key(part.x1, part.y1)) ?? 0) > part.high / 2);
      part.clock = false;
    } else part.on = !part.on;
  } else return false;
  return true;
}

function delete_selected() {
  const part = selected_part();
  if (!part) return;
  commit();
  state.parts = state.parts.filter((item) => item !== part);
  state.probes = state.probes.filter((probe) => probe.kind !== 'current' || probe.id !== part.id);
  state.selected = null;
  clear_scope();
  changed();
}

function toggle_probe(target_part, point) {
  commit();
  if (target_part) {
    const index = state.probes.findIndex((probe) => probe.kind === 'current' && probe.id === target_part.id);
    if (index >= 0) state.probes.splice(index, 1);
    else state.probes.push({ kind: 'current', id: target_part.id });
  } else {
    const index = state.probes.findIndex((probe) => probe.kind === 'voltage' && probe.x === point.x && probe.y === point.y);
    if (index >= 0) state.probes.splice(index, 1);
    else state.probes.push({ kind: 'voltage', x: point.x, y: point.y });
  }
  if (state.probes.length > 4) state.probes.shift();
  clear_scope();
  changed({ keep_inspector: true });
}

let drag = null;
const pointers = new Map();

function part_at(target) {
  const node = target.closest?.('.part');
  if (!node || !node.dataset.id) return null;
  return state.parts.find((part) => part.id === node.dataset.id) || null;
}

board.addEventListener('pointerdown', (event) => {
  board.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  hide_tip();
  hide_flip();
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { mode: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    overlay.querySelector('.ghost-part')?.remove();
    return;
  }
  const world = to_world(event);
  const point = snap(world);
  if (event.button === 1 || (event.button === 0 && event.altKey)) {
    drag = { mode: 'pan', client: { x: event.clientX, y: event.clientY }, view: { ...view } };
    return;
  }
  if (event.button !== 0) return;
  const tool = tool_of[state.tool];

  if (state.tool === 'probe') {
    const part = part_at(event.target);
    const key = point_key(point.x, point.y);
    const near_point = Math.hypot(world.x - point.x * grid, world.y - point.y * grid) < 9 && built.point_node.has(key);
    if (near_point) drag = { mode: 'probe', point };
    else if (part && part.type !== 'ground') drag = { mode: 'probe', part };
    else drag = { mode: 'pan', client: { x: event.clientX, y: event.clientY }, view: { ...view } };
    return;
  }

  if (state.tool !== 'select') {
    drag = { mode: 'place', tool, start: point, end: point };
    draw_ghost();
    return;
  }

  const end = event.target.dataset?.end;
  const part = part_at(event.target);
  if (end && selected_part()) {
    drag = { mode: 'end', part: selected_part(), end: Number(end), moved: false };
  } else if (part) {
    const was_selected = state.selected === part.id;
    state.selected = part.id;
    if (!was_selected) { render_board(); render_inspector(); }
    drag = { mode: 'move', part, origin: point, start: { x1: part.x1, y1: part.y1, x2: part.x2, y2: part.y2 }, moved: false, client: { x: event.clientX, y: event.clientY } };
  } else {
    if (state.selected) { state.selected = null; render_board(); render_inspector(); }
    drag = { mode: 'pan', client: { x: event.clientX, y: event.clientY }, view: { ...view } };
  }
});

board.addEventListener('pointermove', (event) => {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (!drag) { hover(event); preview_placement(event); return; }
  const world = to_world(event);
  const point = snap(world);
  switch (drag.mode) {
    case 'pinch': {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      view.x -= (mid.x - drag.mid.x) / view.zoom;
      view.y -= (mid.y - drag.mid.y) / view.zoom;
      zoom_at(mid.x, mid.y, distance / drag.distance);
      drag.distance = distance; drag.mid = mid;
      break;
    }
    case 'pan':
      view.x = drag.view.x - (event.clientX - drag.client.x) / view.zoom;
      view.y = drag.view.y - (event.clientY - drag.client.y) / view.zoom;
      board.classList.add('panning');
      apply_view();
      break;
    case 'place':
      if (point.x !== drag.end.x || point.y !== drag.end.y) { drag.end = point; draw_ghost(); }
      break;
    case 'move': {
      const dx = point.x - drag.origin.x, dy = point.y - drag.origin.y;
      if (!drag.moved && Math.hypot(event.clientX - drag.client.x, event.clientY - drag.client.y) < 4) return;
      const part = drag.part;
      const nx1 = drag.start.x1 + dx, ny1 = drag.start.y1 + dy;
      drag.moved = true;
      if (nx1 === part.x1 && ny1 === part.y1) return;
      if (!drag.committed) { commit(); drag.committed = true; }
      part.x1 = nx1; part.y1 = ny1; part.x2 = drag.start.x2 + dx; part.y2 = drag.start.y2 + dy;
      changed({ keep_inspector: true });
      break;
    }
    case 'end': {
      const part = drag.part;
      const [fx, fy] = drag.end === 1 ? ['x1', 'y1'] : ['x2', 'y2'];
      if (part[fx] === point.x && part[fy] === point.y) return;
      const other = drag.end === 1 ? [part.x2, part.y2] : [part.x1, part.y1];
      if (other[0] === point.x && other[1] === point.y) return;
      if (!drag.committed) { commit(); drag.committed = true; }
      drag.moved = true;
      part[fx] = point.x; part[fy] = point.y;
      changed({ keep_inspector: true });
      break;
    }
  }
});

function finish_pointer(event) {
  pointers.delete(event.pointerId);
  board.classList.remove('panning');
  if (!drag) return;
  if (drag.mode === 'pinch') { if (pointers.size === 0) drag = null; return; }
  if (drag.mode === 'place' && event.type === 'pointerup') {
    overlay.replaceChildren();
    const { tool, start, end } = drag;
    const zero = start.x === end.x && start.y === end.y;
    if (!(tool.type === 'wire' && zero)) {
      commit();
      const smart = zero ? smart_placement(tool, start) : null;
      if (smart?.split) split_wire(smart.split, smart.anchor);
      const part = new_part(tool, start, end);
      if (smart) Object.assign(part, { x1: smart.x1, y1: smart.y1, x2: smart.x2, y2: smart.y2 });
      state.parts.push(part);
      preview_key = null;
      changed();
    }
  } else if (drag.mode === 'probe' && event.type === 'pointerup') {
    toggle_probe(drag.part || null, drag.point || null);
  } else if (drag.mode === 'move' && !drag.moved && event.type === 'pointerup') {
    if (['switch', 'logic'].includes(drag.part.type)) { commit(); toggle(drag.part); changed(); }
    if (reversible.has(drag.part.type)) show_flip(drag.part);
  } else if (drag.mode === 'move' || drag.mode === 'end') {
    render_inspector();
  }
  drag = null;
}
board.addEventListener('pointerup', finish_pointer);
board.addEventListener('pointercancel', finish_pointer);
board.addEventListener('pointerleave', () => {
  if (drag) return;
  hide_tip();
  if (!['select', 'probe', 'wire'].includes(state.tool)) { overlay.replaceChildren(); preview_key = null; }
  schedule_hide_flip();
});

// ---------- Reverse button ----------

const flip_button = $('#flip');
const reversible = new Set(['diode', 'led', 'source', 'current', 'regulator', 'ground', 'rail', 'logic', 'capacitor']);
let flip_part = null;
let flip_timer = null;

function show_flip(part) {
  clearTimeout(flip_timer);
  if (flip_part === part && !flip_button.hidden) return;
  flip_part = part;
  const rect = board.getBoundingClientRect();
  const stage_rect = board.parentElement.getBoundingClientRect();
  const to_screen = (x, y) => [(x * grid - view.x) * view.zoom + rect.left - stage_rect.left, (y * grid - view.y) * view.zoom + rect.top - stage_rect.top];
  const horizontal = Math.abs(part.x2 - part.x1) >= Math.abs(part.y2 - part.y1);
  const single_part = single_ended.has(part.type);
  const [mx, my] = to_screen(single_part ? part.x1 : (part.x1 + part.x2) / 2, single_part ? part.y1 : (part.y1 + part.y2) / 2);
  // On the same side as the part's label, just past it, where neighbouring parts don't reach.
  const flipped = part.label_side === 'below' || part.label_side === 'left';
  const side = flipped ? -1 : 1;
  if (single_part || horizontal) {
    flip_button.style.left = `${mx}px`;
    flip_button.style.top = `${my + (single_part ? 34 : flipped ? -34 : 32) * view.zoom}px`;
    flip_button.style.transform = 'translate(-50%, -50%)';
  } else {
    flip_button.style.left = `${mx + side * (part.type === 'led' ? 30 : 22) * view.zoom}px`;
    flip_button.style.top = `${my + 30 * view.zoom}px`;
    flip_button.style.transform = flipped ? 'translate(-100%, 0)' : 'none';
  }
  flip_button.hidden = false;
}

function hide_flip() { clearTimeout(flip_timer); flip_button.hidden = true; flip_part = null; }
function schedule_hide_flip() { clearTimeout(flip_timer); flip_timer = setTimeout(hide_flip, 700); }

flip_button.addEventListener('pointerenter', () => clearTimeout(flip_timer));
flip_button.addEventListener('pointerleave', schedule_hide_flip);
flip_button.addEventListener('click', () => {
  const part = flip_part;
  reverse_part(part);
  flip_part = null;
  if (part) show_flip(part);
});

let preview_key = null;
function preview_placement(event) {
  const tool = tool_of[state.tool];
  if (!tool || ['select', 'probe', 'wire'].includes(tool.type)) return;
  const point = snap(to_world(event));
  const key = point_key(point.x, point.y);
  if (key === preview_key) return;
  preview_key = key;
  overlay.replaceChildren();
  const smart = smart_placement(tool, point);
  if (!smart) return;
  const part = { type: tool.type, x1: smart.x1, y1: smart.y1, x2: smart.x2, y2: smart.y2, ...(tool.make ? tool.make() : {}) };
  draw_part(part, overlay, true);
  el('circle', { class: 'handle', cx: smart.anchor.x * grid, cy: smart.anchor.y * grid, r: 4 }, overlay);
}

function draw_ghost() {
  overlay.replaceChildren();
  const { tool, start, end } = drag;
  if (start.x === end.x && start.y === end.y) {
    const smart = smart_placement(tool, start);
    if (smart) {
      draw_part({ type: tool.type, x1: smart.x1, y1: smart.y1, x2: smart.x2, y2: smart.y2, ...(tool.make ? tool.make() : {}) }, overlay, true);
      return;
    }
  }
  const part = new_part(tool, start, end);
  if (tool.type === 'wire' && start.x === end.x && start.y === end.y) {
    el('circle', { class: 'handle', cx: start.x * grid, cy: start.y * grid, r: 4 }, overlay);
    return;
  }
  delete part.id;
  draw_part(part, overlay, true);
}

board.addEventListener('wheel', (event) => {
  event.preventDefault();
  hide_flip();
  const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
  zoom_at(event.clientX, event.clientY, factor);
}, { passive: false });

// ---------- Hover readout ----------

const tip = $('#tip');
function hide_tip() { tip.hidden = true; hover_ring.setAttribute('cx', -9999); }

function hover(event) {
  if (!built || !sim) return;
  const world = to_world(event);
  const point = snap(world);
  const key = point_key(point.x, point.y);
  const rect = board.parentElement.getBoundingClientRect();
  let text = '';
  const near = Math.hypot(world.x - point.x * grid, world.y - point.y * grid) < 9;
  if (near && built.point_node.has(key) && !error) {
    text = format_value(node_voltage_at(key), 'V', 4);
    hover_ring.setAttribute('cx', point.x * grid);
    hover_ring.setAttribute('cy', point.y * grid);
  } else {
    hover_ring.setAttribute('cx', -9999);
    const part = part_at(event.target);
    if (part && !error) text = part_summary(part);
  }
  const hovered = part_at(event.target);
  if (hovered && state.tool === 'select' && reversible.has(hovered.type)) show_flip(hovered);
  else if (flip_part) schedule_hide_flip();
  if (!text) { tip.hidden = true; return; }
  tip.textContent = text;
  tip.hidden = false;
  tip.style.left = `${event.clientX - rect.left}px`;
  tip.style.top = `${event.clientY - rect.top}px`;
}

function part_readings(part) {
  const [p1, p2] = part_points(part);
  const v1 = node_voltage_at(p1) ?? 0;
  const v2 = p2 === undefined ? 0 : node_voltage_at(p2) ?? 0;
  const current = part_current(part);
  return { across: v1 - v2, current, v1, v2 };
}

const regulator_states = { regulating: 'Regulating', dropout: 'In dropout', limit: 'At its current limit', off: 'Off' };

function part_summary(part) {
  const name = part_names.get(part.id) || tool_of[part.type].name;
  const { across, current, v1 } = part_readings(part);
  if (part.type === 'wire' || part.type === 'switch') return `${name === 'Wire' ? 'wire' : name}  ${format_value(v1, 'V', 4)}\n${format_value(Math.abs(current ?? 0), 'A')}`;
  if (part.type === 'ground') return 'ground  0 V';
  if (part.type === 'regulator') {
    const { v2 } = part_readings(part);
    return `${name}  ${format_value(v2, 'V', 4)} out
${format_value(Math.abs(current ?? 0), 'A')}  ${regulator_states[sim_lookup.get(part.id)?.state] || ''}`;
  }
  if (single_ended.has(part.type)) return `${name}  ${format_value(v1, 'V', 4)}\n${format_value(Math.abs(current ?? 0), 'A')}`;
  return `${name}  ${format_value(Math.abs(across), 'V', 4)}\n${format_value(Math.abs(current ?? 0), 'A')}`;
}

// ---------- Inspector ----------

const inspector = $('#inspector');
let live_fields = [];
let inspector_folded = matchMedia('(max-width: 760px)').matches;

function field_row(label, value, unit, on_change) {
  const row = html('label', { class: 'field' });
  row.append(html('span', {}, label));
  const input = html('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false' });
  input.value = format_value(value, unit).replace(' ', '');
  input.addEventListener('change', () => {
    const parsed = parse_value(input.value);
    if (!Number.isFinite(parsed)) { input.classList.add('bad'); return; }
    input.classList.remove('bad');
    on_change(parsed);
  });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
  row.append(input);
  return row;
}

function check_row(label, checked, on_change) {
  const row = html('label', { class: 'check' });
  const input = html('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => on_change(input.checked));
  row.append(input, html('span', {}, label));
  return row;
}

function select_row(label, value, options, on_change) {
  const row = html('label', { class: 'field' });
  row.append(html('span', {}, label));
  const select = html('select');
  for (const [key, text] of options) {
    const option = html('option', { value: key }, text);
    if (key === value) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => on_change(select.value));
  row.append(select);
  return row;
}

function edit(part, apply, { structural = false } = {}) {
  commit();
  apply(part);
  if (structural) clear_scope();
  changed({ keep_inspector: false });
}

function render_inspector() {
  inspector.replaceChildren();
  live_fields = [];
  inspector.classList.toggle('folded', inspector_folded);
  const fold = html('button', { class: 'collapse', 'aria-label': inspector_folded ? 'Open panel' : 'Fold panel' }, inspector_folded ? '+' : '–');
  fold.addEventListener('click', () => { inspector_folded = !inspector_folded; render_inspector(); });
  inspector.append(fold);

  const part = selected_part();
  if (!part) { render_circuit_panel(); return; }
  const tool = tool_of[part.type];
  const title = html('h2', {}, part_names.get(part.id) || tool.name);
  title.append(html('span', { class: 'kind' }, tool.name));
  inspector.append(title);

  const add = (node) => inspector.append(node);
  for (const { field, label, unit } of value_fields[part.type] || []) {
    add(field_row(label, part[field], unit, (value) => {
      if (value <= 0) return;
      edit(part, (item) => { item[field] = value; });
    }));
  }
  if (part.type === 'source' || part.type === 'current' || part.type === 'rail') {
    const unit = part.type === 'current' ? 'A' : 'V';
    add(select_row('Waveform', part.wave.shape, [['dc', 'DC'], ['sine', 'Sine'], ['square', 'Square'], ['triangle', 'Triangle']],
      (shape) => edit(part, (item) => { item.wave = wave_from(shape, item.wave); })));
    for (const { field, label, unit: field_unit } of wave_fields(part.wave, unit)) {
      add(field_row(label, part.wave[field], field_unit, (value) => {
        if ((field === 'frequency' && value <= 0) || (field === 'duty' && (value <= 0 || value >= 1))) return;
        edit(part, (item) => { item.wave = { ...item.wave, [field]: value }; });
      }));
    }
  }
  if (part.type === 'logic') {
    add(field_row('High level', part.high, 'V', (value) => edit(part, (item) => { item.high = value; })));
    add(check_row('Clocked', part.clock, (value) => edit(part, (item) => { item.clock = value; })));
    if (part.clock) add(field_row('Frequency', part.frequency, 'Hz', (value) => { if (value > 0) edit(part, (item) => { item.frequency = value; }); }));
    else add(check_row('High', part.on, (value) => edit(part, (item) => { item.on = value; })));
  }
  if (part.type === 'switch') add(check_row('Closed', part.closed, (value) => edit(part, (item) => { item.closed = value; })));
  if (part.type === 'led') {
    add(select_row('Colour', part.color, Object.keys(led_colors).map((key) => [key, key[0].toUpperCase() + key.slice(1)]),
      (color) => edit(part, (item) => { item.color = color; })));
  }

  if (part.type !== 'ground') {
    const readout = html('dl', { class: 'readout' });
    const live = (label, read) => {
      const dd = html('dd');
      readout.append(html('dt', {}, label), dd);
      live_fields.push({ dd, read });
    };
    if (part.type === 'regulator') {
      live('State', () => regulator_states[sim_lookup.get(part.id)?.state] || '—');
      live('Input', () => format_value(part_readings(part).v1, 'V', 4));
      live('Output', () => format_value(part_readings(part).v2, 'V', 4));
      live('Current', () => format_value(part_readings(part).current ?? 0, 'A', 4));
      live('Heat', () => {
        const { across, current } = part_readings(part);
        return format_value(Math.max(0, across * (current ?? 0)), 'W', 3);
      });
    } else if (single_ended.has(part.type) || part.type === 'wire') live('Voltage', () => format_value(part_readings(part).v1, 'V', 4));
    else live('Across', () => format_value((part.type === 'source' ? -1 : 1) * part_readings(part).across, 'V', 4));
    if (part.type !== 'regulator') live('Current', () => format_value(part_readings(part).current ?? 0, 'A', 4));
    if (!['wire', 'switch', 'regulator'].includes(part.type)) {
      live('Power', () => {
        const { across, current, v1 } = part_readings(part);
        const volts = single_ended.has(part.type) ? v1 : across;
        return format_value(Math.abs(volts * (current ?? 0)), 'W', 3);
      });
    }
    add(readout);
  }

  const row = html('div', { class: 'row' });
  if (part.type !== 'ground') {
    const probing = state.probes.some((probe) => probe.kind === 'current' && probe.id === part.id);
    const probe_button = html('button', { class: 'pill ghost' }, probing ? 'Stop plotting' : 'Plot current');
    probe_button.addEventListener('click', () => { toggle_probe(part, null); render_inspector(); });
    row.append(probe_button);
  }
  const remove = html('button', { class: 'pill ghost' }, 'Delete');
  remove.addEventListener('click', delete_selected);
  row.append(remove);
  add(row);
  update_live();
}

function render_circuit_panel() {
  const index = presets.findIndex((item) => item.note === state.note);
  const preset = presets[index];
  inspector.append(html('p', { class: 'kicker' }, preset ? `Example ${String(index + 1).padStart(2, '0')} of ${String(presets.length).padStart(2, '0')}` : 'Your circuit'));
  inspector.append(html('h2', { class: 'example' }, preset ? preset.name : 'Circuit'));
  if (preset) {
    inspector.append(html('p', { class: 'note' }, preset.note));
    const try_it = html('p', { class: 'try' });
    try_it.append(html('b', {}, 'Try this'), document.createTextNode(preset.try));
    inspector.append(try_it);
  } else {
    inspector.append(html('p', { class: 'note' }, 'Pick a part on the left and drag between two grid points to place it. Select a part to change it.'));
  }
  inspector.append(html('p', { class: 'kicker section' }, 'Simulation'));
  inspector.append(field_row('Time step', state.settings.timestep, 's', (value) => {
    if (value <= 0) return;
    commit(); state.settings.timestep = value; changed();
  }));
  inspector.append(field_row('Scope width', state.settings.span, 's', (value) => {
    if (value <= 0) return;
    commit(); state.settings.span = value; clear_scope(); changed(); update_speed_label();
  }));
}

function update_live() {
  for (const { dd, read } of live_fields) dd.textContent = error ? '—' : read();
}

// ---------- Scope ----------

const scope_canvas = $('#scope');
const legend = $('#legend');

function render_legend() {
  legend.replaceChildren();
  if (!state.probes.length) {
    legend.append(html('span', { class: 'empty' }, 'Use the probe tool (O) to plot a voltage or a current here.'));
    return;
  }
  state.probes.forEach((probe, index) => {
    const chip = html('span', { class: 'chip' });
    const dot = html('i');
    dot.style.background = probe_color(index);
    const value = html('span', { 'data-probe': index });
    const remove = html('button', { 'aria-label': 'Remove probe' }, '×');
    remove.addEventListener('click', () => {
      commit(); state.probes.splice(index, 1); clear_scope(); changed({ keep_inspector: true });
    });
    chip.append(dot, html('span', {}, probe_name(probe, index)), value, remove);
    legend.append(chip);
  });
}

function update_legend_values() {
  state.probes.forEach((probe, index) => {
    const span = legend.querySelector(`[data-probe="${index}"]`);
    if (!span) return;
    const series = scope_buffer.series[index];
    const value = series?.length ? series.at(-1) : probe_value(probe);
    span.textContent = error ? '' : format_value(value, probe.kind === 'voltage' ? 'V' : 'A', 3);
  });
}

function nice_step(range, count) {
  const raw = range / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

const axis_memory = { voltage: null, current: null };

function draw_scope() {
  const ratio = window.devicePixelRatio || 1;
  const width = scope_canvas.clientWidth, height = scope_canvas.clientHeight;
  if (scope_canvas.width !== Math.round(width * ratio) || scope_canvas.height !== Math.round(height * ratio)) {
    scope_canvas.width = Math.round(width * ratio); scope_canvas.height = Math.round(height * ratio);
  }
  const ctx = scope_canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const style = getComputedStyle(document.documentElement);
  const ink = style.getPropertyValue('--fg').trim(), muted = style.getPropertyValue('--muted').trim(), line = style.getPropertyValue('--line').trim();
  ctx.clearRect(0, 0, width, height);
  const left = 54, right = state.probes.some((probe) => probe.kind === 'current') ? 64 : 16, top = 40, bottom = 24;
  const plot_w = width - left - right, plot_h = height - top - bottom;
  if (plot_w < 40 || plot_h < 20) return;
  const now = sim ? sim.time : 0;
  const span = state.settings.span;
  const t0 = Math.max(0, now - span);
  const t_end = t0 + span;
  const x_of = (t) => left + (t - t0) / span * plot_w;

  const times = scope_buffer.times;
  let first = 0;
  while (first < times.length && times[first] < t0) first++;
  const ranges = { voltage: [Infinity, -Infinity], current: [Infinity, -Infinity] };
  state.probes.forEach((probe, index) => {
    const series = scope_buffer.series[index] || [];
    const range = ranges[probe.kind];
    for (let i = first; i < series.length; i++) { range[0] = Math.min(range[0], series[i]); range[1] = Math.max(range[1], series[i]); }
  });
  const axes = {};
  for (const kind of ['voltage', 'current']) {
    let [low, high] = ranges[kind];
    if (!Number.isFinite(low)) { low = 0; high = kind === 'voltage' ? 1 : 1e-3; }
    low = Math.min(low, 0); high = Math.max(high, 0);
    if (high - low < (kind === 'voltage' ? 1e-3 : 1e-9)) { high += kind === 'voltage' ? 0.5 : 5e-4; low -= kind === 'voltage' ? 0.5 : 5e-4; }
    const pad = (high - low) * 0.08;
    low -= pad; high += pad;
    // the axis grows at once but shrinks slowly, so it doesn't jitter
    const memory = axis_memory[kind];
    if (memory) {
      low = low < memory[0] ? low : memory[0] + (low - memory[0]) * 0.05;
      high = high > memory[1] ? high : memory[1] + (high - memory[1]) * 0.05;
    }
    axis_memory[kind] = [low, high];
    axes[kind] = { low, high, y_of: (value) => top + (high - value) / (high - low) * plot_h };
  }

  ctx.font = '500 10px "JetBrains Mono", monospace';
  ctx.lineWidth = 1;
  // time grid
  const t_step = nice_step(span, Math.max(2, Math.floor(plot_w / 110)));
  ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = Math.ceil(t0 / t_step) * t_step; t <= t_end + 1e-12; t += t_step) {
    const x = Math.round(x_of(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plot_h); ctx.stroke();
    const label = format_value(t, 's', 3);
    const half = ctx.measureText(label).width / 2;
    ctx.fillText(label, Math.min(x, width - half - 4), top + plot_h + 6);
  }
  // voltage grid on the left
  const has_voltage = state.probes.some((probe) => probe.kind === 'voltage');
  const has_current = state.probes.some((probe) => probe.kind === 'current');
  const main = has_voltage || !has_current ? 'voltage' : 'current';
  const axis = axes[main];
  const v_step = nice_step(axis.high - axis.low, Math.max(2, Math.floor(plot_h / 34)));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = Math.ceil(axis.low / v_step) * v_step; v <= axis.high; v += v_step) {
    const y = Math.round(axis.y_of(v)) + 0.5;
    ctx.strokeStyle = Math.abs(v) < v_step / 2 ? muted : line;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + plot_w, y); ctx.stroke();
    ctx.fillText(format_value(Math.abs(v) < v_step / 1e6 ? 0 : v, main === 'voltage' ? 'V' : 'A', 3), left - 6, y);
  }
  if (has_voltage && has_current) {
    const current_axis = axes.current;
    const i_step = nice_step(current_axis.high - current_axis.low, Math.max(2, Math.floor(plot_h / 34)));
    ctx.textAlign = 'left';
    for (let i = Math.ceil(current_axis.low / i_step) * i_step; i <= current_axis.high; i += i_step) {
      ctx.fillText(format_value(Math.abs(i) < i_step / 1e6 ? 0 : i, 'A', 3), left + plot_w + 6, current_axis.y_of(i));
    }
  }
  ctx.strokeStyle = muted;
  ctx.strokeRect(left + 0.5, top + 0.5, plot_w - 1, plot_h - 1);

  // traces
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, plot_w, plot_h); ctx.clip();
  state.probes.forEach((probe, index) => {
    const series = scope_buffer.series[index];
    if (!series || series.length < 2) return;
    const { y_of } = axes[probe.kind];
    ctx.strokeStyle = probe_color(index);
    ctx.beginPath();
    for (let i = Math.max(0, first - 1); i < series.length; i++) {
      const x = x_of(times[i]), y = y_of(series[i]);
      if (i === Math.max(0, first - 1)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  ctx.restore();
  if (error) {
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.font = '500 12px "Inter Tight", sans-serif';
    ctx.fillText('Stopped', left + plot_w / 2, top + plot_h / 2);
  }
}

// ---------- Top bar ----------

const run_button = $('#run');
function set_running(running) {
  state.running = running;
  run_button.textContent = running ? 'Pause' : 'Run';
}
run_button.addEventListener('click', () => set_running(!state.running));
$('#reset').addEventListener('click', () => { rebuild({ reset: true }); axis_memory.voltage = axis_memory.current = null; render_board(); show_banner(); });

const speed_input = $('#speed');
const speed_out = $('#speed-out');
function update_speed_label() {
  speed_out.textContent = `${format_value(speed(), 's', 2)}/s${slowed ? ' (max)' : ''}`;
}
speed_input.addEventListener('input', () => { state.speed_factor = 10 ** Number(speed_input.value); update_speed_label(); });

const preset_select = $('#preset');
preset_select.append(html('option', { value: '' }, 'Your circuit'));
for (const preset of presets) preset_select.append(html('option', { value: preset.id }, preset.name));
preset_select.addEventListener('change', () => {
  const preset = presets.find((item) => item.id === preset_select.value);
  if (preset) { commit(); load_preset(preset); }
});

function load_preset(preset) {
  next_id = 1;
  state.parts = preset.parts.map((part) => ({ ...structuredClone(part), id: new_id() }));
  state.probes = structuredClone(preset.probes);
  state.settings = { ...preset.settings };
  state.note = preset.note;
  state.selected = null;
  state.speed_factor = 1; speed_input.value = 0;
  preset_select.value = preset.id;
  axis_memory.voltage = axis_memory.current = null;
  sim = null;
  changed({ reset: true });
  fit_view();
  update_speed_label();
  set_running(true);
}

$('#clear').addEventListener('click', () => {
  commit();
  state.parts = []; state.probes = []; state.note = ''; state.selected = null;
  state.settings = { timestep: 1e-5, span: 0.01 };
  preset_select.value = '';
  changed({ reset: true });
  fit_view();
  update_speed_label();
});

const help = $('#help-dialog');

// ---------- Title page ----------

const intro = $('#intro');
let has_saved_circuit = false;

function render_intro() {
  const list = $('#intro-examples');
  list.replaceChildren();
  presets.forEach((preset, index) => {
    const item = html('li');
    const button = html('button');
    button.append(html('span', { class: 'number' }, String(index + 1).padStart(2, '0')));
    const words = html('span');
    words.append(html('span', { class: 'name' }, preset.name), html('span', { class: 'blurb' }, preset.blurb));
    button.append(words, html('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'));
    button.addEventListener('click', () => { close_intro(); commit(); load_preset(preset); });
    item.append(button);
    list.append(item);
  });
  $('#intro-continue').hidden = !has_saved_circuit;
}

function open_intro() {
  render_intro();
  intro.hidden = false;
  $('#intro-start').focus();
}

function close_intro() {
  intro.hidden = true;
  fit_view();
}

$('#brand').addEventListener('click', open_intro);
$('#intro-start').addEventListener('click', () => { close_intro(); commit(); load_preset(presets[0]); });
$('#intro-continue').addEventListener('click', close_intro);
$('#intro-blank').addEventListener('click', () => { close_intro(); $('#clear').click(); });
for (const button of document.querySelectorAll('[data-help]')) button.addEventListener('click', () => help.showModal());

const toast = $('#toast');
let toast_timer = null;
function show_toast(text) {
  toast.textContent = text; toast.hidden = false;
  clearTimeout(toast_timer);
  toast_timer = setTimeout(() => { toast.hidden = true; }, 2200);
}

const to_base64 = (bytes) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const from_base64 = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));

async function encode_circuit() {
  const bytes = new TextEncoder().encode(snapshot());
  if ('CompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + to_base64(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return 'j' + to_base64(bytes);
}

async function decode_circuit(text) {
  const bytes = from_base64(text.slice(1));
  if (text[0] === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }
  return new TextDecoder().decode(bytes);
}

$('#share').addEventListener('click', async () => {
  let code;
  try { code = await encode_circuit(); } catch { show_toast('This circuit could not be made into a link'); return; }
  const url = `${location.origin}${location.pathname}#c=${code}`;
  history.replaceState(null, '', `#c=${code}`);
  try {
    await navigator.clipboard.writeText(url);
    show_toast('Link copied');
  } catch {
    show_toast('Link is in the address bar');
  }
});

// ---------- Tools ----------

const tools_nav = $('#tools');
function tool_icon(tool) {
  const svg = el('svg', { viewBox: '-17 -11 34 22', 'aria-hidden': 'true' });
  const stub = { ...(tool.make ? tool.make() : {}), type: tool.type };
  if (tool.type === 'select') {
    el('path', { d: 'M-5 -9 L-5 7 L-1 3 L2 9 L4.5 8 L1.5 2 L7 2 Z', class: 'fill' }, svg);
    return svg;
  }
  if (tool.type === 'probe') {
    el('path', { d: 'M-14 6 L-6 6 L-2 -6 L3 8 L7 0 L14 0' }, svg);
    return svg;
  }
  if (tool.type === 'wire') { el('path', { d: 'M-14 0 H14' }, svg); el('circle', { cx: -14, cy: 0, r: 1.8, class: 'fill' }, svg); el('circle', { cx: 14, cy: 0, r: 1.8, class: 'fill' }, svg); return svg; }
  if (tool.type === 'ground') { el('path', { d: 'M0 -9 V0 M-9 0 H9 M-5.5 4 H5.5 M-2 8 H2' }, svg); return svg; }
  if (tool.type === 'rail') { el('path', { d: 'M0 9 V-3' }, svg); el('circle', { cx: 0, cy: -5, r: 2.5, class: 'fill' }, svg); el('path', { d: 'M5 -6 h6 M8 -9 v6' }, svg); return svg; }
  if (tool.type === 'regulator') { el('rect', { x: -7, y: -8, width: 14, height: 11, rx: 1.5 }, svg); el('path', { d: 'M-17 -2.5 H-7 M7 -2.5 H17 M0 3 V10' }, svg); return svg; }
  if (tool.type === 'logic') { el('rect', { x: -9, y: -7, width: 18, height: 14, rx: 3 }, svg); el('path', { d: 'M0 -3.5 V3.5 M-1.5 -2.5 L0 -3.5' }, svg); return svg; }
  const body = body_of(stub);
  const scale = Math.min(1, 12 / Math.max(body.half, 1));
  const g = el('g', { transform: `scale(${scale})` }, svg);
  const half = body.half;
  el('path', { d: `M${-17 / scale} 0 H${-half} M${half} 0 H${17 / scale}` }, g);
  el('path', { d: body.d, class: body.filled ? 'fill' : '' }, g);
  return svg;
}

function render_tools() {
  tools_nav.replaceChildren();
  for (const tool of tools) {
    const button = html('button', { class: 'tool', 'aria-pressed': String(state.tool === tool.type), title: tool.name });
    button.append(tool_icon(tool));
    const name = html('span', { class: 'name' });
    name.append(html('span', { class: 'long' }, tool.name), html('span', { class: 'short' }, tool.short || tool.name));
    name.append(html('kbd', {}, tool.hint || tool.key));
    button.append(name);
    button.addEventListener('click', () => set_tool(tool.type));
    tools_nav.append(button);
  }
}

function set_tool(type) {
  state.tool = type;
  preview_key = null;
  hide_flip();
  overlay.replaceChildren();
  render_tools();
  render_board();
}

window.addEventListener('keydown', (event) => {
  if (event.target.closest?.('input, select, textarea') || help.open) return;
  if (!intro.hidden) { if (event.key === 'Escape') close_intro(); return; }
  const key = event.key;
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); delete_selected(); return; }
  if (key === ' ') { event.preventDefault(); set_running(!state.running); return; }
  if (key === 'f' || key === 'F') { fit_view(); return; }
  if (key === 'x' || key === 'X') { reverse_part(selected_part()); return; }
  if (key === 'Escape') {
    if (drag?.mode === 'place') { drag = null; overlay.replaceChildren(); return; }
    state.selected = null; set_tool('select'); render_inspector(); return;
  }
  const tool = tools.find((item) => item.key === key.toLowerCase());
  if (tool) set_tool(tool.type);
});

// ---------- Banner and loop ----------

const banner = $('#banner');
function show_banner() {
  if (error) {
    banner.textContent = error.message;
    banner.className = 'banner';
    banner.hidden = false;
  } else if (sim && Array.from(sim.voltages).some((v) => Math.abs(v) > 1e6)) {
    banner.textContent = 'Some point has no path for steady current, such as a current source with nowhere to go, '
      + 'so its voltage has run away. Give it a path, for example through a resistor.';
    banner.className = 'banner soft';
    banner.hidden = false;
  } else if (built && !built.has_ground && state.parts.length) {
    banner.textContent = 'There is no ground yet, so voltages are measured from an arbitrary point. Add one with G.';
    banner.className = 'banner soft';
    banner.hidden = false;
  } else banner.hidden = true;
}

const clock = $('#clock');
let last_frame = performance.now();
let frame_count = 0;
function frame(now) {
  const wall_dt = Math.min(0.05, (now - last_frame) / 1000);
  last_frame = now;
  if (!intro.hidden) { requestAnimationFrame(frame); return; }
  advance(wall_dt);
  paint(wall_dt);
  draw_scope();
  if (frame_count++ % 6 === 0) {
    update_live();
    update_legend_values();
    show_banner();
    clock.textContent = `t = ${format_value(sim ? sim.time : 0, 's', 3)}`;
    update_speed_label();
  }
  requestAnimationFrame(frame);
}

// The first fit waits until the board has its real size.
let fit_pending = true;
new ResizeObserver(() => {
  const rect = board.getBoundingClientRect();
  if (fit_pending && rect.width > 200 && rect.height > 100) { fit_pending = false; fit_view(); }
  else apply_view();
}).observe(board);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { read_palette(); render_board(); render_legend(); });

async function start() {
  read_palette();
  render_tools();
  let loaded = false;
  const hash = location.hash.match(/^#c=(.+)$/);
  if (hash) {
    try { restore(await decode_circuit(hash[1])); loaded = true; } catch { show_toast('That link could not be read'); }
    history.replaceState(null, '', location.pathname);
  }
  if (!loaded) {
    try {
      const saved = localStorage.getItem(storage_key);
      if (saved) { restore(saved); loaded = true; has_saved_circuit = true; }
    } catch { /* storage may be off */ }
  }
  if (!hash) open_intro();
  if (loaded) {
    const preset = presets.find((item) => item.note && item.note === state.note);
    preset_select.value = preset ? preset.id : '';
    changed({ reset: true });
    fit_view();
  } else load_preset(presets[0]);
  update_speed_label();
  requestAnimationFrame(frame);
}

start();
