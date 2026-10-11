// Turns the drawn parts into a netlist for the solver, and works out the current along each wire afterwards.

export const point_key = (x, y) => `${x},${y}`;

const single_ended = new Set(['ground', 'rail', 'logic']);

export function part_points(part) {
  if (single_ended.has(part.type)) return [point_key(part.x1, part.y1)];
  return [point_key(part.x1, part.y1), point_key(part.x2, part.y2)];
}

export function joins(part) {
  return part.type === 'wire' || (part.type === 'switch' && part.closed);
}

class Groups {
  constructor() { this.parent = new Map(); }
  find(key) {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(key) !== root) {
      const next = this.parent.get(key);
      this.parent.set(key, root);
      key = next;
    }
    return root;
  }
  join(a, b) {
    const root_a = this.find(a);
    const root_b = this.find(b);
    if (root_a !== root_b) this.parent.set(root_a, root_b);
  }
}

const dc = (value) => ({ shape: 'dc', value });

// A clocked input starts low and goes high halfway through each period, so inputs at f, f/2, f/4... count up in binary.
export function logic_wave(part) {
  if (part.clock) return { shape: 'square', offset: part.high / 2, amplitude: -part.high / 2, frequency: part.frequency, duty: 0.5 };
  return dc(part.on ? part.high : 0);
}

export function build_netlist(parts) {
  const groups = new Groups();
  for (const part of parts) {
    const points = part_points(part);
    for (const point of points) groups.find(point);
    if (joins(part)) groups.join(points[0], points[1]);
  }

  // Wire groups first, before ground merges them: the wire currents are worked out per wire group.
  const wire_group = new Map();
  for (const key of groups.parent.keys()) wire_group.set(key, groups.find(key));

  const ground_points = parts.filter((part) => part.type === 'ground').map((part) => part_points(part)[0]);
  for (let i = 1; i < ground_points.length; i++) groups.join(ground_points[0], ground_points[i]);
  const ground_root = ground_points.length ? groups.find(ground_points[0]) : null;

  const node_of_root = new Map();
  if (ground_root) node_of_root.set(ground_root, 0);
  let node_count = 1;
  const point_node = new Map();
  for (const key of groups.parent.keys()) {
    const root = groups.find(key);
    if (!node_of_root.has(root)) node_of_root.set(root, node_count++);
    point_node.set(key, node_of_root.get(root));
  }

  const elements = [];
  const terminals = [];   // where each element's current enters or leaves the wires
  const problems = [];
  const add = (part, element, a_point, b_point) => {
    element.id = part.id;
    elements.push(element);
    if (a_point) terminals.push({ id: part.id, point: a_point, sign: -1 });
    if (b_point) terminals.push({ id: part.id, point: b_point, sign: 1 });
  };

  for (const part of parts) {
    const [p1, p2] = part_points(part);
    const n1 = point_node.get(p1);
    const n2 = p2 === undefined ? 0 : point_node.get(p2);
    switch (part.type) {
      case 'resistor':
        add(part, { kind: 'R', a: n1, b: n2, resistance: part.resistance }, p1, p2);
        break;
      case 'capacitor':
        add(part, { kind: 'C', a: n1, b: n2, capacitance: part.capacitance }, p1, p2);
        break;
      case 'inductor':
        add(part, { kind: 'L', a: n1, b: n2, inductance: part.inductance }, p1, p2);
        break;
      case 'diode':
        add(part, { kind: 'D', a: n1, b: n2 }, p1, p2);
        break;
      case 'led':
        add(part, { kind: 'D', a: n1, b: n2, saturation: 1e-20, emission: 1.9 }, p1, p2);
        break;
      case 'source':   // terminal 2 is the positive end
        if (n1 === n2) problems.push({ id: part.id, message: 'This source is shorted out, so the circuit has no solution.' });
        add(part, { kind: 'V', a: n2, b: n1, wave: part.wave }, p2, p1);
        break;
      case 'current':  // pushes current out of terminal 2
        add(part, { kind: 'I', a: n1, b: n2, wave: part.wave }, p1, p2);
        break;
      case 'rail':
        if (n1 === 0) problems.push({ id: part.id, message: 'This supply is wired straight to ground.' });
        add(part, { kind: 'V', a: n1, b: 0, wave: part.wave }, p1, null);
        break;
      case 'logic':
        if (n1 === 0) problems.push({ id: part.id, message: 'This input is wired straight to ground.' });
        add(part, { kind: 'V', a: n1, b: 0, wave: logic_wave(part) }, p1, null);
        break;
    }
  }

  return {
    netlist: { node_count, elements },
    point_node,
    wire_group,
    ground_points: new Set(ground_points),
    terminals,
    problems,
    has_ground: ground_points.length > 0,
  };
}

// Current along every wire and closed switch, from the part currents and Kirchhoff's current law. Each wire group is
// walked as a tree; a wire that closes a loop inside one group carries no current here, since the solver treats the
// whole group as a single node and the split is not defined.
export function wire_currents(parts, built, element_current) {
  const net_in = new Map();
  for (const terminal of built.terminals) {
    const current = element_current(terminal.id);
    net_in.set(terminal.point, (net_in.get(terminal.point) || 0) + terminal.sign * current);
  }

  const edges = new Map();
  const result = new Map();
  for (const part of parts) {
    if (!joins(part)) continue;
    const [p1, p2] = part_points(part);
    result.set(part.id, 0);
    if (p1 === p2) continue;
    if (!edges.has(p1)) edges.set(p1, []);
    if (!edges.has(p2)) edges.set(p2, []);
    edges.get(p1).push({ id: part.id, to: p2, forward: true });
    edges.get(p2).push({ id: part.id, to: p1, forward: false });
  }

  const seen = new Set();
  const members_by_group = new Map();
  for (const key of edges.keys()) {
    const group = built.wire_group.get(key);
    if (!members_by_group.has(group)) members_by_group.set(group, []);
    members_by_group.get(group).push(key);
  }

  for (const members of members_by_group.values()) {
    const root = members.find((key) => built.ground_points.has(key)) ?? members[0];
    const order = [];
    const parent_edge = new Map();
    const stack = [root];
    seen.add(root);
    while (stack.length) {
      const key = stack.pop();
      order.push(key);
      for (const edge of edges.get(key)) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        parent_edge.set(edge.to, { ...edge, from: key });
        stack.push(edge.to);
      }
    }
    const subtree = new Map(order.map((key) => [key, net_in.get(key) || 0]));
    for (let i = order.length - 1; i > 0; i--) {
      const key = order[i];
      const edge = parent_edge.get(key);
      const flow_to_parent = subtree.get(key);
      // edge.forward means the wire runs from parent (x1) to this point (x2)
      result.set(edge.id, edge.forward ? -flow_to_parent : flow_to_parent);
      subtree.set(edge.from, subtree.get(edge.from) + flow_to_parent);
    }
  }
  return result;
}
