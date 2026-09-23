/**
 * Chapter 1 stub: STEP and DIR (SPEC 6.1). Chunk 04 replaces this file.
 * The stub also samples every control type so controls.js can be checked.
 */
let speed = 100;

export default {
  id: 'step-dir', number: 1, title: 'STEP and DIR', short: 'STEP/DIR',
  takeaway: 'Klipper talks to every stepper driver with two wires, STEP and DIR. The driver never talks back.',
  motorTypes: ['stepper'],
  timeScale: { default: 1, min: 0.01, max: 1 },
  traceWindow: 2.0,
  stage: { primary: 'gantry', secondary: null },
  hint: 'Coming soon: this chapter is a placeholder for testing the playground.',

  scenario(motorType) {
    return { motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: 'current', mechanics: 'axis', microsteps: 16 };
  },

  onEnter(ctx) {
    speed = 100;
    ctx.world.command('jog', { speedMmS: speed });
  },

  controls(ctx) {
    return [
      { type: 'slider', id: 'speed', label: 'Speed', min: 10, max: 300, step: 5, value: speed, unit: 'mm/s', group: 'Motion',
        onChange: (v, c) => { speed = v; c.world.command('jog', { speedMmS: v }); } },
      { type: 'button', id: 'bump', label: 'Bump', kind: 'primary', group: 'Motion', onClick: (c) => c.world.command('bump') },
      { type: 'button', id: 'stop', label: 'Stop', group: 'Motion', onClick: (c) => c.world.command('stop') },
      { type: 'segmented', id: 'microsteps', label: 'Microsteps', value: 16, caption: 'microsteps', group: 'Driver',
        options: [1, 2, 4, 8, 16, 32, 64, 128, 256].map((n) => ({ value: n, label: String(n) })),
        onChange: (v, c) => c.world.set('microsteps', v) },
      { type: 'toggle', id: 'interpolate', label: 'Interpolate to 256 microsteps', value: true, caption: 'interpolate', group: 'Driver',
        onChange: (v, c) => c.world.set('interpolate', v) },
      { type: 'slider', id: 'gain', label: 'Log slider (test)', min: 0.1, max: 10, step: 0.01, log: true, value: 1,
        format: (v) => '×' + v.toFixed(2), group: 'Driver', onChange: () => {} },
      { type: 'select', id: 'window', label: 'Scope window', value: 2, group: 'Scope',
        options: [{ value: 2, label: '2 s' }, { value: 0.2, label: '200 ms' }, { value: 0.005, label: '5 ms (pulse zoom)' }],
        onChange: (v, c) => c.app.setTraceWindow(v) },
      { type: 'note', html: 'Stub chapter: <code>rotation_distance: 40</code>, 16 microsteps, 80 steps per mm.', group: 'Scope' },
    ];
  },

  traces: [
    { name: 'step', group: 'digital', label: 'STEP', color: 'phase-a' },
    { name: 'dir', group: 'digital', label: 'DIR', color: 'phase-b' },
    { name: 'posCmd', label: 'Commanded position', unit: 'mm', color: 'target', dashed: true },
    { name: 'posAct', label: 'Actual position', unit: 'mm', color: 'phase-a' },
    { name: 'velCmd', label: 'Commanded speed', unit: 'mm/s', color: 'phase-c' },
  ],

  readouts(snap) {
    return [
      { label: 'Position', value: snap.gantry.x, unit: 'mm', digits: 1 },
      { label: 'Step rate', value: snap.step.rate / 1000, unit: 'kHz', digits: 2 },
    ];
  },

  text() {
    return '<p>Coming soon. This chapter will show how Klipper moves a motor with STEP and DIR pulses.</p>'
      + '<p>For now it shows a placeholder view and synthetic signals so the playground can be tested end to end.</p>';
  },
  tryThis: ['Switch chapters with the tabs, the arrows or the chapter menu.', 'Change the time scale in the toolbar and watch the scope slow down.'],
  deeper: () => '<p>Steps per mm = 200 &times; microsteps / rotation distance.</p>',
};
