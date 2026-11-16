const DEFAULTS = {
  enabled: true,
  mode: 'dynamic',
  brightness: 100,
  contrast: 100,
  imageBrightness: 100,
  siteModes: {},
};
const SLIDERS = ['brightness', 'contrast', 'imageBrightness'];
const $ = (id) => document.getElementById(id);

function setSeg(id, value) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === value);
}

async function currentHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch {
    return '';
  }
}

(async () => {
  const host = await currentHost();
  const s = await chrome.storage.sync.get(DEFAULTS);

  const render = () => {
    $('enabled').checked = s.enabled;
    document.body.classList.toggle('disabled', !s.enabled);
    setSeg('mode', s.mode);
    setSeg('site', s.siteModes[host] || 'default');
    for (const id of SLIDERS) {
      $(id).value = s[id];
      $(id + 'Out').textContent = s[id] + '%';
    }
  };

  $('host').textContent = host;
  if (!host) $('siteRow').hidden = true;
  render();

  $('enabled').addEventListener('change', () => {
    s.enabled = $('enabled').checked;
    chrome.storage.sync.set({ enabled: s.enabled });
    render();
  });

  $('mode').addEventListener('click', (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v) return;
    s.mode = v;
    chrome.storage.sync.set({ mode: v });
    render();
  });

  $('site').addEventListener('click', (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v || !host) return;
    if (v === 'default') delete s.siteModes[host];
    else s.siteModes[host] = v;
    chrome.storage.sync.set({ siteModes: s.siteModes });
    render();
  });

  for (const id of SLIDERS) {
    // Update the label live; save only on release (storage.sync has write quotas).
    $(id).addEventListener('input', () => { $(id + 'Out').textContent = $(id).value + '%'; });
    $(id).addEventListener('change', () => {
      s[id] = +$(id).value;
      chrome.storage.sync.set({ [id]: s[id] });
    });
  }

  $('reset').addEventListener('click', () => {
    for (const id of SLIDERS) s[id] = DEFAULTS[id];
    chrome.storage.sync.set({ brightness: 100, contrast: 100, imageBrightness: 100 });
    render();
  });

  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'toggle-site');
    if (c && c.shortcut) $('shortcut').textContent = `${c.shortcut} toggles this site`;
  } catch { /* commands API unavailable */ }
})();
