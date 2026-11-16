/*
 * Dark-Knight content script – dynamic theme engine.
 *
 * How it works:
 *  1. Reads every stylesheet on the page (cross-origin ones via the background worker).
 *  2. For each rule that sets a colour, writes a mirror rule with the same selector,
 *     the same media/supports/layer wrapper and the same !important flag, but with
 *     the colour converted for a dark theme. The mirror sheet is placed last in the
 *     document, so it wins exactly where the original rule would have won.
 *  3. Inline style="" colours and legacy bgcolor/<font color> attributes are rewritten
 *     in place (and restored when turned off).
 *  4. A MutationObserver plus a light poll keep up with SPAs and lazy-loaded CSS.
 *
 * "filter" mode is a simple invert fallback for the rare site the engine can't handle.
 */
(() => {
  'use strict';
  if (window.__darkKnightLoaded) return;
  window.__darkKnightLoaded = true;
  if (document.contentType && !/html/i.test(document.contentType)) return;

  const C = globalThis.DKColor;
  const DEFAULTS = {
    enabled: true,
    mode: 'dynamic',
    brightness: 100,
    contrast: 100,
    imageBrightness: 100,
    siteModes: {},
  };
  const HOST = location.hostname;

  let settings = { ...DEFAULTS };
  let running = null;      // 'dynamic' | 'filter' | null
  let runningKey = '';
  let styleEl = null;      // our generated stylesheet
  let fallbackEl = null;   // early anti-flash stylesheet
  let observer = null;
  let pollTimer = 0;
  let genTimer = 0;
  let lastCss = '';
  let lastSig = '';

  /* ================= colour helpers ================= */

  const ctx = (() => {
    try { return new OffscreenCanvas(1, 1).getContext('2d'); }
    catch { return document.createElement('canvas').getContext('2d'); }
  })();
  const KEYWORD = /^(?:transparent|currentcolor|inherit|initial|unset|revert|revert-layer|none|auto)$/i;
  const parseCache = new Map();
  const modCache = new Map();

  function parseColor(str) {
    str = str.trim();
    if (parseCache.has(str)) return parseCache.get(str);
    let res = null;
    if (str && str.length < 80 && !KEYWORD.test(str) && !/var\(|calc\(|attr\(/i.test(str)) {
      ctx.fillStyle = '#000'; ctx.fillStyle = str; const a = ctx.fillStyle;
      ctx.fillStyle = '#fff'; ctx.fillStyle = str; const b = ctx.fillStyle;
      if (a === b) res = toRgba(a);
    }
    if (parseCache.size > 8000) parseCache.clear();
    parseCache.set(str, res);
    return res;
  }

  function toRgba(s) {
    if (s[0] === '#') {
      return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
    }
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (!m) return null; // e.g. oklch() serialisation – leave untouched
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }

  function toCss(r, g, b, a) {
    if (a >= 1) return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
  }

  function modifyColor(kind, str) {
    const key = kind + '|' + str;
    if (modCache.has(key)) return modCache.get(key);
    const c = parseColor(str);
    let res = null;
    if (c) {
      const [r, g, b] = C.transform(kind, c[0], c[1], c[2], settings);
      res = toCss(r, g, b, c[3]);
    }
    if (modCache.size > 8000) modCache.clear();
    modCache.set(key, res);
    return res;
  }

  // Colour-looking tokens, never matching inside identifiers such as var(--red-500).
  const TOKEN = /(?<![\w-])(?:#[0-9a-f]{3,8}(?![\w-])|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|[a-z]{3,}(?![\w(-]))/gi;
  function replaceColors(value, kind) {
    return value
      .split(/(url\([^)]*\))/i)
      .map((part, i) => (i % 2 ? part : part.replace(TOKEN, (t) => modifyColor(kind, t) || t)))
      .join('');
  }

  function absolute(raw, base) {
    try { return new URL(raw, base).href; } catch { return null; }
  }

  /* ================= background images ================= */

  const imageResults = new Map(); // url -> dataURL | false | 'pending'
  let imageRequests = 0;

  function requestImage(url) {
    if (imageResults.has(url) || imageRequests > 400 || !/^https?:/i.test(url)) return;
    imageRequests++;
    imageResults.set(url, 'pending');
    send({ type: 'image', url, opts: { brightness: settings.brightness, contrast: settings.contrast } }).then(
      (r) => {
        imageResults.set(url, (r && r.dataUrl) || false);
        if (r && r.dataUrl) schedule(120);
      },
      () => imageResults.set(url, false)
    );
  }

  // Returns { out, changed }. When `analyze` is true (stylesheet rules), relative URLs
  // are made absolute and images are queued for analysis.
  function modifyImage(val, base, analyze) {
    let changed = false;
    const out = val
      .split(/(url\((?:"[^"]*"|'[^']*'|[^)]*)\))/i)
      .map((part, i) => {
        if (i % 2) {
          if (!analyze) return part;
          const raw = part.slice(4, -1).trim().replace(/^(['"])(.*)\1$/, '$2');
          if (/^data:/i.test(raw)) return part;
          const abs = absolute(raw, base);
          if (!abs) return part;
          const r = imageResults.get(abs);
          if (r === undefined) requestImage(abs);
          else if (r && r !== 'pending') { changed = true; return `url("${r}")`; }
          return `url("${abs}")`;
        }
        if (/gradient\(/i.test(part)) {
          const n = replaceColors(part, 'bg');
          if (n !== part) { changed = true; return n; }
        }
        return part;
      })
      .join('');
    return { out, changed };
  }

  /* ================= CSS variables =================
   * A variable like --primary is often used both as a background and as a text
   * colour. Each colour variable therefore gets three converted twins
   * (--dkbg--primary, --dkfg--primary, --dkbd--primary) and every usage is
   * rewritten to the twin matching its role.
   */

  const varKinds = new Map(); // --name -> Set(kind) where it is used
  const varDefs = new Map();  // --name -> sample of defined values
  let colorVars = new Set();  // variables that hold colours
  const TWIN = { bg: 'dkbg', fg: 'dkfg', border: 'dkbd' };
  const VAR_REF = /var\(\s*(--[\w-]+)/g;
  const VAR_DECL = /([\w-]+)\s*:\s*([^;]*var\([^;]*)/g;

  function collectVars(style) {
    for (let i = 0; i < style.length; i++) {
      const p = style[i];
      if (!p.startsWith('--')) continue;
      let a = varDefs.get(p);
      if (!a) varDefs.set(p, (a = []));
      if (a.length < 6) a.push(style.getPropertyValue(p).trim());
    }
    const text = style.cssText;
    if (!text.includes('var(')) return;
    for (const m of text.matchAll(VAR_DECL)) {
      const prop = m[1];
      if (prop.startsWith('--')) continue;
      const kind = /background|gradient/.test(prop) ? 'bg'
        : /shadow/.test(prop) ? 'bg'
        : /border|outline|column-rule/.test(prop) ? 'border'
        : /color|fill|stroke/.test(prop) ? 'fg' : null;
      if (!kind) continue;
      for (const v of m[2].matchAll(VAR_REF)) {
        let s = varKinds.get(v[1]);
        if (!s) varKinds.set(v[1], (s = new Set()));
        s.add(kind);
      }
    }
  }

  function finalizeVars() {
    colorVars = new Set();
    for (const [n, vals] of varDefs) {
      if (vals.some((v) => parseColor(v) || /gradient\(/i.test(v))) colorVars.add(n);
    }
    // Variables that alias colour variables are colour variables too.
    for (let grew = true, guard = 0; grew && guard < 10; guard++) {
      grew = false;
      for (const [n, vals] of varDefs) {
        if (colorVars.has(n)) continue;
        if (vals.some((v) => [...v.matchAll(VAR_REF)].some((m) => colorVars.has(m[1])))) {
          colorVars.add(n);
          grew = true;
        }
      }
    }
  }

  function rewriteRefs(value, kind) {
    return value.replace(VAR_REF, (m, n) => (colorVars.has(n) ? `var(--${TWIN[kind]}${n}` : m));
  }

  // Convert any value (single colour, gradient, shadow, var() expression) for a role.
  function convert(value, kind) {
    const v = rewriteRefs(value, kind);
    if (!v.includes('var(')) {
      const c = modifyColor(kind, v);
      if (c) return c;
    }
    return replaceColors(v, kind);
  }

  function guessKind(name, value) {
    const kinds = varKinds.get(name);
    if (kinds && kinds.size === 1) return [...kinds][0];
    const c = parseColor(value);
    return c && C.rgbToHsl(c[0], c[1], c[2])[2] <= 0.5 ? 'fg' : 'bg';
  }

  // Returns [prop, value] pairs replacing a colour-variable definition.
  function varPairs(name, value) {
    if (!colorVars.has(name)) return null;
    const v = value.trim();
    const pairs = [[name, convert(v, guessKind(name, v))]];
    for (const k of ['bg', 'fg', 'border']) pairs.push([`--${TWIN[k]}${name}`, convert(v, k)]);
    return pairs;
  }

  function absolutizeUrls(text, base) {
    return text.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (m, _q, u) => {
      if (/^(data:|#)/i.test(u)) return m;
      const abs = absolute(u, base);
      return abs ? `url("${abs}")` : m;
    });
  }

  /* ================= stylesheet mirroring ================= */

  const PROPS = {
    'background-color': 'bg',
    'background-image': 'image',
    'color': 'fg',
    '-webkit-text-fill-color': 'fg',
    'caret-color': 'fg',
    'text-decoration-color': 'fg',
    'fill': 'fg',
    'stroke': 'fg',
    'border-top-color': 'border',
    'border-right-color': 'border',
    'border-bottom-color': 'border',
    'border-left-color': 'border',
    'border-block-start-color': 'border',
    'border-block-end-color': 'border',
    'border-inline-start-color': 'border',
    'border-inline-end-color': 'border',
    'outline-color': 'border',
    'column-rule-color': 'border',
    'box-shadow': 'shadow',
    'text-shadow': 'shadow',
  };

  // Shorthands whose longhands read as '' when the shorthand contains var().
  const SHORTHANDS = [
    ['background', 'bg'], ['border', 'border'], ['border-color', 'border'],
    ['border-top', 'border'], ['border-right', 'border'], ['border-bottom', 'border'], ['border-left', 'border'],
    ['border-block', 'border'], ['border-inline', 'border'],
    ['border-block-start', 'border'], ['border-block-end', 'border'],
    ['border-inline-start', 'border'], ['border-inline-end', 'border'],
    ['outline', 'border'], ['column-rule', 'border'], ['text-decoration', 'fg'],
  ];

  // Emits every colour-related declaration (converted when possible, otherwise as-is)
  // so that the cascade order between rules is preserved exactly.
  function processDecls(style, base) {
    let out = '';
    let pending = false;
    const imp = (p) => (style.getPropertyPriority(p) ? '!important' : '');
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (prop.startsWith('--')) {
        const pairs = varPairs(prop, style.getPropertyValue(prop));
        if (pairs) for (const [p, v] of pairs) out += `${p}:${v}${imp(prop)};`;
        continue;
      }
      const kind = PROPS[prop];
      if (!kind) continue;
      const val = style.getPropertyValue(prop);
      if (!val) { pending = true; continue; } // part of a shorthand using var()
      let nv;
      if (val.includes('var(')) nv = absolutizeUrls(convert(val, kind === 'image' || kind === 'shadow' ? 'bg' : kind), base);
      else if (kind === 'image') nv = modifyImage(val, base, true).out;
      else if (kind === 'shadow') nv = replaceColors(val, 'bg');
      else nv = modifyColor(kind, val) || val;
      out += `${prop}:${nv}${imp(prop)};`;
    }
    if (pending) {
      for (const [sh, kind] of SHORTHANDS) {
        const v = style.getPropertyValue(sh);
        if (v && v.includes('var(')) out += `${sh}:${absolutizeUrls(convert(v, kind), base)}${imp(sh)};`;
      }
    }
    return out;
  }

  function wrapMedia(css, media) {
    return media && media !== 'all' ? `@media ${media}{${css}}` : css;
  }

  function prelude(rule) {
    const t = rule.cssText;
    const i = t.indexOf('{');
    return i > 0 ? t.slice(0, i).trim() : null;
  }

  function walk(rules, base, emit) {
    let out = '';
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      try {
        if (rule.selectorText !== undefined && rule.style) {
          // Style rule (possibly with nested rules)
          if (!emit) {
            collectVars(rule.style);
            if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, base, false);
            continue;
          }
          const decls = processDecls(rule.style, base);
          const nested = rule.cssRules && rule.cssRules.length ? walk(rule.cssRules, base, true) : '';
          if (decls || nested) out += `${rule.selectorText}{${decls}${nested}}`;
        } else if (rule.href !== undefined && 'styleSheet' in rule) {
          // @import
          const url = absolute(rule.href, base);
          let rs = null;
          try { rs = rule.styleSheet && rule.styleSheet.cssRules; } catch { /* cross-origin */ }
          if (!rs && url) rs = getRemote(url);
          if (rs) {
            const inner = walk(rs, url || base, emit);
            if (emit && inner) out += wrapMedia(inner, rule.media && rule.media.mediaText);
          }
        } else if (rule.style && rule.selectorText === undefined && !rule.cssRules) {
          // Nested declarations inside a style rule, or @page/@font-face (skip those)
          if (emit && rule.type === 0) out += processDecls(rule.style, base);
          else if (!emit) collectVars(rule.style);
        } else if (rule.cssRules) {
          // @media, @supports, @layer, @container, @scope …  (not @keyframes)
          if (rule.type === 7 || /^@(-[a-z]+-)?keyframes/i.test(rule.cssText.slice(0, 30))) continue;
          if (!emit) { walk(rule.cssRules, base, false); continue; }
          const inner = walk(rule.cssRules, base, true);
          if (!inner) continue;
          let head;
          if (rule.type === 4 && rule.media) head = '@media ' + rule.media.mediaText;
          else if (rule.type === 12) head = '@supports ' + rule.conditionText;
          else head = prelude(rule);
          if (head) out += `${head}{${inner}}`;
        }
      } catch { /* one bad rule must not break the page */ }
    }
    return out;
  }

  const remote = new Map(); // url -> { rules } | 'pending' | 'failed'

  function parseSheet(text) {
    try {
      const s = new CSSStyleSheet();
      s.replaceSync(text);
      return s.cssRules;
    } catch {
      const doc = document.implementation.createHTMLDocument('');
      const st = doc.createElement('style');
      st.textContent = text;
      doc.head.appendChild(st);
      return st.sheet ? st.sheet.cssRules : null;
    }
  }

  function getRemote(url) {
    const r = remote.get(url);
    if (r && r.rules) return r.rules;
    if (!r) {
      remote.set(url, 'pending');
      send({ type: 'css', url }).then(
        (res) => {
          if (!res || res.error) { remote.set(url, 'failed'); return; }
          const rules = parseSheet(res.text);
          remote.set(url, rules ? { rules } : 'failed');
          schedule(0);
        },
        () => remote.set(url, 'failed')
      );
    }
    return null;
  }

  function sources() {
    const list = [];
    const push = (sheet) => {
      if (!sheet || sheet.disabled) return;
      if (sheet.ownerNode && (sheet.ownerNode === styleEl || sheet.ownerNode === fallbackEl)) return;
      let rules = null;
      try { rules = sheet.cssRules; } catch { if (sheet.href) rules = getRemote(sheet.href); }
      if (rules) list.push({ rules, base: sheet.href || document.baseURI, media: sheet.media && sheet.media.mediaText });
    };
    for (const sheet of document.styleSheets) push(sheet);
    try { for (const sheet of document.adoptedStyleSheets || []) push(sheet); } catch { /* ignore */ }
    return list;
  }

  function signature() {
    let s = '';
    for (const sh of document.styleSheets) {
      if (sh.ownerNode === styleEl || sh.ownerNode === fallbackEl) continue;
      let n;
      try { n = sh.cssRules.length; } catch { n = 'x'; }
      s += (sh.href || 'i') + ':' + n + (sh.disabled ? 'd' : '') + ',';
    }
    try { s += '|' + (document.adoptedStyleSheets || []).length; } catch { /* ignore */ }
    return s;
  }

  function baseCss() {
    const bg = modifyColor('bg', '#ffffff');
    const fg = modifyColor('fg', '#000000');
    let css =
      `:root{color-scheme:dark!important}` +
      `:where(html){background-color:${bg};color:${fg}}` +
      `:where(input,textarea,select,button){background-color:${modifyColor('bg', '#f0f0f0')};color:${fg};border-color:${modifyColor('border', '#767676')}}` +
      `:where(input,textarea)::placeholder{color:${modifyColor('fg', '#757575')}}` +
      `:where(a:link){color:${modifyColor('fg', '#0000ee')}}` +
      `:where(a:visited){color:${modifyColor('fg', '#551a8b')}}` +
      `:where(mark){background-color:${modifyColor('bg', '#ffff00')};color:${fg}}`;
    if (settings.imageBrightness < 100) {
      css += `:where(img,video,picture,canvas){filter:brightness(${settings.imageBrightness}%)}`;
    }
    return css;
  }

  function generate() {
    if (running !== 'dynamic' || !styleEl) return;
    const t0 = performance.now();
    lastSig = signature();
    const srcs = sources();
    varKinds.clear();
    varDefs.clear();
    for (const s of srcs) walk(s.rules, s.base, false);
    finalizeVars();
    let css = baseCss();
    for (const s of srcs) {
      const inner = walk(s.rules, s.base, true);
      if (inner) css += wrapMedia(inner, s.media);
    }
    if (css !== lastCss) {
      styleEl.textContent = css;
      lastCss = css;
    }
    styleEl.dataset.ms = Math.round(performance.now() - t0); // handy when debugging slow sites
    ensureLast();
  }

  function schedule(delay) {
    if (genTimer) return;
    genTimer = setTimeout(() => { genTimer = 0; generate(); }, delay || 0);
  }

  function ensureLast() {
    const root = document.documentElement;
    if (!root || !styleEl) return;
    if (styleEl.parentNode !== root || styleEl.nextElementSibling) root.appendChild(styleEl);
  }

  /* ================= inline styles & legacy attributes ================= */

  const inlineState = new WeakMap(); // el -> { prop: [orig | null, priority, written] }
  const attrState = new WeakMap();   // el -> { attr: [orig, written] }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const INLINE_SEL = '[style],[bgcolor],font[color],svg [fill],svg [stroke]';

  function processInline(el) {
    const st = el.style;
    if (!st || !st.length) return;
    let state = inlineState.get(el);
    const write = (prop, nv, prio, orig) => {
      if (!state) inlineState.set(el, (state = {}));
      st.setProperty(prop, nv, prio);
      state[prop] = [orig, prio, st.getPropertyValue(prop)];
    };
    const n = st.length;
    for (let i = 0; i < n; i++) {
      const prop = st[i];
      if (prop.startsWith('--dk')) continue; // our own variable twins
      const isVar = prop.startsWith('--');
      const kind = isVar ? 'var' : PROPS[prop];
      if (!kind) continue;
      const cur = st.getPropertyValue(prop);
      if (!cur) continue;
      if (state && state[prop] && state[prop][2] === cur) continue; // our own value
      const prio = st.getPropertyPriority(prop);
      if (isVar) {
        const pairs = varPairs(prop, cur);
        if (!pairs) continue;
        for (const [p, v] of pairs) write(p, v, prio, p === prop ? cur : null);
        continue;
      }
      let nv;
      if (cur.includes('var(')) nv = convert(cur, kind === 'image' || kind === 'shadow' ? 'bg' : kind);
      else if (kind === 'image') { const r = modifyImage(cur, document.baseURI, false); nv = r.changed ? r.out : null; }
      else if (kind === 'shadow') nv = replaceColors(cur, 'bg');
      else nv = modifyColor(kind, cur);
      if (!nv || nv === cur) continue;
      write(prop, nv, prio, cur);
    }
  }

  function processAttr(el, name, kind) {
    const cur = el.getAttribute(name);
    if (!cur) return;
    let s = attrState.get(el);
    if (s && s[name] && s[name][1] === cur) return;
    const nv = modifyColor(kind, cur);
    if (!nv || nv === cur) return;
    if (!s) attrState.set(el, (s = {}));
    el.setAttribute(name, nv);
    s[name] = [cur, nv];
  }

  function processEl(el) {
    if (el === styleEl || el === fallbackEl) return;
    processInline(el);
    if (el.hasAttribute('bgcolor')) processAttr(el, 'bgcolor', 'bg');
    if (el.tagName === 'FONT' && el.hasAttribute('color')) processAttr(el, 'color', 'fg');
    if (el.namespaceURI === SVG_NS) {
      // Icon paths like fill="#000" would vanish on a dark page.
      if (el.hasAttribute('fill')) processAttr(el, 'fill', 'fg');
      if (el.hasAttribute('stroke')) processAttr(el, 'stroke', 'fg');
    }
  }

  function scanTree(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches(INLINE_SEL)) processEl(root);
    if (root.firstElementChild) for (const el of root.querySelectorAll(INLINE_SEL)) processEl(el);
  }

  function revertInline() {
    if (!document.documentElement) return;
    for (const el of document.querySelectorAll(INLINE_SEL)) {
      const s = inlineState.get(el);
      if (s) {
        for (const p in s) {
          if (el.style.getPropertyValue(p) !== s[p][2]) continue; // page changed it since
          if (s[p][0] === null) el.style.removeProperty(p);
          else el.style.setProperty(p, s[p][0], s[p][1]);
        }
        inlineState.delete(el);
      }
      const a = attrState.get(el);
      if (a) {
        for (const n in a) if (el.getAttribute(n) === a[n][1]) el.setAttribute(n, a[n][0]);
        attrState.delete(el);
      }
    }
  }

  /* ================= lifecycle ================= */

  function makeStyle(id) {
    const el = document.createElement('style');
    el.id = id;
    el.setAttribute('data-dark-knight', '');
    document.documentElement.appendChild(el);
    return el;
  }

  function onSheetLoad(e) {
    const t = e.target;
    if (t && (t.nodeName === 'LINK' || t.nodeName === 'STYLE') && signature() !== lastSig) generate();
  }

  function poll() {
    if (signature() !== lastSig) generate();
  }

  function removeFallback() {
    if (fallbackEl) { fallbackEl.remove(); fallbackEl = null; }
  }

  function startDynamic() {
    styleEl = makeStyle('dark-knight');
    if (document.readyState === 'loading') {
      // Until the page's own CSS has been mirrored, keep the canvas dark to avoid a white flash.
      fallbackEl = makeStyle('dark-knight-fallback');
      fallbackEl.textContent = `html,body{background-color:${modifyColor('bg', '#ffffff')}!important}`;
      window.addEventListener('load', removeFallback, { once: true });
      document.addEventListener('DOMContentLoaded', () => { generate(); scanTree(document.documentElement); }, { once: true });
    }
    generate();
    scanTree(document.documentElement);

    observer = new MutationObserver((records) => {
      let sheetsChanged = false;
      for (const r of records) {
        if (r.type === 'attributes') {
          processEl(r.target);
          continue;
        }
        if (r.target.nodeName === 'STYLE' && r.target !== styleEl) sheetsChanged = true;
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || n === styleEl || n === fallbackEl) continue;
          if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') sheetsChanged = true;
          scanTree(n);
        }
        for (const n of r.removedNodes) {
          if (n !== styleEl && n !== fallbackEl && (n.nodeName === 'STYLE' || n.nodeName === 'LINK')) sheetsChanged = true;
        }
      }
      if (sheetsChanged && signature() !== lastSig) generate();
      else ensureLast();
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'bgcolor', 'color', 'fill', 'stroke'],
    });
    document.addEventListener('load', onSheetLoad, true);
    pollTimer = setInterval(poll, 1000);
  }

  function filterCss() {
    const f = `invert(1) hue-rotate(180deg) brightness(${settings.brightness}%) contrast(${settings.contrast}%)`;
    return (
      `html{filter:${f}!important;background:#fff!important}` +
      `img,picture,video,canvas,embed,object,iframe,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}`
    );
  }

  function startFilter() {
    styleEl = makeStyle('dark-knight');
    styleEl.textContent = filterCss();
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    clearInterval(pollTimer);
    clearTimeout(genTimer);
    pollTimer = genTimer = 0;
    document.removeEventListener('load', onSheetLoad, true);
    if (running === 'dynamic') revertInline();
    if (styleEl) styleEl.remove();
    removeFallback();
    styleEl = null;
    lastCss = lastSig = '';
    running = null;
  }

  function effectiveMode() {
    if (!settings.enabled) return null;
    const site = settings.siteModes && settings.siteModes[HOST];
    if (site === 'off') return null;
    return site === 'dynamic' || site === 'filter' ? site : settings.mode;
  }

  function apply() {
    const mode = effectiveMode();
    const key = JSON.stringify([mode, settings.brightness, settings.contrast, settings.imageBrightness]);
    if (key === runningKey) return;
    stop();
    modCache.clear();
    imageResults.clear();
    imageRequests = 0;
    runningKey = key;
    running = mode;
    if (mode === 'dynamic') startDynamic();
    else if (mode === 'filter') startFilter();
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(r);
        });
      } catch (e) { reject(e); }
    });
  }

  function loadSettings() {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      settings = { ...DEFAULTS, ...s };
      apply();
    });
  }

  function whenRoot(cb) {
    if (document.documentElement) return cb();
    const mo = new MutationObserver(() => {
      if (document.documentElement) { mo.disconnect(); cb(); }
    });
    mo.observe(document, { childList: true });
  }

  whenRoot(() => {
    apply();        // start immediately with defaults (no white flash) …
    loadSettings(); // … then correct with the user's stored settings
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') loadSettings();
  });
})();
