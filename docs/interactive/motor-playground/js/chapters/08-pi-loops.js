/**
 * Chapter 8 stub: The four PI loops (SPEC 6.8). Chunk 07 replaces this file.
 * Its velocity-P slider carries a product caption (?product=ouroboros).
 */
export default {
  id: 'pi-loops', number: 8, title: 'The four PI loops', short: 'PI loops',
  takeaway: 'Position asks velocity, velocity asks torque, torque asks the coils. Tune from the inside out.',
  motorTypes: ['stepper', 'bldc'],
  timeScale: { default: 0.25, min: 0.01, max: 1 },
  traceWindow: 2.0,
  stage: { primary: 'gantry', secondary: 'blocks', split: 0.55 },

  scenario(motorType) {
    return { motorType, motorPreset: motorType === 'bldc' ? 'bldc' : 'stepper', driver: 'foc', driverMode: 'position',
      mechanics: 'corexy', path: 'square100' };
  },

  onEnter(ctx) { ctx.world.command('runPath', { name: 'square100' }); },

  controls(ctx) {
    const note = ctx.product.notes.pi;
    return [
      { type: 'slider', id: 'velocityP', label: 'Velocity P', min: 0.1, max: 10, step: 0.01, log: true, value: 1,
        format: (v) => '×' + v.toFixed(2), caption: ctx.product.keys.velocityP, group: 'Velocity loop',
        onChange: (v, c) => { c.highlight = 'velocity'; c.world.set('foc.gains.velocityP', v); } },
      { type: 'slider', id: 'velocityI', label: 'Velocity I', min: 0.1, max: 10, step: 0.01, log: true, value: 1,
        format: (v) => '×' + v.toFixed(2), caption: ctx.product.keys.velocityI, group: 'Velocity loop',
        onChange: (v, c) => { c.highlight = 'velocity'; c.world.set('foc.gains.velocityI', v); } },
      { type: 'note', html: 'Coming soon.' + (note ? ' ' + note : '') },
    ];
  },

  traces: [
    { name: 'posCmd', motor: 0, label: 'Commanded X', unit: 'mm', color: 'target', dashed: true },
    { name: 'posAct', motor: 0, label: 'Actual X', unit: 'mm', color: 'phase-a' },
    { name: 'iq', motor: 0, label: 'Torque current (Iq)', unit: 'A', color: 'axis-q' },
  ],

  readouts(snap, metrics) {
    return [
      { label: 'Overshoot', value: metrics.overshootPct, unit: '%', digits: 1 },
      { label: 'Corner error', value: metrics.cornerErrMm, unit: 'mm', digits: 2, warn: metrics.cornerErrMm > 0.15 },
    ];
  },

  text: () => '<p>Coming soon. This chapter will show what each of the four PI loops does.</p>',
  tryThis: ['Move the velocity P slider.'],
};
