# Goal Tracker

A small, dependency-free goal tracker that runs entirely in the browser. Set
goals, break them into objectives, pull those objectives into a daily to-do
list, and see deadlines and progress on a calendar. Everything is stored in
`localStorage` — there is no backend, no build step, and no account.

## Running it

Hosted on GitHub Pages, which serves `main`:

**https://joshuahildebrand.github.io/goal-tracker/**

That's the easiest way to use it — bookmark it, it works on a phone, and it
updates whenever `main` changes. (To set this up on a fork: **Settings** →
**Pages** → Source *Deploy from a branch* → `main` / `root`.)

To run it locally instead, open `index.html` in a browser. `index.html` and
`assets/` must stay in the same folder — the page loads its CSS and JS by
relative path, so moving the HTML on its own gives you an unstyled, inert page.
Opening straight off disk (`file://`) works, and so does any static host:

```sh
python3 -m http.server 8000    # then open http://localhost:8000
```

### Your data is tied to the URL you use

Everything is stored in `localStorage`, which browsers scope per origin. Goals
saved on the Pages URL won't appear when you open the same app from disk, or in
a different browser, and vice versa — the data isn't lost, it's filed under the
other origin. Pick one way to open it and stay with it. There is no export yet
(see Known issues), so to move data between origins you currently have to copy
`localStorage` across by hand in the browser console.

## The four tabs

| Tab | What it does |
| --- | --- |
| **Goals** | Create goals, add objectives, tick them off, set deadlines and per-objective target dates, keep notes. Cards collapse to a one-line summary. |
| **Today's To-Do** | Pull today's work from any goal's open objectives, plus free-form quick tasks. Ticking a task here writes straight back to the goal. |
| **Calendar** | Month grid marking goal deadlines (🔴), objective target dates (🟡), and completions (dots). Click a marked day for details. Sidebar lists goals by deadline. |
| **Archive** | Completed goals you've archived, restorable or deletable. |

A goal is either **objective-based** (progress = completed objectives / total)
or **yes/no** (progress = 0% or 100%).

## Layout

```
index.html          markup only
assets/styles.css   all styling; theme lives in the :root custom properties
assets/app.js       all behaviour, in labelled sections
```

`app.js` is a single classic script, not an ES module, so the inline `onclick`
handlers in the markup can reach its functions and `file://` keeps working.
It's organised as: storage → domain → dates → utilities → tabs → goal form →
goal rendering → goal mutations → objectives → daily tasks → calendar → init.

## Data model

Two keys in `localStorage`:

**`goal:<id>`** — one goal per key:

```js
{
  id: '1786840187546',          // Date.now() at creation
  title: 'Launch the beta',
  deadline: '2026-09-30',       // or null
  isBoolean: false,             // true = simple yes/no goal
  completed: false,             // only meaningful when isBoolean
  completedDate: '2026-…',      // ISO, present only while completed
  archived: true,               // present only once archived
  notes: '',
  createdAt: '2026-…',          // ISO
  objectives: [
    { text: 'Write the docs', completed: true,
      completedDate: '2026-…',  // ISO, present only while completed
      targetDate: '2026-08-22'  // or null
    }
  ]
}
```

**`dailyTasks`** — one array holding every day's tasks:

```js
{
  id: '1786840187546-k3f9d2a1x',
  objectiveId: '<goalId>-<index>' | 'boolean-<goalId>' | null,
  goalId, objectiveIndex, goalTitle, objectiveText,
  date: '2026-08-16',           // the day it belongs to
  completed: false,
  isBoolean: false,
  isQuickTask: true             // present only on free-form tasks
}
```

Read and write goals through the helpers at the top of `app.js`
(`readGoal`, `writeGoal`, `updateGoal`, `allGoals`) rather than touching
`localStorage` directly — they handle JSON parsing, quota errors, and
normalising older records.

Dates are stored as `YYYY-MM-DD` and must be parsed with `parseLocalDate()`.
Passing that string to `new Date()` parses it as UTC and lands on the wrong day
for anyone west of Greenwich.

## Known issues

- **Objectives are addressed by array index.** A daily task points at its
  objective via `<goalId>-<index>`, so deleting or reordering an objective
  silently repoints any existing task at whatever slid into that slot. Fixing
  it properly means giving objectives stable ids and migrating existing
  records — worth doing before building anything else on top of the to-do list.
- **`dailyTasks` grows forever.** Every day's tasks stay in one array; only
  today's are ever read. It needs pruning, or a history view that uses them.
- **No export/import.** Clearing site data loses everything, and there's no
  supported way to move goals between origins (disk vs. Pages vs. another
  browser). An export/import button would fix both at once.

## Ideas

Recurring goals, streaks, a weekly review, filter/search on the goals list,
and a light theme (the palette is already centralised in `:root`).
