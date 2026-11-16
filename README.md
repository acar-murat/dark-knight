<p align="center"><img src="icons/icon128.png" width="96" alt="Dark-Knight logo"></p>

<h1 align="center">Dark-Knight</h1>

<p align="center">Open-source dark mode for every website, in every major browser.<br>
No tracking, no accounts, no build step.</p>

---

## Why another dark mode?

Most simple dark-mode extensions invert the whole page with a CSS filter. That is fast, but it
turns photos into negatives, breaks sticky headers and makes brand colours unrecognisable.
Classified-ad and shopping sites such as **sahibinden.com**, which are full of listing photos,
sprite icons and coloured buttons, suffer the most.

Dark-Knight rewrites the site's **own colours** instead:

- **Photos and videos stay untouched.** Nothing is inverted.
- **Brand colours keep their hue.** A yellow header stays yellow, just darker.
- **Sprite icons get lightened.** Dark icons drawn on transparency are recoloured, so they stay visible on a dark background.
- **Sticky and fixed headers keep working.** No `filter` is applied to the page.
- **Single-page apps work.** New styles and DOM changes are picked up as they appear.

## Features

| | |
|---|---|
| Smart mode | Converts colours rule by rule (backgrounds, text, borders, shadows, gradients, SVG icons) |
| Invert mode | Classic filter fallback for the rare site Smart mode can't handle |
| Per-site setting | Default / Smart / Invert / Off for each site |
| Sliders | Brightness, contrast, image brightness |
| Shortcut | `Alt+Shift+D` toggles the current site |
| Sync | Settings follow you via the browser's own sync storage |

## Install (developer mode)

| Browser | Steps |
|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi | Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder |
| Firefox 121+ | Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, pick `manifest.json` |
| Safari (macOS) | `xcrun safari-web-extension-converter /path/to/dark-knight`, then build in Xcode |

> Firefox: if pages stay light, open the add-on's **Permissions** tab and allow access to all websites.

## How it works

```
page stylesheets ──► read rules (cross-origin CSS fetched by the background worker)
                     │
                     ▼
        for every colour declaration:
          background ─► dark     text ─► light     border ─► mid-dark
          CSS variables ─► split into bg / text / border versions
          background-image ─► icons lightened, flat light textures darkened
                     │
                     ▼
  mirror stylesheet with identical selectors, @media wrappers and !important flags,
  appended last in the document, so it wins exactly where the original rule would have won
```

Inline `style=""` attributes, legacy `bgcolor` / `<font color>` and SVG `fill` / `stroke` attributes are rewritten in
place and restored when you switch off.

| File | Role |
|---|---|
| `manifest.json` | One manifest for Chromium and Firefox (MV3) |
| `color.js` | Colour maths shared by page and background (HSL lightness curves) |
| `content.js` | Theme engine: stylesheet mirroring, inline styles, observers |
| `background.js` | Cross-origin CSS fetch, background-image analysis, keyboard shortcut |
| `popup.*` | Toolbar popup |

## Known limitations

- Styles inside Shadow DOM (web components) are not converted yet.
- `<img>` icons (as opposed to CSS background images) are left as they are.
- Colours written in `oklch()` / `lab()` are left unchanged.

## Contributing

Issues and pull requests are welcome, especially reports of sites that look wrong. Please include the URL and a screenshot.
To debug, inspect `<style id="dark-knight">` at the end of `<html>`. Its `data-ms` attribute shows how long the last
pass took.

## Privacy

Dark-Knight does not collect, store or send any data. The only network requests it makes are re-downloads of
stylesheets and images that the page itself already loads, so it can read them.

## License

[MIT](LICENSE)
