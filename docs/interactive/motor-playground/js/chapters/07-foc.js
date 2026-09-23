/**
 * Chapter 7 stub: Field-oriented control (SPEC 6.7). Chunk 06 replaces this
 * file. Uses both motor types and the stage strip ('blocks', compact).
 */
export default {
  id: 'foc', number: 7, title: 'Field-oriented control', short: 'FOC',
  takeaway: 'FOC measures where the rotor is and puts the current exactly where it makes torque.',
  motorTypes: ['stepper', 'bldc'],
  timeScale: { default: 0.05, min: 0.005, max: 1 },
  traceWindow: 0.2,
  stage: { primary: 'motor', secondary: 'vector', split: 0.55, strip: 'blocks' },
  viewOptions: { blocks: { compact: true } },

  scenario(motorType) {
    return { motorType, motorPreset: motorType === 'bldc' ? 'bldc' : 'stepper', driver: 'foc', driverMode: 'velocity',
      mechanics: 'free' };
  },

  onEnter(ctx) { ctx.world.command('jog', { speedMmS: 60 }); },

  controls() {
    return [
      { type: 'slider', id: 'load', label: 'Load torque', min: 0, max: 0.3, step: 0.01, value: 0, unit: 'N·m',
        onChange: (v, c) => c.world.set('loads.torque', v) },
      { type: 'toggle', id: 'transforms', label: 'Show transforms', value: false,
        onChange: (v, c) => c.app.setViewOptions('motor', { showTransforms: v }) },
      { type: 'note', html: 'Coming soon.' },
    ];
  },

  traces: [
    { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
    { name: 'iB', label: 'Phase B current', unit: 'A', color: 'phase-b' },
    { name: 'iC', label: 'Phase C current', unit: 'A', color: 'phase-c' },
    { name: 'iqStar', label: 'Torque current target', unit: 'A', color: 'axis-q', dashed: true },
    { name: 'iq', label: 'Torque current (Iq)', unit: 'A', color: 'axis-q' },
    { name: 'id', label: 'Flux current (Id)', unit: 'A', color: 'axis-d' },
  ],

  readouts(snap) {
    const m = snap.motors[0];
    return [
      { label: 'Iq', value: m.iq, unit: 'A', digits: 2 },
      { label: 'Id', value: m.id, unit: 'A', digits: 2 },
    ];
  },

  text: (ctx) => `<p>Coming soon. This chapter will show field-oriented control on a ${ctx.motorType === 'bldc' ? 'BLDC' : 'stepper'} motor.</p>`,
  tryThis: ['Switch the motor type in the toolbar.', 'Raise the load and watch Iq.'],
};
