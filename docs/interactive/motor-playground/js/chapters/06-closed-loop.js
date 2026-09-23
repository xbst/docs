/**
 * Chapter 6 stub: Open loop vs closed loop (SPEC 6.6). Chunk 06 replaces this file.
 */
let loop = 'openloop';

export default {
  id: 'closed-loop', number: 6, title: 'Open loop vs closed loop', short: 'Closed loop',
  takeaway: 'An open-loop driver hopes the rotor followed. A closed-loop driver knows, and fixes it.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.5, min: 0.05, max: 1 },
  traceWindow: 2.0,
  stage: { primary: 'gantry', secondary: null },

  scenario(motorType) {
    return { motorType, motorPreset: 'stepper', driver: loop, driverMode: loop === 'foc' ? 'position' : 'current',
      mechanics: 'corexy', path: 'square100', planner: { maxVelocity: 150, accel: 5000, scv: 5, microsteps: 16, fullStepsPerRev: 200 } };
  },

  // scenario() runs before onEnter, so chapter state is reset on leave.
  onLeave() { loop = 'openloop'; },
  onEnter(ctx) { ctx.world.command('runPath', { name: 'square100' }); },

  controls() {
    return [
      { type: 'segmented', id: 'loop', label: 'Loop', value: loop,
        options: [{ value: 'openloop', label: 'Open loop' }, { value: 'foc', label: 'Closed loop (FOC)' }],
        onChange: (v, c) => { loop = v; c.app.reconfigure(); c.world.command('runPath', { name: 'square100' }); } },
      { type: 'button', id: 'bump', label: 'Bump', kind: 'primary', onClick: (c) => c.world.command('bump') },
      { type: 'note', html: 'Coming soon.' },
    ];
  },

  traces: [
    { name: 'posCmd', motor: 0, label: 'Commanded X', unit: 'mm', color: 'target', dashed: true },
    { name: 'posAct', motor: 0, label: 'Actual X', unit: 'mm', color: 'phase-a' },
    { name: 'posErr', motor: 0, label: 'Position error X', unit: 'mm', scale: 'err', color: 'axis-q' },
  ],

  readouts(snap) {
    return [
      { label: 'Error', value: Math.hypot(snap.gantry.x - snap.gantry.xCmd, snap.gantry.y - snap.gantry.yCmd), unit: 'mm', digits: 2 },
      { label: 'Lost', value: snap.gantry.lostMm[0] || 0, unit: 'mm', digits: 1 },
    ];
  },

  text: () => '<p>Coming soon. This chapter will compare an open-loop stepper with a closed-loop driver.</p>',
  tryThis: ['Press Bump in both loop modes.'],
};
