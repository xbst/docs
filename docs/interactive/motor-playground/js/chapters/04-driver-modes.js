/**
 * Chapter 4 stub: StealthChop, SpreadCycle and StallGuard (SPEC 6.4).
 * Chunk 05 replaces this file.
 */
export default {
  id: 'driver-modes', number: 4, title: 'StealthChop, SpreadCycle and StallGuard', short: 'Driver modes',
  takeaway: 'Quiet mode regulates current slowly, fast mode regulates it every cycle, and stall detection guesses the load from how the current behaves.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.25, min: 0.01, max: 1 },
  traceWindow: 1.0,
  stage: { primary: 'motor', secondary: 'gantry', split: 0.5 },

  scenario(motorType) {
    return { motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: 'voltage', mechanics: 'axis',
      stallguard: { sgthrs: 60, minSpeedMmS: 10 } };
  },

  onEnter(ctx) { ctx.world.command('jog', { speedMmS: 80 }); },

  controls() {
    return [
      { type: 'segmented', id: 'mode', label: 'Driver mode', value: 'voltage', caption: 'stealthchop_threshold',
        options: [{ value: 'voltage', label: 'StealthChop' }, { value: 'current', label: 'SpreadCycle' }, { value: 'hybrid', label: 'Hybrid' }],
        onChange: (v, c) => c.world.set('driverMode', v) },
      { type: 'slider', id: 'sgthrs', label: 'StallGuard threshold', min: 0, max: 255, step: 1, value: 60, caption: 'driver_SGTHRS',
        onChange: (v, c) => c.world.set('stallguard.sgthrs', v) },
      { type: 'button', id: 'home', label: 'Home toward the stop', kind: 'primary', onClick: (c) => c.world.command('home') },
      { type: 'note', html: 'Coming soon.' },
    ];
  },

  traces: [
    { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'phase-a', dashed: true },
    { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
    { name: 'sg', label: 'StallGuard value', unit: '', scale: 'sg', color: 'phase-c', range: [0, 1023] },
    { name: 'sgThreshold', label: 'Threshold (2 × SGTHRS)', scale: 'sg', color: 'target', dashed: true },
    { name: 'diag', group: 'digital', label: 'DIAG', color: 'err' },
  ],

  readouts(snap) {
    const m = snap.motors[0];
    return [
      { label: 'Current amplitude', value: m.iAmp != null ? m.iAmp : Math.hypot(m.iAlpha, m.iBeta), unit: 'A', digits: 2 },
      { label: 'DIAG', value: m.diag ? 'high' : 'low', led: m.diag ? 'trip' : 'off' },
    ];
  },

  text: () => '<p>Coming soon. This chapter will compare StealthChop and SpreadCycle and show how StallGuard detects a stall.</p>',
  tryThis: ['Switch the driver mode and watch the current.'],
};
