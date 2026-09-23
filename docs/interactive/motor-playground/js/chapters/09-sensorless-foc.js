/**
 * Chapter 9 stub: Sensorless homing with FOC (SPEC 6.9). Chunk 07 replaces
 * this file. Its homing-current slider carries a product caption.
 */
export default {
  id: 'sensorless-foc', number: 9, title: 'Sensorless homing with FOC', short: 'Sensorless',
  takeaway: 'With FOC, stall detection is a current-limit comparison, not a guess.',
  motorTypes: ['stepper', 'bldc'],
  timeScale: { default: 0.25, min: 0.01, max: 1 },
  traceWindow: 2.0,
  stage: { primary: 'gantry', secondary: 'blocks', split: 0.6 },
  viewOptions: { blocks: { compact: true } },

  scenario(motorType) {
    return { motorType, motorPreset: motorType === 'bldc' ? 'bldc' : 'stepper', driver: 'foc', driverMode: 'position',
      mechanics: 'axis', hardStops: true, foc: { homingCurrent: 0.5, homingSpeedMmS: 40, retractMm: 5 } };
  },

  controls(ctx) {
    return [
      { type: 'slider', id: 'homingCurrent', label: 'Homing current limit', min: 0.2, max: 3.5, step: 0.05, value: 0.5, unit: 'A',
        caption: ctx.product.keys.homingCurrent, onChange: (v, c) => c.world.set('foc.homingCurrent', v) },
      { type: 'slider', id: 'retract', label: 'Retract distance', min: 0, max: 5, step: 0.5, value: 5, unit: 'mm',
        caption: ctx.product.keys.retract, onChange: (v, c) => c.world.set('foc.retractMm', v) },
      { type: 'button', id: 'home', label: 'Home', kind: 'primary', onClick: (c) => c.world.command('home') },
      { type: 'note', html: 'Coming soon.' },
    ];
  },

  traces: [
    { name: 'iqStar', label: 'Torque current demand', unit: 'A', color: 'axis-q', dashed: true },
    { name: 'iq', label: 'Torque current (Iq)', unit: 'A', color: 'axis-q' },
    { name: 'iLimit', label: 'Current limit', unit: 'A', color: 'target', dashed: true },
    { name: 'status', group: 'digital', label: 'Status output', short: 'STATUS', color: 'err' },
  ],

  readouts(snap) {
    const m = snap.motors[0];
    return [
      { label: 'Position', value: snap.gantry.x, unit: 'mm', digits: 1 },
      { label: 'Status', value: m.status ? 'high' : 'low', led: m.status ? 'trip' : 'off' },
    ];
  },

  text: () => '<p>Coming soon. This chapter will show how an FOC driver detects the end stop from its current limit.</p>',
  tryThis: ['Press Home and watch the status output.'],
};
