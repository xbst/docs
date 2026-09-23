/**
 * Ordered chapter list (SPEC 4.3). Each chapter chunk replaces its own file;
 * this registry does not change.
 */
import stepDir from './01-step-dir.js';
import microstepping from './02-microstepping.js';
import chopper from './03-chopper.js';
import driverModes from './04-driver-modes.js';
import voltage from './05-voltage.js';
import closedLoop from './06-closed-loop.js';
import foc from './07-foc.js';
import piLoops from './08-pi-loops.js';
import sensorlessFoc from './09-sensorless-foc.js';

export const CHAPTERS = [stepDir, microstepping, chopper, driverModes, voltage, closedLoop, foc, piLoops, sensorlessFoc];

export default CHAPTERS;
