/**
 * Chapter 2 stub: Microstepping (SPEC 6.2). Chunk 04 replaces this file.
 */
export default {
  id: 'microstepping', number: 2, title: 'Microstepping', short: 'Microstepping',
  takeaway: 'Microsteps make motion smoother and quieter by sharing the field between two coils, but they don’t buy accuracy under load.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.05, min: 0.005, max: 1 },
  traceWindow: 0.1,
  stage: { primary: 'motor', secondary: 'gantry', split: 0.55 },

  scenario(motorType) {
    return { motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: 'current', mechanics: 'axis', microsteps: 16 };
  },

  onEnter(ctx) { ctx.world.command('jog', { speedMmS: 20 }); },

  controls() {
    return [
      { type: 'slider', id: 'speed', label: 'Speed', min: 1, max: 100, step: 1, value: 20, unit: 'mm/s',
        onChange: (v, c) => c.world.command('jog', { speedMmS: v }) },
      { type: 'button', id: 'single', label: 'Single step', onClick: (c) => c.world.command('singleStep') },
      { type: 'note', html: 'Coming soon.' },
    ];
  },

  traces: [
    { name: 'step', group: 'digital', label: 'STEP', color: 'phase-a' },
    { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'phase-a', dashed: true },
    { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
    { name: 'iB', label: 'Phase B current', unit: 'A', color: 'phase-b' },
  ],

  readouts(snap) {
    const m = snap.motors[0];
    return [
      { label: 'Electrical angle', value: ((m.thetaE * 180 / Math.PI) % 360 + 360) % 360, unit: '°', digits: 0 },
      { label: 'Step rate', value: snap.step.rate, unit: 'steps/s', digits: 0 },
    ];
  },

  text: () => '<p>Coming soon. This chapter will show how microstepping shares the field between the two coils.</p>',
  tryThis: ['Press Single step and watch the vector jump.'],
};
