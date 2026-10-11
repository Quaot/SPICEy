// Modified nodal analysis. Node 0 is ground. Every element's current is measured from terminal a to terminal b
// through the element itself.

const thermal_voltage = 0.025852;
const gmin = 1e-12;

export class SolveError extends Error {}

export function source_value(wave, time) {
  switch (wave.shape) {
    case 'sine':
      return wave.offset + wave.amplitude * Math.sin(2 * Math.PI * wave.frequency * time + (wave.phase || 0));
    case 'square': {
      const phase = (time * wave.frequency) % 1;
      return wave.offset + (phase < (wave.duty ?? 0.5) ? wave.amplitude : -wave.amplitude);
    }
    case 'triangle': {
      const phase = (time * wave.frequency + 0.25) % 1;
      return wave.offset + wave.amplitude * (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase);
    }
    default:
      return wave.value;
  }
}

function square_edge(wave, t0, t1) {
  if (wave.shape !== 'square') return false;
  const duty = wave.duty ?? 0.5;
  const edges = (t) => Math.floor(t * wave.frequency) * 2 + ((t * wave.frequency) % 1 >= duty ? 1 : 0);
  return edges(t0) !== edges(t1);
}

function solve_dense(matrix, rhs) {
  const size = rhs.length;
  for (let col = 0; col < size; col++) {
    let pivot = col;
    let best = Math.abs(matrix[col][col]);
    for (let row = col + 1; row < size; row++) {
      const size_here = Math.abs(matrix[row][col]);
      if (size_here > best) { best = size_here; pivot = row; }
    }
    if (best < 1e-18) throw new SolveError('singular');
    if (pivot !== col) {
      [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
      [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    }
    const pivot_row = matrix[col];
    for (let row = col + 1; row < size; row++) {
      const factor = matrix[row][col] / pivot_row[col];
      if (factor === 0) continue;
      const target = matrix[row];
      for (let k = col; k < size; k++) target[k] -= factor * pivot_row[k];
      rhs[row] -= factor * rhs[col];
    }
  }
  const result = new Float64Array(size);
  for (let row = size - 1; row >= 0; row--) {
    let sum = rhs[row];
    for (let k = row + 1; k < size; k++) sum -= matrix[row][k] * result[k];
    result[row] = sum / matrix[row][row];
  }
  return result;
}

// SPICE's pn-junction step limit: keeps Newton from jumping into exp() overflow.
function limit_junction(v_new, v_old, n_vt, v_crit) {
  if (v_new > v_crit && Math.abs(v_new - v_old) > 2 * n_vt) {
    if (v_old > 0) {
      const arg = 1 + (v_new - v_old) / n_vt;
      return arg > 0 ? v_old + n_vt * Math.log(arg) : v_crit;
    }
    return n_vt * Math.log(v_new / n_vt);
  }
  return v_new;
}

export class Simulator {
  // netlist: { node_count, elements: [{ id, kind, a, b, ...}] }, node_count counts ground.
  constructor(netlist) {
    this.node_count = netlist.node_count;
    this.elements = netlist.elements.map((element) => ({ ...element }));
    this.time = 0;
    this.branch_count = 0;
    for (const element of this.elements) {
      if (element.kind === 'V' || element.kind === 'L') element.branch = this.node_count - 1 + this.branch_count++;
      if (element.kind === 'C' || element.kind === 'L') { element.v_prev = 0; element.i_prev = 0; }
      if (element.kind === 'D') {
        element.saturation = element.saturation ?? 1e-14;
        element.n_vt = (element.emission ?? 1) * thermal_voltage;
        element.v_crit = element.n_vt * Math.log(element.n_vt / (Math.SQRT2 * element.saturation));
        element.v_guess = 0;
      }
      element.current = 0;
    }
    this.size = this.node_count - 1 + this.branch_count;
    this.voltages = new Float64Array(this.node_count);
    this.matrix = Array.from({ length: this.size }, () => new Float64Array(this.size));
    this.rhs = new Float64Array(this.size);
    this.backward_euler_next = true;
  }

  voltage(node) {
    return this.voltages[node];
  }

  across(element) {
    return this.voltages[element.a] - this.voltages[element.b];
  }

  // mode: 'dc', 'trap' or 'euler'
  assemble(mode, dt, time) {
    const { matrix, rhs } = this;
    for (const row of matrix) row.fill(0);
    rhs.fill(0);
    const conductance = (a, b, g) => {
      if (a) matrix[a - 1][a - 1] += g;
      if (b) matrix[b - 1][b - 1] += g;
      if (a && b) { matrix[a - 1][b - 1] -= g; matrix[b - 1][a - 1] -= g; }
    };
    // a current `amount` driven out of node b and into node a through the element
    const inject = (a, b, amount) => {
      if (a) rhs[a - 1] += amount;
      if (b) rhs[b - 1] -= amount;
    };
    const branch_stamp = (element) => {
      const k = element.branch;
      if (element.a) { matrix[element.a - 1][k] += 1; matrix[k][element.a - 1] += 1; }
      if (element.b) { matrix[element.b - 1][k] -= 1; matrix[k][element.b - 1] -= 1; }
      return k;
    };

    for (let node = 1; node < this.node_count; node++) matrix[node - 1][node - 1] += gmin;

    for (const element of this.elements) {
      const { a, b } = element;
      switch (element.kind) {
        case 'R':
          conductance(a, b, 1 / element.resistance);
          break;
        case 'I':
          inject(b, a, source_value(element.wave, time));
          break;
        case 'V': {
          const k = branch_stamp(element);
          rhs[k] += source_value(element.wave, time);
          break;
        }
        case 'C': {
          if (mode === 'dc') break;
          const g = (mode === 'trap' ? 2 : 1) * element.capacitance / dt;
          const history = g * element.v_prev + (mode === 'trap' ? element.i_prev : 0);
          conductance(a, b, g);
          inject(a, b, history);
          break;
        }
        case 'L': {
          const k = branch_stamp(element);
          if (mode === 'dc') break;
          const z = (mode === 'trap' ? 2 : 1) * element.inductance / dt;
          matrix[k][k] -= z;
          rhs[k] -= z * element.i_prev + (mode === 'trap' ? element.v_prev : 0);
          break;
        }
        case 'D': {
          const v = element.v_guess;
          const exponent = Math.exp(Math.min(v / element.n_vt, 80));
          const current = element.saturation * (exponent - 1);
          const g = element.saturation * exponent / element.n_vt + gmin;
          conductance(a, b, g);
          inject(a, b, g * v - current);
          break;
        }
      }
    }
    return { matrix, rhs };
  }

  solve_point(mode, dt, time) {
    const nonlinear = this.elements.some((element) => element.kind === 'D');
    const iterations = nonlinear ? 200 : 1;
    let solution = null;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const { matrix, rhs } = this.assemble(mode, dt, time);
      solution = solve_dense(matrix, rhs);
      if (!nonlinear) break;
      let converged = true;
      for (const element of this.elements) {
        if (element.kind !== 'D') continue;
        const va = element.a ? solution[element.a - 1] : 0;
        const vb = element.b ? solution[element.b - 1] : 0;
        const v_raw = va - vb;
        const v_next = limit_junction(v_raw, element.v_guess, element.n_vt, element.v_crit);
        if (Math.abs(v_next - element.v_guess) > 1e-6 + 1e-4 * Math.abs(v_next)) converged = false;
        element.v_guess = v_next;
      }
      if (converged && iteration > 0) break;
      if (iteration === iterations - 1) throw new SolveError('no convergence');
    }
    this.voltages[0] = 0;
    for (let node = 1; node < this.node_count; node++) this.voltages[node] = solution[node - 1];
    return solution;
  }

  update_currents(solution, mode, dt, time) {
    for (const element of this.elements) {
      const v = this.across(element);
      switch (element.kind) {
        case 'R': element.current = v / element.resistance; break;
        case 'I': element.current = source_value(element.wave, time); break;
        case 'V': element.current = solution[element.branch]; break;
        case 'L':
          element.current = solution[element.branch];
          element.i_prev = element.current;
          element.v_prev = mode === 'dc' ? 0 : v;
          break;
        case 'C': {
          if (mode === 'dc') { element.current = 0; }
          else {
            const g = (mode === 'trap' ? 2 : 1) * element.capacitance / dt;
            element.current = g * (v - element.v_prev) - (mode === 'trap' ? element.i_prev : 0);
          }
          element.v_prev = v;
          element.i_prev = element.current;
          break;
        }
        case 'D':
          element.current = element.saturation * (Math.exp(Math.min(v / element.n_vt, 80)) - 1);
          break;
      }
    }
  }

  operating_point() {
    const solution = this.solve_point('dc', 0, this.time);
    this.update_currents(solution, 'dc', 0, this.time);
    this.backward_euler_next = true;
  }

  step(dt) {
    const t_next = this.time + dt;
    let mode = 'trap';
    if (this.backward_euler_next) mode = 'euler';
    for (const element of this.elements) {
      if ((element.kind === 'V' || element.kind === 'I') && square_edge(element.wave, this.time, t_next)) mode = 'euler';
    }
    this.backward_euler_next = false;
    const solution = this.solve_point(mode, dt, t_next);
    this.update_currents(solution, mode, dt, t_next);
    this.time = t_next;
  }

  // For changes made while running, such as flipping a logic input.
  set_value(id, field, value) {
    const element = this.elements.find((item) => item.id === id);
    if (!element) return;
    if (field === 'wave') element.wave = value;
    else element[field] = value;
    this.backward_euler_next = true;
  }
}
