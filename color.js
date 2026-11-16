/*
 * Dark-Knight colour math, shared by the content script and the background worker.
 *
 * Every colour on a page is classified by how it is used:
 *   bg     – backgrounds: light becomes dark, already-dark stays dark
 *   fg     – text, icons: dark becomes light, already-light stays light
 *   border – borders, outlines: mapped into a mid-dark band
 * Hue and saturation are kept, so brand colours stay recognisable.
 */
(function (root) {
  'use strict';

  const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function hslToRgb(h, s, l) {
    if (!s) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hk = h / 360;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(hk + 1 / 3), f(hk), f(hk - 1 / 3)].map((v) => Math.round(v * 255));
  }

  // Lightness curves. All are continuous at l = 0.5.
  const MAP = {
    bg: (l) => (l > 0.5 ? 0.09 + (1 - l) * 0.42 : Math.min(l, 0.3)),
    fg: (l) => (l < 0.5 ? 0.92 - l * 0.4 : Math.max(l, 0.72)),
    border: (l) => (l > 0.5 ? 0.18 + (1 - l) * 0.3 : 0.33 + (0.5 - l) * 0.24),
  };

  function transform(kind, r, g, b, opts) {
    const [h, s, l] = rgbToHsl(r, g, b);
    const contrast = ((opts && opts.contrast) || 100) / 100;
    const brightness = ((opts && opts.brightness) || 100) / 100;
    let nl = MAP[kind](l);
    nl = clamp(((nl - 0.5) * contrast + 0.5) * brightness);
    const ns = kind === 'bg' ? s * 0.9 : s;
    return hslToRgb(h, ns, nl);
  }

  root.DKColor = { rgbToHsl, hslToRgb, transform, clamp };
})(globalThis);
