/**
 * View registry (SPEC 4.5): stage names used in a chapter's `stage` spec →
 * view classes.
 *
 * A view class may declare `static aspect` (preferred height / width). main.js
 * uses it for the desktop stage height and the stacked mobile host heights;
 * a chapter's `stage.aspect` overrides it for the whole stage.
 */
import { PlaceholderView } from './placeholder-view.js';
import { MotorView } from './motor-view.js';
import { GantryView } from './gantry-view.js';
import { VectorView } from './vector-view.js';
import { BlockDiagram } from './block-diagram.js';
import { SchematicView } from './schematic-view.js';
import { ChartView } from './chart-view.js';

export const VIEWS = {
  motor: MotorView,
  gantry: GantryView,
  vector: VectorView,
  blocks: BlockDiagram,
  schematic: SchematicView,
  chart: ChartView,
  placeholder: PlaceholderView,
};

const warned = new Set();

/**
 * @param {string} name
 * @returns {Function} view class (the placeholder for unknown names)
 */
export function getView(name) {
  const View = VIEWS[name];
  if (View) return View;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[playground] unknown view "${name}", showing the placeholder`);
  }
  return PlaceholderView;
}
