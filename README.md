# Kirchhoff

A circuit simulator that runs in the browser. You draw a circuit on a grid and it is solved as it runs. Each wire
is coloured by its voltage, and dots move along it with the current. A scope plots any point you probe.

**Try it:** [quaot.github.io/kirchhoff](https://quaot.github.io/kirchhoff/)

## What it can do

- Resistors, capacitors, inductors, diodes, LEDs and switches, plus an adjustable regulator like the LM1117.
- DC, sine, square and triangle sources, as two-terminal sources or as single supply rails.
- Logic inputs, which can be set by hand or clocked. Clocked inputs at f, f/2, f/4 and so on count up in binary.
- A four-channel scope for node voltages and part currents.
- Click placement. A part clicked next to a point starts there and faces the likely way. Capacitors and LEDs hang
  toward ground. Diodes put their anode on the higher side, and sources put their positive end on the point.
  Hovering a part shows a button that turns it around.
- Links that hold the whole circuit, so a circuit can be shared without a server.

The examples include the 4-bit R-2R DAC from my
[R-2R DAC project](https://github.com/Quaot/R-2R_DAC). A counter drives the four inputs, and the output steps
through all 16 codes, from 0 to 3.09 V.

They also include the 3.3 V regulator from my [LDO board](https://github.com/Quaot/2-layer-PCB-LDO), with its
162 Ω and 267 Ω divider and a 500 mA load. The input sweeps down past 4.55 V, which is where the board runs out of
headroom, and the output falls away from 3.3 V on the scope.

## How it works

The solver uses modified nodal analysis. Each node voltage is an unknown, and so is the current through each
voltage source and inductor. Every time step builds the matrix and solves it by Gaussian elimination with partial
pivoting. That is fast enough here, since a drawn circuit rarely has more than a few dozen unknowns.

Capacitors and inductors are replaced at each step by a conductance and a current source, using the trapezoidal
rule. Just after a sudden change, such as a square-wave edge or a flipped switch, one step uses backward Euler
instead, which stops the trapezoidal rule from ringing on the jump. Diodes follow the Shockley equation and are
solved by Newton's method, with the same step limit SPICE uses so that the exponential cannot overflow.

The regulator is a model of how the LM1117-ADJ behaves, not of its transistors. It holds OUT 1.25 V above ADJ and
sources about 60 µA from ADJ. When the input gets too close to the output it drops out, with a dropout voltage of
1 V plus 0.5 Ω times the load current. That is 1.25 V at 500 mA, the datasheet figure. Each step tries the
regulator's states until it finds the one that fits.

Wires are not part of the matrix. Every group of joined wires becomes one node, so the solver never sees them. The
current along each wire is worked out afterwards from Kirchhoff's current law, by walking each wire group as a
tree. The dots on the wires come from that.

```
src/
  solver.js    sets up the circuit's equations and solves them at each step
  netlist.js   turns drawn parts into nodes, and works out wire currents
  parts.js     symbols and the fields each part can edit
  placement.js where a part goes when it is placed with a click
  presets.js   the example circuits
  app.js       the editor, the drawing and the scope
```

## Tests

```
npm test
```

The tests check the solver against results worked out by hand. They cover a divider, RC and RL time constants,
the frequency and amplitude of an LC tank, a diode's forward drop, a half-wave rectifier, all 16 codes of the R-2R
ladder and the regulator's output and dropout point.

## Running it locally

It is plain HTML and JavaScript with no build step. Serve the folder and open it:

```
python -m http.server 8010
```
