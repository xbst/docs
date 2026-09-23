/**
 * View registry (SPEC 4.5): stage names used in a chapter's `stage` spec →
 * view classes. Chunk 01 maps every name to the placeholder; chunk 03 replaces
 * the mappings with the real views.
 *
 * A view class may declare `static aspect` (preferred height / width). main.js
 * uses it for the desktop stage height and the stacked mobile host heights;
 * a chapter's `stage.aspect` overrides it for the whole stage.
 */
import { PlaceholderView } from './placeholder-view.js';

export const VIEWS = {
  motor: PlaceholderView,
  gantry: PlaceholderView,
  vector: PlaceholderView,
  blocks: PlaceholderView,
  schematic: PlaceholderView,
  chart: PlaceholderView,
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
