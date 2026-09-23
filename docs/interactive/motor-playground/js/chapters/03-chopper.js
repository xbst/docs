/**
 * Chapter 3 stub: Inside a stepper driver (SPEC 6.3). Chunk 04 replaces this
 * file. Runs the world at switching fidelity (0.5 µs steps).
 */
export default {
  id: 'chopper', number: 3, title: 'Inside a stepper driver', short: 'Chopper',
  takeaway: 'A driver is a current regulator. It switches the supply on and off tens of thousands of times a second and measures what happens.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.0005, min: 0.0001, max: 0.01 },
  traceWindow: 0.0005,
  stage: { primary: 'schematic', secondary: null },

  scenario(motorType) {
    return { motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: 'current', fidelity: 'switching',
      mechanics: 'axis', supplyV: 24 };
  },

  controls() {
    return [
      { type: 'segmented', id: 'bus', label: 'Bus voltage', value: 24,
        options: [{ value: 12, label: '12 V' }, { value: 24, label: '24 V' }, { value: 48, label: '48 V' }],
        onChange: (v, c) => c.world.set('supplyV', v) },
      { type: 'slider', id: 'chop', label: 'Chopper frequency', min: 20, max: 60, step: 1, value: 40, unit: 'kHz',
        onChange: (v, c) => c.world.set('chopper.freqHz', v * 1000) },
      { type: 'note', html: 'Coming soon.' },
    ];
  },

  traces: [
    { name: 'pwmA', group: 'digital', label: 'Bridge A (+, off, −)', short: 'PWM A', color: 'phase-a', range: [-1, 1] },
    { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'phase-a', dashed: true },
    { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
  ],

  readouts(snap) {
    return [
      { label: 'Bus', value: snap.supplyV, unit: 'V', digits: 0 },
      { label: 'Phase A', value: snap.motors[0].iPhase[0], unit: 'A', digits: 2 },
    ];
  },

  text: () => '<p>Coming soon. This chapter will open up the H-bridge and show the chopper at work.</p>',
  tryThis: ['Raise the bus voltage and watch the ripple.'],
};
