# Working in this repo

A browser-only goal tracker: no backend, no build step, no dependencies.
`README.md` covers what it does and the full data model — read it first.

```
index.html          markup only
assets/styles.css   all styling
assets/app.js       all behaviour
```

## Conventions

- **No build step, no dependencies.** Anything added must work by opening
  `index.html` off disk. Don't introduce a bundler, framework, or CDN script
  without asking — the whole point is that it stays openable from `file://`.
- **`app.js` is a classic script, not a module.** The markup wires events with
  inline `onclick`, which needs the functions to be globals. Making it a module
  breaks every handler *and* breaks `file://` loading. Keep it as-is unless you
  convert all handlers to delegated listeners in the same change.
- **Go through the storage helpers** at the top of `app.js` — `readGoal`,
  `writeGoal`, `updateGoal`, `allGoals` — rather than calling `localStorage`
  directly. They centralise JSON handling, quota errors, and normalising older
  records.
- **Parse dates with `parseLocalDate()`.** Stored dates are `YYYY-MM-DD`;
  `new Date('2026-08-16')` parses as UTC and shows the wrong day west of
  Greenwich.
- **Style with classes in `styles.css`**, not `style="…"` in template strings.
  Colours come from the `:root` custom properties — `--accent` / `--accent-light`
  for anything the user reads. `--primary` is near-black and only works as a
  background.
- **Escape interpolated user text** with `escapeHtml()`. Never interpolate a
  title or objective into an `onclick` attribute — pass ids and look the text
  up in the handler.

## Checking your work

There are no tests. Verify changes by driving the real page:

```js
// Chromium is at /opt/pw-browsers/chromium-1194/chrome-linux/chrome
const browser = await chromium.launch({ executablePath: '…/chrome' });
await page.goto('file:///path/to/index.html');
```

Seed state by writing `goal:<id>` keys into `localStorage` and reloading. Cover
all four tabs — goals and tasks are edited from several of them and the write-
through between Goals and Today's To-Do is where breakage tends to show up.

## Before building features

The objective-index issue in README.md's "Known issues" is worth fixing first
if the work touches the to-do list — objectives are referenced by array index,
so deleting one repoints existing tasks at the wrong objective.
