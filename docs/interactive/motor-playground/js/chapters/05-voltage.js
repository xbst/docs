/**
 * Chapter 5 stub: Why 48 V (SPEC 6.5). Chunk 05 replaces this file.
 */
export default {
  id: 'voltage', number: 5, title: 'Why 48 V', short: '48 V',
  takeaway: 'Current makes torque, but voltage decides how fast current can change. Higher voltage keeps torque alive at speed.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.1, min: 0.01, max: 1 },
  traceWindow: 0.2,
  stage: { primary: 'chart', secondary: 'motor', split: 0.6 },

  scenario(motorType) {
    return { motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: 'current', mechanics: 'axis', supplyV: 24 };
  },

  onEnter(ctx) { ctx.world.command('jog', { speedMmS: 150 }); },

  controls() {
    return [
      { type: 'segmented', id: 'bus', label: 'Bus voltage', value: 24,
        options: [12, 24, 36, 48, 60].map((v) => ({ value: v, label: v + ' V' })),
        onChange: (v, c) => c.world.set('supplyV', v) },
      { type: 'button', id: 'sweep', label: 'Sweep', kind: 'primary', onClick: (c) => c.world.command('sweep') },
      { type: 'note', html: 'Coming soon.' },
    ];
  },

  traces: [
    { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'phase-a', dashed: true },
    { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
    { name: 'bemfA', label: 'Back-EMF, phase A', unit: 'V', color: 'axis-q' },
    { name: 'uLimit', label: 'Voltage limit', unit: 'V', color: 'target', dashed: true },
  ],

  readouts(snap) {
    return [
      { label: 'Bus', value: snap.supplyV, unit: 'V', digits: 0 },
      { label: 'Voltage used', value: snap.motors[0].uMag, unit: 'V', digits: 1 },
    ];
  },

  text: () => '<p>Coming soon. This chapter will show why a higher bus voltage keeps torque at speed.</p>',
  tryThis: ['Sweep at 24 V, then at 48 V.'],
};
