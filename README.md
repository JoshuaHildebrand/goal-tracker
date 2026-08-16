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
other origin. Pick one way to open it and stay with it.

**Export backup** at the foot of the page writes everything to a JSON file, and
**Import backup** reads one back. That's the supported way to take a backup or
move between browsers and devices. Importing *replaces* what's in the browser
rather than merging, and asks first; a backup that predates a schema change is
migrated on the way in.

## The four tabs

| Tab | What it does |
| --- | --- |
| **Goals** | Create goals, add objectives, tick them off, set deadlines and per-objective target dates, keep notes. Cards collapse to a one-line summary. |
| **Today's To-Do** | Pull a day's work from any goal's open objectives, plus free-form quick tasks. Move between days with `‹ ›` to plan tomorrow tonight. Give tasks a start and end time to lay out the day; scheduled tasks sort chronologically above an "Anytime" group. A timeline beside the list plots the day with a live now marker — click it to jump the list to whatever is happening then — every task running at that moment glows, not just the first. Rename a task by double-tapping its name — renaming one that came from a goal renames the objective itself. Ticking a task here writes straight back to the goal. |
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

The look is a Nightwing treatment — electric blue on a near-black navy, swept
wings in the header, Rajdhani for display and Barlow for body text. Retheming
means editing the `:root` block and little else; red and amber are held back
for deadlines, overdue work and destructive buttons so urgency still reads
against the blue.

`app.js` is a single classic script, not an ES module, so the inline `onclick`
handlers in the markup can reach its functions and `file://` keeps working.
It's organised as: storage → domain → dates → utilities → tabs → goal form →
goal rendering → goal mutations → objectives → daily tasks → calendar → init.

## Data model

Three keys in `localStorage`:

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
    { id: 'm5k2p1q9x4',        // stable; never reused or renumbered
      text: 'Write the docs', completed: true,
      completedDate: '2026-…',  // ISO, present only while completed
      targetDate: '2026-08-22'  // or null
    }
  ]
}
```

**`dailyTasks`** — one array holding every day's tasks:

```js
{
  id: 'm5k2p1q9x4',
  objectiveId: '<goalId>:<objectiveId>' | 'boolean-<goalId>' | null,
  objectiveRef: '<objectiveId>' | null,   // which objective, by stable id
  goalId, goalTitle, objectiveText,
  date: '2026-08-16',           // the day it belongs to
  start: '13:00' | null,        // 24h 'HH:MM'; absent means "anytime"
  end: '15:00' | null,          // ignored unless later than start
  completed: false,
  isBoolean: false,
  isQuickTask: true             // present only on free-form tasks
}
```

A third key, `schemaVersion`, records which one-time migrations have run. Those
three are exactly what export writes out and import replaces; nothing else in
`localStorage` is touched.

Objectives are found with `findObjective()` by id — never by array position,
which is what used to break tasks when a neighbouring objective was deleted.

Read and write goals through the helpers at the top of `app.js`
(`readGoal`, `writeGoal`, `updateGoal`, `allGoals`) rather than touching
`localStorage` directly — they handle JSON parsing, quota errors, and
normalising older records.

Dates are stored as `YYYY-MM-DD` and must be parsed with `parseLocalDate()`.
Passing that string to `new Date()` parses it as UTC and lands on the wrong day
for anyone west of Greenwich.

Times are stored as 24-hour `HH:MM`, which compares and sorts as a plain
string. Only display goes through `formatTimeRange()`. The field is a native
`<input type="time">` so phones get their own wheel; the AM/PM buttons beside
it mirror and flip that value, since the input's own meridiem segment can't be
styled to show which one is selected.

`refreshTimeStates()` runs on a 30-second interval and nudges the now ticker
and the now/past-due classes in place rather than re-rendering, so the day
stays current without tearing an open time editor out from under you. The
timeline's window includes the current time, so when the clock walks past its
padding the scale itself grows — the refresh compares against
`timelineRangeUsed` and redraws the bar in that case, otherwise the ticker
would be measured against a different scale than the blocks and drift.

The ticker is white on purpose: task blocks are drawn in the accent colour
whatever the theme is, so an accent-coloured ticker disappears into them.

## Known issues

- **Old to-do history is discarded after 90 days.** `dailyTasks` keeps every
  day in one array, so `pruneOldTasks()` trims it past `TASK_RETENTION_DAYS` on
  load to stop it growing forever. Goal-derived tasks are redundant by then
  (the objective's own `completedDate` is what the calendar reads), but old
  quick tasks are the only record of themselves and are genuinely lost.

## Ideas

Recurring goals, streaks, a weekly review, filter/search on the goals list,
and a light theme (the palette is already centralised in `:root`).
