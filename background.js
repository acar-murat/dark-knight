/*
 * Dark-Knight background worker.
 *  - Fetches cross-origin stylesheets (pages can't read them, extensions can).
 *  - Analyses CSS background images: dark icons/sprites on transparency get
 *    lightened, flat light textures get darkened, photos are left alone.
 *  - Handles the keyboard shortcut.
 */
if (typeof importScripts === 'function' && !globalThis.DKColor) importScripts('color.js');

const cssCache = new Map();
const imgCache = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'css') {
    getCss(msg.url, 0).then(
      (text) => sendResponse({ text }),
      (e) => sendResponse({ error: String(e) })
    );
    return true;
  }
  if (msg && msg.type === 'image') {
    analyse(msg.url, msg.opts).then(
      (dataUrl) => sendResponse({ dataUrl }),
      () => sendResponse({ dataUrl: null })
    );
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-site') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host;
  try { host = new URL(tab.url).hostname; } catch { return; }
  if (!host) return;
  const { siteModes } = await chrome.storage.sync.get({ siteModes: {} });
  if (siteModes[host] === 'off') delete siteModes[host];
  else siteModes[host] = 'off';
  await chrome.storage.sync.set({ siteModes });
});

/* ---------------- stylesheets ---------------- */

const URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;

function absolutizeUrls(text, base) {
  return text.replace(URL_RE, (m, _q, u) => {
    if (/^(data:|#|about:|blob:)/i.test(u)) return m;
    try { return `url("${new URL(u, base).href}")`; } catch { return m; }
  });
}

async function inlineImports(text, base, depth) {
  const found = [...text.matchAll(IMPORT_RE)];
  if (!found.length) return text;
  const bodies = await Promise.all(found.map(async (m) => {
    let url;
    try { url = new URL(m[2], base).href; } catch { return ''; }
    try {
      const css = await getCss(url, depth + 1);
      const media = m[3].trim();
      // Keep it simple: wrap plain media queries, inline layer()/supports() as-is.
      return media && !/layer|supports/i.test(media) ? `@media ${media}{${css}}` : css;
    } catch { return ''; }
  }));
  let i = 0;
  return text.replace(IMPORT_RE, () => bodies[i++]);
}

function getCss(url, depth) {
  if (!/^https?:/i.test(url)) return Promise.reject(new Error('unsupported scheme'));
  if (cssCache.has(url)) return cssCache.get(url);
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let text = absolutizeUrls(await res.text(), url);
    if (depth < 4) text = await inlineImports(text, url, depth);
    return text;
  })();
  cssCache.set(url, p);
  p.catch(() => cssCache.delete(url));
  if (cssCache.size > 300) cssCache.delete(cssCache.keys().next().value);
  return p;
}

/* ---------------- images ---------------- */

function analyse(url, opts) {
  if (!/^https?:/i.test(url)) return Promise.resolve(null);
  const key = url + '|' + JSON.stringify(opts || {});
  if (!imgCache.has(key)) {
    imgCache.set(key, analyseImpl(url, opts).catch(() => null));
    if (imgCache.size > 1500) imgCache.delete(imgCache.keys().next().value);
  }
  return imgCache.get(key);
}

async function analyseImpl(url, opts) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.size > 1.5e6 || /svg/i.test(blob.type)) return null;
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;
  if (!w || !h || w * h > 2e6) { bmp.close(); return null; }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  let transparent = 0, opaque = 0, lSum = 0, sSum = 0;
  const step = Math.max(1, Math.floor((w * h) / 40000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    if (d[i + 3] < 40) { transparent++; continue; }
    opaque++;
    const hsl = DKColor.rgbToHsl(d[i], d[i + 1], d[i + 2]);
    sSum += hsl[1];
    lSum += hsl[2];
  }
  if (!opaque) return null;
  const tRatio = transparent / (transparent + opaque);
  const avgL = lSum / opaque, avgS = sSum / opaque;

  let kind = null;
  if (tRatio > 0.05 && avgL < 0.45) kind = 'fg';                      // dark icon / sprite
  else if (tRatio < 0.05 && avgL > 0.75 && avgS < 0.25) kind = 'bg';  // flat light background
  if (!kind) return null;                                             // photo, logo, etc.

  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const c = DKColor.transform(kind, d[i], d[i + 1], d[i + 2], opts);
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
  }
  ctx.putImageData(img, 0, 0);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return 'data:image/png;base64,' + toBase64(await out.arrayBuffer());
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
