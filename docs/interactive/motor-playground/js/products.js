/**
 * Product profiles (SPEC 4.8). The widget's own text is product-agnostic;
 * a profile only adds config-key captions under controls (`keys`) and short
 * product notes (`notes`). Chapters render a caption only when
 * `ctx.product.keys.X` exists. Adding a product means adding an entry here.
 */
export const PRODUCTS = {
  generic: { name: null, keys: {}, notes: {} },
  ouroboros: {
    name: 'Ouroboros', driver: 'TMC4671',
    keys: { positionP: 'foc_pid_position_p', positionI: 'foc_pid_position_i',
            velocityP: 'foc_pid_velocity_p', velocityI: 'foc_pid_velocity_i',
            torqueP: 'foc_pid_torque_p', torqueI: 'foc_pid_torque_i',
            fluxP: 'foc_pid_flux_p', fluxI: 'foc_pid_flux_i',
            torqueFilter: 'biquad_torque_frequency', fluxFilter: 'biquad_flux_frequency',
            velocityFilter: 'biquad_velocity_frequency', runCurrent: 'run_current',
            homingCurrent: 'homing_current', diagPin: 'diag_pin', retract: 'homing_retract_dist',
            flag: 'PID_IQ_TARGET_LIMIT', statusPin: 'STATUS' },
    notes: { pi: 'On Ouroboros, start from the plugin autotune values and move in the direction the symptoms point.',
             homing: 'On Ouroboros the status output is already wired to the MCU.' }
  }
};

/**
 * Look up a profile by its URL key. Unknown or missing keys give the generic
 * profile (no captions). The returned object carries its own `key`.
 * @param {string|null} key value of the `product` URL parameter
 * @returns {{key: string, name: string|null, keys: Object<string,string>, notes: Object<string,string>}}
 */
export function getProduct(key) {
  const k = key && Object.prototype.hasOwnProperty.call(PRODUCTS, key) ? key : 'generic';
  return Object.assign({ key: k }, PRODUCTS[k]);
}
