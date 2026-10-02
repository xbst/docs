/**
 * Placeholder view (chunk 01): a rotating vector at `snap.motors[0].thetaE`
 * with the view and chapter names, so the stage layout, resizing, theming and
 * the frame loop can be checked before the real views (chunk 03) land.
 * Implements the SPEC 4.5 view contract.
 */

const LABEL_MS = 1000;

export class PlaceholderView {
  /** Preferred height / width, used for the stage height (desktop) and host height (mobile). */
  static aspect = 0.75;

  /**
   * @param {HTMLElement} host
   * @param {{name?: string, slot?: string, chapterId?: string}} [opts]
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = Object.assign({}, opts);
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    host.append(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.lastLabel = -Infinity;
    this.font = '';
    this.fontSmall = '';
    this.fontScale = 0;
    this.chapterId = undefined;
    this.title = '';
    this.sub = '';
  }

  resize(cssW, cssH, dpr) {
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
  }

  setOptions(opts) {
    Object.assign(this.opts, opts);
    this.chapterId = undefined;
  }

  render(snap, ctx) {
    const { g, w, h } = this;
    if (w < 2 || h < 2) return;
    const th = ctx.theme;
    if (this.fontScale !== th.fontScale) {
      this.fontScale = th.fontScale;
      this.font = `500 ${Math.round(13 * th.fontScale)}px ${th.fontUi}`;
      this.fontSmall = `${Math.round(12 * th.fontScale)}px ${th.fontMono}`;
    }
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const m = snap && snap.motors && snap.motors[0];
    const thetaE = m && Number.isFinite(m.thetaE) ? m.thetaE : 0;
    const cx = w / 2, cy = h / 2 + 8;
    const r = Math.max(10, Math.min(w, h) * 0.3);

    g.lineWidth = 1.5;
    g.strokeStyle = th.tipBorder;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.moveTo(cx - r - 8, cy); g.lineTo(cx + r + 8, cy);
    g.moveTo(cx, cy - r - 8); g.lineTo(cx, cy + r + 8);
    g.stroke();

    // Screen y points down, so a positive angle is drawn counterclockwise.
    const x = cx + r * Math.cos(thetaE), y = cy - r * Math.sin(thetaE);
    g.strokeStyle = th.field;
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke();
    g.fillStyle = th.field;
    g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();

    if (this.chapterId !== ctx.chapterId) {
      this.chapterId = ctx.chapterId;
      this.title = `${this.opts.name || 'placeholder'} view`;
      this.sub = `${ctx.chapterId || ''} · placeholder`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = th.text;
    g.font = this.font;
    g.fillText(this.title, cx, 10, w - 16);
    g.fillStyle = th.muted;
    g.font = this.fontSmall;
    g.fillText(this.sub, cx, 28 * th.fontScale, w - 16);

    const now = performance.now();
    if (now - this.lastLabel >= LABEL_MS) {
      this.lastLabel = now;
      const deg = ((thetaE * 180 / Math.PI) % 360 + 360) % 360;
      this.host.setAttribute('aria-label',
        `Placeholder for the ${this.opts.name || ''} view. Electrical angle ${Math.round(deg)} degrees.`);
    }
  }

  destroy() {
    this.canvas.remove();
  }
}
