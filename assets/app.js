/*
 * Goal Tracker
 *
 * A dependency-free goal tracker backed by localStorage.
 *
 * Storage layout:
 *   goal:<id>      -> a single Goal object (see the shape below)
 *   dailyTasks     -> an array of DailyTask objects, all days in one list
 *   schemaVersion  -> guards the one-time migrations in this file
 *
 * Goal {
 *   id, title, deadline: 'YYYY-MM-DD'|null, isBoolean, completed,
 *   completedDate?: ISO, notes, archived?: true, createdAt: ISO,
 *   objectives: [{ id, text, completed, completedDate?: ISO,
 *                  targetDate?: 'YYYY-MM-DD' }]
 * }
 *
 * DailyTask {
 *   id, objectiveId: '<goalId>:<objectiveId>'|'boolean-<goalId>'|null,
 *   objectiveRef: <objectiveId>|null, goalId, goalTitle, objectiveText,
 *   date: 'YYYY-MM-DD', completed, isBoolean?, isQuickTask?
 * }
 *
 * Objectives carry their own id, so a task keeps pointing at the right one
 * even after its neighbours are deleted or reordered. Look them up with
 * findObjective(); never by array position.
 */

const GOAL_PREFIX = 'goal:';
const DAILY_TASKS_KEY = 'dailyTasks';
const SCHEMA_KEY = 'schemaVersion';

// 2 = objectives carry stable ids instead of being addressed by array position.
const SCHEMA_VERSION = 2;
const TAB_ORDER = ['goals', 'todo', 'calendar', 'archive'];

// How far back the To-Do history is kept. Every day's tasks live in one array
// that nothing else trims, so without this it grows for the life of the app.
const TASK_RETENTION_DAYS = 90;

let currentCalendarDate = new Date();
let dailyTasks = [];

// Which day the To-Do tab is showing. Tasks have always carried a date; this
// just lets you look at a day other than today, so tomorrow's list can be
// built tonight. Resets to today on reload.
let plannerDate = startOfToday();

// Which task has its time editor open. Held here so re-rendering after a save
// (which re-sorts the list) doesn't collapse the editor mid-edit.
let openTimeTaskId = null;

// The scheduled tasks currently drawn, in the order shown. The timeline reads
// this to map a click back to a task.
let scheduledForDay = [];

// The window the bar was last drawn against, so the ticker can tell when the
// scale has shifted under it and the bar needs redrawing rather than nudging.
let timelineRangeUsed = null;

/* ---------------------------------------------------------------- storage */

function goalKey(id) {
  return `${GOAL_PREFIX}${id}`;
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Older records predate some fields; normalise so callers can assume the shape.
// Objectives from before stable ids get a placeholder so nothing downstream has
// to cope with a missing id. It is derived from the position rather than random
// so that repeated reads agree with each other — a random id here would differ
// on every read and break every lookup until migrateObjectiveIds() persisted
// them. newId() never produces this shape, so the two can't collide.
function normalizeGoal(goal) {
  if (!Array.isArray(goal.objectives)) goal.objectives = [];
  goal.objectives.forEach((obj, index) => {
    if (!obj.id) obj.id = `legacy-${index}`;
  });
  return goal;
}

function findObjective(goal, objectiveRef) {
  return goal.objectives.find(obj => obj.id === objectiveRef) || null;
}

// How a to-do task points back at what it came from. A null ref means the
// whole goal, which is how yes/no goals are tracked.
function taskRef(goalId, objectiveRef) {
  return objectiveRef ? `${goalId}:${objectiveRef}` : `boolean-${goalId}`;
}

function readGoal(id) {
  try {
    const raw = localStorage.getItem(goalKey(id));
    return raw ? normalizeGoal(JSON.parse(raw)) : null;
  } catch (error) {
    console.error('Error reading goal:', error);
    return null;
  }
}

function writeGoal(goal) {
  try {
    localStorage.setItem(goalKey(goal.id), JSON.stringify(goal));
    return true;
  } catch (error) {
    console.error('Error saving goal:', error);
    alert('Failed to save goal. Storage may be full.');
    return false;
  }
}

// Read a goal, apply `mutate` to it, and persist the result. Returns the
// updated goal, or null if it was missing or `mutate` returned false to abort.
function updateGoal(id, mutate) {
  const goal = readGoal(id);
  if (!goal) return null;
  if (mutate(goal) === false) return null;
  return writeGoal(goal) ? goal : null;
}

function allGoals(predicate) {
  const goals = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(GOAL_PREFIX)) continue;

      const raw = localStorage.getItem(key);
      if (!raw) continue;

      const goal = normalizeGoal(JSON.parse(raw));
      if (!predicate || predicate(goal)) goals.push(goal);
    }
  } catch (error) {
    console.error('Error loading goals:', error);
  }
  return goals;
}

const activeGoals = () => allGoals(goal => !goal.archived);
const archivedGoals = () => allGoals(goal => goal.archived);

function saveDailyTasks() {
  try {
    localStorage.setItem(DAILY_TASKS_KEY, JSON.stringify(dailyTasks));
    return true;
  } catch (error) {
    console.error('Error saving daily tasks:', error);
    alert('Failed to save tasks. Storage may be full.');
    return false;
  }
}

function loadDailyTasks() {
  try {
    const raw = localStorage.getItem(DAILY_TASKS_KEY);
    dailyTasks = raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.error('Error loading daily tasks:', error);
    dailyTasks = [];
  }
  pruneOldTasks();
}

// One-time upgrade from positional objective references to stable ids.
//
// Tasks used to point at an objective by array position ('<goalId>-<index>'),
// so deleting an objective silently repointed existing tasks at whatever slid
// into that slot. Positions are still accurate at the moment we run, so we can
// map each one to the id now assigned to the objective sitting there.
//
// Runs after loadDailyTasks() so it can rewrite tasks in place, and is a no-op
// once every goal and task is already on the new scheme.
function migrateObjectiveIds() {
  if (Number(localStorage.getItem(SCHEMA_KEY)) >= SCHEMA_VERSION) return;

  // normalizeGoal() fills in ids on read; writing the goal back persists them.
  // Positions are still accurate right now, so record what each one maps to.
  const remap = new Map();

  allGoals().forEach(goal => {
    goal.objectives.forEach((obj, index) => remap.set(`${goal.id}-${index}`, obj.id));
    writeGoal(goal);
  });

  dailyTasks = dailyTasks.filter(task => {
    delete task.objectiveIndex; // positional leftover, on every task shape

    // Quick tasks and yes/no goals never referenced a position.
    if (!task.objectiveId || task.isQuickTask) return true;
    if (task.objectiveId.startsWith('boolean-')) return true;
    if (task.objectiveId.includes(':')) return true;

    const objectiveRef = remap.get(task.objectiveId);
    if (!objectiveRef) return false; // goal deleted, or the slot no longer exists

    task.objectiveRef = objectiveRef;
    task.objectiveId = taskRef(task.goalId, objectiveRef);
    delete task.objectiveIndex;
    return true;
  });

  // Only claim the upgrade once the rewritten tasks are safely stored, so a
  // failed write here means we retry next load rather than stranding them.
  if (saveDailyTasks()) localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
}

// Drop history past the retention window. Goal-derived tasks are redundant by
// then — the objective carries its own completedDate, which is what the
// calendar reads — so only stale quick-task records are actually lost. Future
// dates are always kept, since planning ahead is the point of the day switcher.
function pruneOldTasks() {
  const cutoff = startOfToday();
  cutoff.setDate(cutoff.getDate() - TASK_RETENTION_DAYS);
  const cutoffKey = formatDateKey(cutoff);

  // Date keys are 'YYYY-MM-DD', so a string compare is a chronological one.
  const kept = dailyTasks.filter(task => task.date >= cutoffKey);
  if (kept.length === dailyTasks.length) return;

  dailyTasks = kept;
  saveDailyTasks();
}

/* ------------------------------------------------------- export / import */

// Bumped only if the file layout itself changes. Distinct from SCHEMA_VERSION,
// which describes the records inside.
const EXPORT_FORMAT = 1;

function appDataKeys() {
  return Object.keys(localStorage).filter(
    key => key.startsWith(GOAL_PREFIX) || key === DAILY_TASKS_KEY || key === SCHEMA_KEY);
}

function exportData() {
  const payload = {
    app: 'goal-tracker',
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    // Carried so an older backup still migrates correctly when it lands.
    schemaVersion: Number(localStorage.getItem(SCHEMA_KEY)) || null,
    goals: allGoals(),
    dailyTasks
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `goal-tracker-${formatDateKey(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Checked before anything is written, so a bad file can't half-apply.
function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { error: 'That file isn’t valid JSON.' };
  }

  if (!data || typeof data !== 'object') return { error: 'That file doesn’t look like a backup.' };
  if (data.app !== 'goal-tracker') return { error: 'That backup came from a different app.' };
  if (!Array.isArray(data.goals) || !Array.isArray(data.dailyTasks)) {
    return { error: 'That backup is missing its goals or its tasks.' };
  }
  if (data.goals.some(goal => !goal || typeof goal.id !== 'string' || typeof goal.title !== 'string')) {
    return { error: 'That backup contains a goal record that can’t be read.' };
  }
  if (data.dailyTasks.some(task => !task || typeof task.id !== 'string')) {
    return { error: 'That backup contains a task record that can’t be read.' };
  }

  return { data };
}

// localStorage has no transaction, so take a copy first: a quota error midway
// through would otherwise leave the user with neither their old data nor the
// imported set.
function applyImport(data) {
  const snapshot = {};
  appDataKeys().forEach(key => { snapshot[key] = localStorage.getItem(key); });

  try {
    appDataKeys().forEach(key => localStorage.removeItem(key));

    data.goals.forEach(goal => localStorage.setItem(goalKey(goal.id), JSON.stringify(goal)));
    localStorage.setItem(DAILY_TASKS_KEY, JSON.stringify(data.dailyTasks));

    // Left unset when the backup predates the stamp, so the migration reruns.
    if (data.schemaVersion) localStorage.setItem(SCHEMA_KEY, String(data.schemaVersion));
    return true;
  } catch (error) {
    console.error('Import failed, rolling back:', error);
    appDataKeys().forEach(key => localStorage.removeItem(key));
    Object.entries(snapshot).forEach(([key, value]) => localStorage.setItem(key, value));
    alert('Import failed and nothing was changed. The backup may be too large for this browser.');
    return false;
  }
}

function importData(input) {
  const file = input.files && input.files[0];
  input.value = ''; // so picking the same file twice still fires a change
  if (!file) return;

  file.text().then(text => {
    const { data, error } = parseImport(text);
    if (error) {
      alert(error);
      return;
    }

    const goals = data.goals.length;
    const tasks = data.dailyTasks.length;
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'an unknown date';

    const confirmed = confirm(
      `Import ${goals} goal${goals === 1 ? '' : 's'} and ${tasks} task${tasks === 1 ? '' : 's'} ` +
      `saved on ${when}?\n\nThis replaces everything currently stored in this browser.`);

    if (confirmed && applyImport(data)) location.reload();
  }).catch(() => alert('That file couldn’t be read.'));
}

/* ----------------------------------------------------------------- domain */

// A boolean goal counts as a single unit of work; others count objectives.
function goalCounts(goal) {
  if (goal.isBoolean) return { completed: goal.completed ? 1 : 0, total: 1 };
  return {
    completed: goal.objectives.filter(obj => obj.completed).length,
    total: goal.objectives.length
  };
}

function goalProgress(goal) {
  const { completed, total } = goalCounts(goal);
  return total > 0 ? (completed / total) * 100 : 0;
}

function byDeadline(a, b) {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return new Date(a.deadline) - new Date(b.deadline);
}

/* ------------------------------------------------------------------ dates */

// 'YYYY-MM-DD' parsed in local time. `new Date(str)` would read it as UTC and
// shift the day for anyone west of Greenwich.
function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDeadline(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Times are stored as 24-hour 'HH:MM', which sorts and compares as plain
// strings. Only display goes through 12-hour formatting.
function formatTime(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return {
    text: `${hours % 12 || 12}:${String(minutes).padStart(2, '0')}`,
    period: hours < 12 ? 'AM' : 'PM'
  };
}

// '9:00–9:30 AM' when both sides share a meridiem, '11:30 AM–1:00 PM' when not.
function formatTimeRange(start, end) {
  const from = formatTime(start);
  if (!end) return `${from.text} ${from.period}`;

  const to = formatTime(end);
  return from.period === to.period
    ? `${from.text}–${to.text} ${to.period}`
    : `${from.text} ${from.period}–${to.text} ${to.period}`;
}

// An end at or before its start is nonsense, so it's ignored for display and
// flagged rather than silently dropped or blocked while the user is mid-edit.
function hasValidEnd(task) {
  return Boolean(task.start && task.end && task.end > task.start);
}

function minutesOf(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

function currentTimeKey() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// Ids of scheduled tasks whose block runs into the next one's. Flagged, not
// prevented — double-booking is sometimes deliberate.
function overlappingTaskIds(scheduled) {
  const clashing = new Set();

  scheduled.forEach((task, i) => {
    const next = scheduled[i + 1];
    if (!next || !hasValidEnd(task)) return;
    if (task.end > next.start) {
      clashing.add(task.id);
      clashing.add(next.id);
    }
  });

  return clashing;
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/* --------------------------------------------------------------- utility */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function isTabActive(tabName) {
  return document.getElementById(`${tabName}-tab`).classList.contains('active');
}

/* ------------------------------------------------------------------- tabs */

function activateTab(tabName) {
  const index = TAB_ORDER.indexOf(tabName);
  document.querySelectorAll('.tab').forEach((tab, i) => {
    tab.classList.toggle('active', i === index);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });
  document.getElementById(`${tabName}-tab`).classList.add('active');
}

function switchTab(tabName) {
  activateTab(tabName);

  // Every tab re-reads storage on entry: the same goal can be edited from the
  // Goals, To-Do and Calendar tabs, so whichever one you land on must refresh.
  if (tabName === 'goals') {
    loadGoals();
  } else if (tabName === 'todo') {
    renderPlanner();
  } else if (tabName === 'calendar') {
    renderCalendar();
    renderGoalsSidebar();
  } else if (tabName === 'archive') {
    loadArchivedGoals();
  }
}

/* -------------------------------------------------------------- goal form */

function toggleAddGoalSection() {
  document.getElementById('addGoalSection').classList.toggle('collapsed');
}

function toggleObjectivesSection() {
  const isBoolean = document.getElementById('isBooleanGoal').checked;
  document.getElementById('objectivesFormGroup').style.display = isBoolean ? 'none' : 'block';
}

function addObjectiveInput() {
  const list = document.getElementById('objectivesList');

  const item = document.createElement('div');
  item.className = 'objective-item';
  item.innerHTML = `
    <input type="text" placeholder="Enter an objective">
    <button type="button" class="btn-remove" onclick="this.parentElement.remove()">&times;</button>
  `;

  list.appendChild(item);
  item.querySelector('input').focus();
}

// The inputs are the source of truth, read at submit time. Mirroring them into
// an array meant removing a row left the remaining rows writing to stale slots.
function objectiveInputValues() {
  return Array.from(document.querySelectorAll('#objectivesList input'))
    .map(input => input.value.trim())
    .filter(text => text !== '');
}

function resetGoalForm() {
  document.getElementById('goalForm').reset();
  document.getElementById('objectivesList').innerHTML = '';
  document.getElementById('objectivesFormGroup').style.display = 'block';
  document.getElementById('addGoalSection').classList.add('collapsed');
  addObjectiveInput();
}

document.getElementById('goalForm').addEventListener('submit', event => {
  event.preventDefault();

  const isBoolean = document.getElementById('isBooleanGoal').checked;
  const deadline = document.getElementById('goalDeadline').value;

  const goal = {
    id: Date.now().toString(),
    title: document.getElementById('goalTitle').value.trim(),
    deadline: deadline || null,
    isBoolean,
    completed: false,
    objectives: isBoolean
      ? []
      : objectiveInputValues().map(text => ({ id: newId(), text, completed: false })),
    notes: '',
    createdAt: new Date().toISOString()
  };

  if (!writeGoal(goal)) return;

  resetGoalForm();
  loadGoals();
});

/* --------------------------------------------------------- goal rendering */

function loadGoals() {
  const goals = activeGoals();

  if (goals.length === 0) {
    showEmptyState();
    return;
  }

  goals.sort(byDeadline);
  document.getElementById('goalsContainer').innerHTML =
    goals.map(goal => renderGoalCard(goal, false)).join('');
}

function loadArchivedGoals() {
  const goals = archivedGoals();
  const container = document.getElementById('archivedGoalsContainer');

  container.innerHTML = goals.length === 0
    ? '<div class="empty-state"><p>No archived goals</p></div>'
    : goals.map(goal => renderGoalCard(goal, true)).join('');
}

function showEmptyState() {
  document.getElementById('goalsContainer').innerHTML = `
    <div class="empty-state">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
      </svg>
      <p>No goals yet. Create your first goal!</p>
    </div>
  `;
}

function renderDeadlineBadge(goal) {
  if (!goal.deadline) {
    return `<div class="goal-deadline none" id="deadline-display-${goal.id}"
      onclick="event.stopPropagation(); editDeadlineInline('${goal.id}', '')">None</div>`;
  }

  const isOverdue = parseLocalDate(goal.deadline) < startOfToday();
  return `<div class="goal-deadline ${isOverdue ? 'overdue' : ''}" id="deadline-display-${goal.id}"
    onclick="event.stopPropagation(); editDeadlineInline('${goal.id}', '${goal.deadline}')">${formatDeadline(parseLocalDate(goal.deadline))}</div>`;
}

function renderObjective(goal, obj) {
  const ref = `${goal.id}-${obj.id}`;

  return `
    <div>
      <div class="objective-checkbox ${obj.completed ? 'completed' : ''}">
        <input type="checkbox" id="obj-${ref}" ${obj.completed ? 'checked' : ''}
          onchange="toggleObjective('${goal.id}', '${obj.id}')">
        <label for="obj-${ref}"
          ondblclick="event.preventDefault(); editObjectiveText('${goal.id}', '${obj.id}')">${escapeHtml(obj.text)}</label>
        <button class="target-date-toggle" onclick="toggleTargetDate('${goal.id}', '${obj.id}')">&#128197;</button>
        <button class="btn-remove" onclick="removeObjective('${goal.id}', '${obj.id}')">&times;</button>
      </div>
      <div class="target-date-section" id="target-section-${ref}">
        <input type="date" id="target-${ref}" value="${obj.targetDate || ''}"
          onchange="saveObjectiveTarget('${goal.id}', '${obj.id}')">
        <label>Target date</label>
      </div>
    </div>
  `;
}

function renderGoalBody(goal) {
  if (goal.isBoolean) {
    return `
      <div class="boolean-goal-toggle">
        <label>
          <input type="checkbox" ${goal.completed ? 'checked' : ''} onchange="toggleBooleanGoal('${goal.id}')">
          <span>Mark as ${goal.completed ? 'Incomplete' : 'Complete'}</span>
        </label>
      </div>
    `;
  }

  const { completed, total } = goalCounts(goal);

  return `
    <div class="objectives-section">
      <h3>Objectives (${completed}/${total})</h3>
      ${goal.objectives.length > 0
        ? goal.objectives.map(obj => renderObjective(goal, obj)).join('')
        : '<div class="no-objectives">No objectives yet</div>'}

      <div class="add-objective-row">
        <input type="text" id="new-objective-${goal.id}" placeholder="Add objective"
          onkeypress="if(event.key==='Enter'){event.preventDefault(); addObjective('${goal.id}');}">
        <button class="btn btn-primary" onclick="addObjective('${goal.id}')">Add</button>
      </div>
    </div>
  `;
}

function renderGoalActions(goal, isArchived) {
  if (isArchived) {
    return `
      <button class="btn btn-secondary" onclick="unarchiveGoal('${goal.id}')">Unarchive</button>
      <button class="btn btn-delete" onclick="deleteGoalPermanently('${goal.id}')">Delete Permanently</button>
    `;
  }

  const archiveBtn = goalProgress(goal) === 100
    ? `<button class="btn btn-secondary btn-archive" onclick="archiveGoal('${goal.id}')">Archive</button>`
    : '';

  return `${archiveBtn}<button class="btn btn-delete" onclick="deleteGoal('${goal.id}')">Delete</button>`;
}

function renderGoalCard(goal, isArchived) {
  const progress = goalProgress(goal);

  return `
    <div class="goal-card collapsed" id="goal-${goal.id}">
      <div class="goal-header" onclick="toggleGoalCard('${goal.id}')">
        <h2 class="goal-title" ondblclick="event.stopPropagation(); editGoalTitle('${goal.id}')">${escapeHtml(goal.title)}</h2>
        <div class="goal-header-right">
          ${goal.isBoolean ? '<div class="boolean-goal-badge">Yes/No</div>' : ''}
          ${progress === 100 ? '<div class="completed-badge">&#10003;</div>' : ''}
          ${renderDeadlineBadge(goal)}
          <span class="expand-icon">&#9660;</span>
        </div>
      </div>

      <div class="goal-content">
        ${renderGoalBody(goal)}

        <div class="notes-section">
          <h3>Notes</h3>
          <textarea id="notes-${goal.id}" placeholder="Add notes..."
            onblur="saveNotes('${goal.id}')">${escapeHtml(goal.notes || '')}</textarea>
        </div>

        <div class="progress-bar">
          <div class="progress-label">
            <span>Progress</span>
            <span id="progress-${goal.id}">${Math.round(progress)}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="progress-fill-${goal.id}" style="width: ${progress}%"></div>
          </div>
        </div>

        ${renderGoalActions(goal, isArchived)}
      </div>
    </div>
  `;
}

function toggleGoalCard(goalId) {
  document.getElementById(`goal-${goalId}`).classList.toggle('collapsed');
}

// Patch a single card in place rather than re-rendering the whole list, so the
// card keeps its expanded/collapsed state while the user works through it.
function updateGoalCardProgress(goalId) {
  const goal = readGoal(goalId);
  const card = goal && document.getElementById(`goal-${goalId}`);
  if (!card) return;

  const progress = goalProgress(goal);
  const { completed, total } = goalCounts(goal);

  const progressFill = document.getElementById(`progress-fill-${goalId}`);
  const progressLabel = document.getElementById(`progress-${goalId}`);
  const objectivesHeader = card.querySelector('.objectives-section h3');

  if (progressFill) progressFill.style.width = `${progress}%`;
  if (progressLabel) progressLabel.textContent = `${Math.round(progress)}%`;
  if (objectivesHeader) objectivesHeader.textContent = `Objectives (${completed}/${total})`;

  const completedBadge = card.querySelector('.completed-badge');
  const archiveBtn = card.querySelector('.btn-archive');

  if (progress === 100 && !completedBadge) {
    const badge = document.createElement('div');
    badge.className = 'completed-badge';
    badge.textContent = '✓';

    const headerRight = card.querySelector('.goal-header-right');
    headerRight.insertBefore(badge, headerRight.children[goal.isBoolean ? 1 : 0]);

    if (!archiveBtn) {
      const button = document.createElement('button');
      button.className = 'btn btn-secondary btn-archive';
      button.textContent = 'Archive';
      button.onclick = () => archiveGoal(goalId);

      const deleteBtn = card.querySelector('.btn-delete');
      deleteBtn.parentNode.insertBefore(button, deleteBtn);
    }
  } else if (progress < 100 && completedBadge) {
    completedBadge.remove();
    if (archiveBtn) archiveBtn.remove();
  }
}

/* --------------------------------------------------------- goal mutations */

function toggleBooleanGoal(goalId) {
  const updated = updateGoal(goalId, goal => {
    goal.completed = !goal.completed;
    if (goal.completed) {
      goal.completedDate = new Date().toISOString();
    } else {
      delete goal.completedDate;
    }
  });

  if (updated) updateGoalCardProgress(goalId);
}

function editGoalTitle(goalId) {
  const header = document.querySelector(`#goal-${goalId} .goal-title`);
  const currentTitle = header.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'inline-edit inline-edit-title';

  header.replaceWith(input);
  input.focus();
  input.select();

  const save = () => {
    const newTitle = input.value.trim();
    if (!newTitle) {
      input.value = currentTitle;
      return;
    }

    if (!updateGoal(goalId, goal => { goal.title = newTitle; })) return;

    const newHeader = document.createElement('h2');
    newHeader.className = 'goal-title';
    newHeader.textContent = newTitle;
    newHeader.ondblclick = event => {
      event.stopPropagation();
      editGoalTitle(goalId);
    };
    input.replaceWith(newHeader);

    if (isTabActive('calendar')) renderGoalsSidebar();
  };

  input.onblur = save;
  input.onkeydown = event => {
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') {
      input.value = currentTitle;
      save();
    }
  };
}

function saveNotes(goalId) {
  const notes = document.getElementById(`notes-${goalId}`).value;
  updateGoal(goalId, goal => { goal.notes = notes; });
}

function editDeadlineInline(goalId, currentDeadline) {
  const display = document.getElementById(`deadline-display-${goalId}`);
  if (display.classList.contains('editing')) return;

  display.classList.add('editing');
  display.innerHTML =
    `<input type="date" id="deadline-edit-${goalId}" value="${currentDeadline || ''}">`;

  const input = document.getElementById(`deadline-edit-${goalId}`);
  input.focus();
  input.addEventListener('blur', () => saveDeadlineInline(goalId));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') input.blur();
  });
}

function saveDeadlineInline(goalId) {
  const input = document.getElementById(`deadline-edit-${goalId}`);
  if (!input) return;

  const newDeadline = input.value;
  if (!updateGoal(goalId, goal => { goal.deadline = newDeadline || null; })) return;

  loadGoals();
  if (isTabActive('calendar')) {
    renderCalendar();
    renderGoalsSidebar();
  }
}

function archiveGoal(goalId) {
  if (!confirm('Archive this completed goal?')) return;
  if (!updateGoal(goalId, goal => { goal.archived = true; })) return;

  const card = document.getElementById(`goal-${goalId}`);
  if (card) {
    card.style.animation = 'fadeOut 0.3s ease-out';
    setTimeout(loadGoals, 300);
  } else {
    loadGoals();
  }
}

function unarchiveGoal(goalId) {
  if (!updateGoal(goalId, goal => { delete goal.archived; })) return;

  loadArchivedGoals();
  loadGoals();
}

function deleteGoal(goalId) {
  if (!confirm('Delete this goal?')) return;
  localStorage.removeItem(goalKey(goalId));
  loadGoals();
}

function deleteGoalPermanently(goalId) {
  if (!confirm('Permanently delete this goal? This cannot be undone.')) return;
  localStorage.removeItem(goalKey(goalId));
  loadArchivedGoals();
}

/* ---------------------------------------------------------- objective CRUD */

function addObjective(goalId) {
  const input = document.getElementById(`new-objective-${goalId}`);
  const text = input.value.trim();

  if (!text) {
    alert('Please enter an objective');
    return;
  }

  if (!updateGoal(goalId, goal => { goal.objectives.push({ id: newId(), text, completed: false }); })) return;

  input.value = '';

  const wasCollapsed = document.getElementById(`goal-${goalId}`).classList.contains('collapsed');
  loadGoals();
  if (!wasCollapsed) {
    document.getElementById(`goal-${goalId}`).classList.remove('collapsed');
  }
}

function toggleObjective(goalId, objectiveRef) {
  let nowCompleted = false;

  const updated = updateGoal(goalId, goal => {
    const objective = findObjective(goal, objectiveRef);
    if (!objective) return false;

    nowCompleted = !objective.completed;
    objective.completed = nowCompleted;

    if (nowCompleted) {
      objective.completedDate = new Date().toISOString();
    } else {
      delete objective.completedDate;
    }
  });

  if (!updated) return;

  const row = document.querySelector(`.objective-checkbox:has(#obj-${goalId}-${objectiveRef})`);
  if (row) row.classList.toggle('completed', nowCompleted);

  updateGoalCardProgress(goalId);
  syncObjectiveWithDailyTasks(goalId, objectiveRef, nowCompleted);
}

function editObjectiveText(goalId, objectiveRef) {
  const label = document.querySelector(`label[for="obj-${goalId}-${objectiveRef}"]`);
  const currentText = label.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentText;
  input.className = 'inline-edit inline-edit-objective';

  label.replaceWith(input);
  input.focus();
  input.select();

  const save = () => {
    const newText = input.value.trim();
    if (!newText) {
      input.value = currentText;
      return;
    }

    const updated = updateGoal(goalId, goal => {
      const objective = findObjective(goal, objectiveRef);
      if (!objective) return false;
      objective.text = newText;
    });
    if (!updated) return;

    const newLabel = document.createElement('label');
    newLabel.htmlFor = `obj-${goalId}-${objectiveRef}`;
    newLabel.textContent = newText;
    newLabel.ondblclick = event => {
      event.preventDefault();
      editObjectiveText(goalId, objectiveRef);
    };
    input.replaceWith(newLabel);

    // Keep any to-do entries pointing at this objective in step.
    const objectiveId = taskRef(goalId, objectiveRef);
    dailyTasks.forEach(task => {
      if (task.objectiveId === objectiveId) task.objectiveText = newText;
    });
    saveDailyTasks();

    if (isTabActive('todo')) renderDailyTasks();
  };

  input.onblur = save;
  input.onkeydown = event => {
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') {
      input.value = currentText;
      save();
    }
  };
}

function removeObjective(goalId, objectiveRef) {
  if (!confirm('Remove this objective?')) return;

  const updated = updateGoal(goalId, goal => {
    const index = goal.objectives.findIndex(obj => obj.id === objectiveRef);
    if (index < 0) return false;
    goal.objectives.splice(index, 1);
  });
  if (!updated) return;

  // Tasks pointing at the removed objective would otherwise linger with no
  // objective behind them. Other objectives keep their ids, so nothing else
  // is disturbed by the shift.
  const objectiveId = taskRef(goalId, objectiveRef);
  const before = dailyTasks.length;
  dailyTasks = dailyTasks.filter(task => task.objectiveId !== objectiveId);
  if (dailyTasks.length !== before) saveDailyTasks();

  loadGoals();
  if (isTabActive('todo')) renderPlanner();
}

function toggleTargetDate(goalId, objectiveRef) {
  const section = document.getElementById(`target-section-${goalId}-${objectiveRef}`);
  section.classList.toggle('show');

  if (section.classList.contains('show')) {
    document.getElementById(`target-${goalId}-${objectiveRef}`).focus();
  }
}

function saveObjectiveTarget(goalId, objectiveRef) {
  const targetDate = document.getElementById(`target-${goalId}-${objectiveRef}`).value;

  const updated = updateGoal(goalId, goal => {
    const objective = findObjective(goal, objectiveRef);
    if (!objective) return false;
    objective.targetDate = targetDate || null;
  });
  if (!updated) return;

  if (isTabActive('calendar')) renderCalendar();
}

/* ------------------------------------------------------------ daily tasks */

function plannerKey() {
  return formatDateKey(plannerDate);
}

function changePlannerDay(delta) {
  plannerDate.setDate(plannerDate.getDate() + delta);
  renderPlanner();
}

function goToToday() {
  plannerDate = startOfToday();
  renderPlanner();
}

// Everything on the To-Do tab keys off the selected day, so one call refreshes
// the header, the task list, and which objectives show as already added.
function renderPlanner() {
  renderPlannerDate();
  renderDailyTasks();
  renderObjectiveSelector();
}

function renderPlannerDate() {
  const offset = Math.round((plannerDate - startOfToday()) / 86400000);
  const relative = { '-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow' }[offset];

  // Kept short so it fits one line on a phone. The relative word already
  // implies the year, and repeating the weekday next to "Tomorrow" is noise.
  const date = plannerDate.toLocaleDateString('en-US', relative
    ? { month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  document.getElementById('plannerDate').textContent = relative ? `${relative} · ${date}` : date;

  // Only offer the way back when there's somewhere to come back from.
  document.getElementById('plannerToday').style.display = offset === 0 ? 'none' : 'inline-block';
}

function tasksForSelectedDay() {
  const key = plannerKey();
  return dailyTasks.filter(task => task.date === key);
}

function addQuickTask() {
  const input = document.getElementById('quickTaskInput');
  const text = input.value.trim();

  if (!text) {
    alert('Please enter a task');
    return;
  }

  dailyTasks.push({
    id: Date.now().toString(),
    objectiveId: null,
    goalId: null,
    objectiveText: text,
    goalTitle: 'Quick Task',
    date: plannerKey(),
    completed: false,
    isQuickTask: true
  });

  saveDailyTasks();
  input.value = '';
  renderDailyTasks();
}

function renderObjectiveSelector() {
  const container = document.getElementById('objectiveSelector');
  const goals = activeGoals().sort(byDeadline);

  if (goals.length === 0) {
    container.innerHTML = '<div class="empty-planner">Create goals to add tasks.</div>';
    return;
  }

  const addedIds = new Set(tasksForSelectedDay().map(task => task.objectiveId));

  const html = goals.map(goal => {
    if (goal.isBoolean) {
      if (goal.completed) return '';

      const inList = addedIds.has(`boolean-${goal.id}`);
      return `
        <div class="goal-objectives-group">
          <div class="goal-objectives-title">${escapeHtml(goal.title)} (Yes/No Goal)</div>
          <div class="selectable-objective ${inList ? 'in-list' : ''}"
            onclick="toggleDailyTask('${goal.id}', '')">
            <span>${inList ? '✓ ' : ''}Complete this goal</span>
          </div>
        </div>
      `;
    }

    const pending = goal.objectives.filter(obj => !obj.completed);
    if (pending.length === 0) return '';

    return `
      <div class="goal-objectives-group">
        <div class="goal-objectives-title">${escapeHtml(goal.title)}</div>
        ${pending.map(obj => {
          const inList = addedIds.has(taskRef(goal.id, obj.id));
          return `
            <div class="selectable-objective ${inList ? 'in-list' : ''}"
              onclick="toggleDailyTask('${goal.id}', '${obj.id}')">
              <span>${inList ? '✓ ' : ''}${escapeHtml(obj.text)}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }).join('');

  container.innerHTML = html || '<div class="empty-planner">All objectives completed!</div>';
}

// An empty objectiveRef addresses a yes/no goal as a whole. Titles are read
// from storage here rather than passed through the markup, so a goal title
// containing quotes or backslashes can't break out of the onclick attribute.
function toggleDailyTask(goalId, objectiveRef) {
  const goal = readGoal(goalId);
  if (!goal) return;

  const isBoolean = !objectiveRef;
  const objectiveId = taskRef(goalId, objectiveRef);
  const dateKey = plannerKey();

  const existingIndex = dailyTasks.findIndex(
    task => task.objectiveId === objectiveId && task.date === dateKey
  );

  if (existingIndex >= 0) {
    dailyTasks.splice(existingIndex, 1);
  } else {
    const objective = isBoolean ? null : findObjective(goal, objectiveRef);
    if (!isBoolean && !objective) return;

    dailyTasks.push({
      id: newId(),
      objectiveId,
      objectiveRef: objectiveRef || null,
      goalId,
      goalTitle: goal.title,
      objectiveText: isBoolean ? goal.title : objective.text,
      date: dateKey,
      completed: false,
      isBoolean
    });
  }

  saveDailyTasks();
  renderDailyTasks();
  renderObjectiveSelector();
}

function renderDailyTasks() {
  const container = document.getElementById('dailyTaskList');
  const tasks = tasksForSelectedDay();

  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-planner">Nothing planned for this day yet.</div>';
    scheduledForDay = [];
    renderDayTimeline([], null);
    return;
  }

  const scheduled = tasks.filter(task => task.start).sort((a, b) => a.start.localeCompare(b.start));
  const anytime = tasks.filter(task => !task.start);

  const clashing = overlappingTaskIds(scheduled);
  // "Now" and "past due" only mean anything on the day you're actually living.
  const now = plannerIsToday() ? currentTimeKey() : null;

  let html = scheduled.map(task => renderDailyTask(task, { clashing, now })).join('');

  if (anytime.length > 0) {
    if (scheduled.length > 0) html += '<div class="task-group-label">Anytime</div>';
    html += anytime.map(task => renderDailyTask(task, { clashing, now })).join('');
  }

  container.innerHTML = html;

  scheduledForDay = scheduled;
  renderDayTimeline(scheduled, now);
}

function renderDailyTask(task, { clashing, now }) {
  const state = taskTimeState(task, now);

  const classes = [
    'daily-task',
    task.completed ? 'completed' : '',
    clashing.has(task.id) ? 'clashing' : '',
    state
  ].filter(Boolean).join(' ');

  // What's live now is shown by emphasis rather than a word, so the list can be
  // read at a glance. The label stays for screen readers, which get nothing
  // from a glow.
  const timeLabel = task.start
    ? `<div class="daily-task-time">${formatTimeRange(task.start, hasValidEnd(task) ? task.end : null)}
         ${state === 'now' ? '<span class="sr-only">happening now</span>' : ''}</div>`
    : '';

  const badEnd = task.start && task.end && !hasValidEnd(task);

  return `
    <div>
      <div class="${classes}" data-task-id="${task.id}"
        ${state === 'now' ? 'aria-current="time"' : ''}>
        <input type="checkbox" ${task.completed ? 'checked' : ''}
          onchange="toggleDailyTaskCompletion('${task.id}')">
        <div class="daily-task-text">
          <div class="daily-task-actions">
            <button class="task-time-toggle ${task.start ? 'set' : ''}"
              onclick="toggleTaskTime('${task.id}')" aria-label="Set time">&#128336;</button>
            <button class="btn-remove" onclick="removeDailyTask('${task.id}')"
              aria-label="Remove task">&times;</button>
          </div>
          ${task.isQuickTask ? '' : `<div class="daily-task-goal">from ${escapeHtml(task.goalTitle)}</div>`}
          <div class="daily-task-objective" ondblclick="editTaskText('${task.id}')"
            title="Double-tap to rename">${escapeHtml(task.objectiveText)}</div>
          ${timeLabel}
        </div>
      </div>
      <div class="task-time-section ${openTimeTaskId === task.id ? 'show' : ''}"
        id="time-section-${task.id}">
        <div class="time-field"><span class="time-field-label">From</span>
          ${renderTimePicker(task.id, 'start', task.start)}</div>
        <div class="time-field"><span class="time-field-label">To</span>
          ${renderTimePicker(task.id, 'end', task.end)}</div>
        ${badEnd ? '<div class="time-warning">End must be after the start time.</div>' : ''}
      </div>
    </div>
  `;
}

/* --------------------------------------------------------- day timeline */

// A task with no end still needs to be visible on the bar.
const STUB_BLOCK_MINUTES = 15;
const TIMELINE_PAD_MINUTES = 30;

// The window the bar covers: everything scheduled, plus now when it's today,
// padded out to whole hours so the tick labels land on the hour.
function timelineRange(scheduled, now) {
  const points = [];

  scheduled.forEach(task => {
    points.push(minutesOf(task.start));
    points.push(hasValidEnd(task) ? minutesOf(task.end) : minutesOf(task.start) + STUB_BLOCK_MINUTES);
  });
  if (now) points.push(minutesOf(now));

  if (points.length === 0) return null;

  const from = Math.max(0, Math.floor((Math.min(...points) - TIMELINE_PAD_MINUTES) / 60) * 60);
  const to = Math.min(24 * 60, Math.ceil((Math.max(...points) + TIMELINE_PAD_MINUTES) / 60) * 60);

  return { from, to: Math.max(to, from + 60) };
}

function hourLabel(minutes) {
  const hour = Math.floor(minutes / 60) % 24;
  return `${hour % 12 || 12}${hour < 12 ? 'a' : 'p'}`;
}

function renderDayTimeline(scheduled, now) {
  const el = document.getElementById('dayTimeline');
  const range = timelineRange(scheduled, now);

  timelineRangeUsed = range;

  if (!range) {
    el.innerHTML = '';
    el.classList.add('empty');
    return;
  }
  el.classList.remove('empty');

  const span = range.to - range.from;
  const pct = minutes => ((minutes - range.from) / span) * 100;

  let html = '';
  for (let m = range.from; m <= range.to; m += 60) {
    html += `<div class="timeline-tick" style="top: ${pct(m)}%"><span>${hourLabel(m)}</span></div>`;
  }

  html += scheduled.map(task => {
    const from = minutesOf(task.start);
    const to = hasValidEnd(task) ? minutesOf(task.end) : from + STUB_BLOCK_MINUTES;
    const state = taskTimeState(task, now);

    return `<div class="timeline-block ${state} ${task.completed ? 'done' : ''}"
      data-task-id="${task.id}"
      style="top: ${pct(from)}%; height: ${Math.max(pct(to) - pct(from), 1.2)}%"></div>`;
  }).join('');

  if (now) {
    html += `<div class="timeline-now" id="timelineNow" title="Now — ${formatTimeRange(now, null)}"
      style="top: ${pct(minutesOf(now))}%"></div>`;
  }

  el.innerHTML = html;
}

// Where a task sits relative to the clock: '', 'now', or 'overdue'. Lateness is
// measured from the end of a block so work in progress isn't called late.
function taskTimeState(task, now) {
  if (!now || !task.start || task.completed) return '';

  if (hasValidEnd(task) && task.start <= now && now < task.end) return 'now';

  const deadline = hasValidEnd(task) ? task.end : task.start;
  return deadline < now ? 'overdue' : '';
}

// Clicking the bar jumps the list to whatever is happening at that point —
// which, for a click on or near the now marker, is the task you're in.
function timelineJump(event) {
  const el = document.getElementById('dayTimeline');
  if (el.classList.contains('empty') || scheduledForDay.length === 0) return;

  const rect = el.getBoundingClientRect();
  const range = timelineRange(scheduledForDay, plannerIsToday() ? currentTimeKey() : null);
  if (!rect.height || !range) return;

  const ratio = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
  const at = range.from + ratio * (range.to - range.from);

  // Every block covering that moment, not just the first — overlapping work is
  // exactly when you need to be shown all of it.
  const containing = scheduledForDay.filter(task => {
    const from = minutesOf(task.start);
    const to = hasValidEnd(task) ? minutesOf(task.end) : from + STUB_BLOCK_MINUTES;
    return at >= from && at < to;
  });

  // Nothing runs at that moment, so fall back to whatever comes next.
  const targets = containing.length > 0
    ? containing
    : [scheduledForDay.find(task => minutesOf(task.start) >= at)
       || scheduledForDay[scheduledForDay.length - 1]].filter(Boolean);

  if (targets.length === 0) return;

  targets.forEach(task => pingTask(task.id));

  // They're adjacent in the list, being sorted by start, so centring the
  // earliest keeps the rest of the group in view.
  const row = document.querySelector(`.daily-task[data-task-id="${targets[0].id}"]`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function pingTask(taskId) {
  const row = document.querySelector(`.daily-task[data-task-id="${taskId}"]`);
  if (!row) return;

  // Removing the class then forcing a reflow restarts the animation, so a
  // second click on the same spot flashes again instead of sitting inert.
  row.classList.remove('pinged');
  void row.offsetWidth;
  row.classList.add('pinged');
}

function plannerIsToday() {
  return plannerKey() === formatDateKey(startOfToday());
}

// Reposition the now marker and re-evaluate now/overdue without re-rendering,
// so the day stays accurate while the tab sits open and an open time editor
// isn't torn out from under the user mid-edit.
function refreshTimeStates() {
  if (!isTabActive('todo') || !plannerIsToday()) return;

  const now = currentTimeKey();
  const range = timelineRange(scheduledForDay, now);

  // The window includes "now", so once the clock walks past the padding the
  // scale itself grows. Moving only the marker would then measure it against a
  // different scale than the blocks were drawn on, and everything would drift
  // apart — so redraw the bar whenever the range changes.
  if (range && timelineRangeUsed &&
      (range.from !== timelineRangeUsed.from || range.to !== timelineRangeUsed.to)) {
    renderDayTimeline(scheduledForDay, now);
  } else {
    const marker = document.getElementById('timelineNow');
    if (marker && range) {
      const span = range.to - range.from;
      marker.style.top = `${((minutesOf(now) - range.from) / span) * 100}%`;
      marker.title = `Now — ${formatTimeRange(now, null)}`;
    }
  }

  scheduledForDay.forEach(task => {
    const state = taskTimeState(task, now);
    [
      document.querySelector(`.daily-task[data-task-id="${task.id}"]`),
      document.querySelector(`.timeline-block[data-task-id="${task.id}"]`)
    ].forEach(el => {
      if (!el) return;
      el.classList.toggle('now', state === 'now');
      el.classList.toggle('overdue', state === 'overdue');
    });
  });
}

/* ------------------------------------------------------------ time picker */

const MINUTE_STEP = 5;

// A meridiem chosen before an hour has nowhere to live yet — the stored value
// is 24-hour, so AM/PM is only derivable once there's an hour. Keyed
// '<taskId>-<which>' and cleared as soon as the time is real.
const pendingMeridiem = {};

function meridiemFor(taskId, which, value) {
  if (value) return minutesOf(value) < 720 ? 'AM' : 'PM';
  return pendingMeridiem[`${taskId}-${which}`] || (new Date().getHours() < 12 ? 'AM' : 'PM');
}

// The field itself is a native <input type="time"> so phones get their own
// wheel. The meridiem is mirrored into a pair of buttons beside it, because
// the input's own AM/PM segment can't be styled to show which is selected —
// the buttons are both a readout and a way to flip it.
function renderTimePicker(taskId, which, value) {
  const meridiem = meridiemFor(taskId, which, value);

  return `
    <div class="time-picker" id="tp-${which}-${taskId}">
      <input type="time" class="tp-input" id="tp-input-${which}-${taskId}"
        aria-label="${which === 'start' ? 'Start' : 'End'} time" value="${value || ''}"
        onchange="saveTaskTime('${taskId}', '${which}')">
      <button type="button" class="tp-meridiem ${meridiem === 'AM' ? 'active' : ''}"
        aria-pressed="${meridiem === 'AM'}"
        onclick="setMeridiem('${taskId}', '${which}', 'AM')">AM</button>
      <button type="button" class="tp-meridiem ${meridiem === 'PM' ? 'active' : ''}"
        aria-pressed="${meridiem === 'PM'}"
        onclick="setMeridiem('${taskId}', '${which}', 'PM')">PM</button>
    </div>
  `;
}

function readTimePicker(taskId, which) {
  const input = document.getElementById(`tp-input-${which}-${taskId}`);
  return input && input.value ? input.value : null;
}

function setMeridiem(taskId, which, meridiem) {
  const input = document.getElementById(`tp-input-${which}-${taskId}`);
  if (!input) return;

  // With a time already entered, the buttons shift it by twelve hours. With an
  // empty field there's nothing to shift, so remember the choice for whenever
  // an hour does arrive.
  if (input.value) {
    const total = minutesOf(input.value);
    const isPm = total >= 720;

    if ((meridiem === 'PM') !== isPm) {
      const shifted = (total + (meridiem === 'PM' ? 720 : -720) + 1440) % 1440;
      input.value = `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
    }
  }

  document.querySelectorAll(`#tp-${which}-${taskId} .tp-meridiem`).forEach(button => {
    const isChosen = button.textContent === meridiem;
    button.classList.toggle('active', isChosen);
    button.setAttribute('aria-pressed', String(isChosen));
  });

  pendingMeridiem[`${taskId}-${which}`] = meridiem;
  saveTaskTime(taskId, which);
}

function toggleTaskTime(taskId) {
  openTimeTaskId = openTimeTaskId === taskId ? null : taskId;
  renderDailyTasks();
  if (openTimeTaskId) focusPicker(taskId, 'start');
}

function focusPicker(taskId, which) {
  const input = document.getElementById(`tp-input-${which}-${taskId}`);
  if (!input) return;

  input.focus();
  // Pop the wheel straight open where the browser allows it, so setting a
  // start leads directly into setting an end.
  try {
    input.showPicker();
  } catch (error) {
    // Not supported, or needs a fresh gesture — focus alone is the fallback.
  }
}

function saveTaskTime(taskId, which) {
  const task = dailyTasks.find(t => t.id === taskId);
  if (!task) return;

  const hadStart = Boolean(task.start);
  const [wasStart, wasEnd] = [task.start, task.end];

  task.start = readTimePicker(taskId, 'start');
  task.end = readTimePicker(taskId, 'end');

  // An end with no start has nothing to anchor it.
  if (!task.start) task.end = null;

  // Choosing a minute or meridiem before an hour doesn't make a time yet.
  // Re-rendering on those keystrokes would rebuild the picker from the stored
  // (still empty) value and throw the half-finished selection away, so leave
  // the DOM alone until something actually changed.
  if (task.start === wasStart && task.end === wasEnd) return;

  if (task.start) delete pendingMeridiem[`${taskId}-start`];
  if (task.end) delete pendingMeridiem[`${taskId}-end`];

  saveDailyTasks();
  renderDailyTasks(); // re-sorts; openTimeTaskId keeps this row's editor open

  // Setting a start is nearly always followed by setting an end, so hand the
  // user straight over instead of making them reach for the second field.
  if (which === 'start' && !hadStart && task.start && !task.end) {
    focusPicker(taskId, 'end');
  }
}

function editTaskText(taskId) {
  const task = dailyTasks.find(t => t.id === taskId);
  const label = document.querySelector(`.daily-task[data-task-id="${taskId}"] .daily-task-objective`);
  if (!task || !label) return;

  const current = task.objectiveText;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'inline-edit inline-edit-task';

  label.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const save = () => {
    if (settled) return;
    settled = true;

    const text = input.value.trim();
    if (!text || text === current) {
      renderDailyTasks();
      return;
    }
    renameTask(taskId, text);
  };

  input.onblur = save;
  input.onkeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
    if (event.key === 'Escape') {
      input.value = current;
      input.blur();
    }
  };
}

// A goal-derived task is a view of its objective, so renaming it renames the
// objective rather than letting the two drift apart. Quick tasks own their own
// text and change alone.
function renameTask(taskId, text) {
  const task = dailyTasks.find(t => t.id === taskId);
  if (!task) return;

  if (task.objectiveRef) {
    const updated = updateGoal(task.goalId, goal => {
      const objective = findObjective(goal, task.objectiveRef);
      if (!objective) return false;
      objective.text = text;
    });
    if (updated) {
      dailyTasks.forEach(other => {
        if (other.objectiveId === task.objectiveId) other.objectiveText = text;
      });
    }
  } else if (task.isBoolean && task.goalId) {
    // The text of a yes/no task is the goal's own title.
    const updated = updateGoal(task.goalId, goal => { goal.title = text; });
    if (updated) {
      dailyTasks.forEach(other => {
        if (other.goalId !== task.goalId) return;
        other.goalTitle = text;
        if (other.isBoolean) other.objectiveText = text;
      });
    }
  } else {
    task.objectiveText = text;
  }

  saveDailyTasks();
  renderPlanner();
}

function removeDailyTask(taskId) {
  const index = dailyTasks.findIndex(task => task.id === taskId);
  if (index < 0) return;

  dailyTasks.splice(index, 1);
  saveDailyTasks();
  renderDailyTasks();
  renderObjectiveSelector();
}

// Ticking a to-do writes straight through to the goal it came from.
function toggleDailyTaskCompletion(taskId) {
  const task = dailyTasks.find(t => t.id === taskId);
  if (!task) return;

  task.completed = !task.completed;

  if (!task.isQuickTask) {
    const stamp = () => (task.completed ? new Date().toISOString() : null);

    updateGoal(task.goalId, goal => {
      if (task.isBoolean) {
        goal.completed = task.completed;
        if (task.completed) {
          goal.completedDate = stamp();
        } else {
          delete goal.completedDate;
        }
        return;
      }

      const objective = findObjective(goal, task.objectiveRef);
      if (!objective) return false;

      objective.completed = task.completed;
      if (task.completed) {
        objective.completedDate = stamp();
      } else {
        delete objective.completedDate;
      }
    });

    if (isTabActive('goals')) {
      if (!task.isBoolean) {
        const row = document.querySelector(
          `.objective-checkbox:has(#obj-${task.goalId}-${task.objectiveRef})`
        );
        if (row) row.classList.toggle('completed', task.completed);
      }
      updateGoalCardProgress(task.goalId);
    }
  }

  saveDailyTasks();
  renderDailyTasks();
  renderCalendar();
}

function syncObjectiveWithDailyTasks(goalId, objectiveRef, isCompleted) {
  const objectiveId = taskRef(goalId, objectiveRef);

  dailyTasks.forEach(task => {
    if (task.objectiveId === objectiveId) task.completed = isCompleted;
  });

  saveDailyTasks();
  if (isTabActive('todo')) renderDailyTasks();
}

/* --------------------------------------------------------------- calendar */

// One pass over storage producing every date-keyed lookup the calendar needs.
function buildCalendarIndex() {
  const completions = {};
  const deadlines = {};
  const targets = {};

  const push = (map, key, value) => {
    if (!map[key]) map[key] = [];
    map[key].push(value);
  };

  allGoals().forEach(goal => {
    if (goal.isBoolean && goal.completed && goal.completedDate) {
      push(completions, goal.completedDate.split('T')[0], {
        goalTitle: goal.title,
        objectiveText: goal.title
      });
    }

    if (goal.deadline && !goal.archived) {
      const { completed, total } = goalCounts(goal);
      push(deadlines, goal.deadline, {
        goalTitle: goal.title,
        completedCount: completed,
        totalCount: total,
        progress: Math.round(goalProgress(goal))
      });
    }

    goal.objectives.forEach(obj => {
      if (obj.completed && obj.completedDate) {
        push(completions, obj.completedDate.split('T')[0], {
          goalTitle: goal.title,
          objectiveText: obj.text
        });
      }

      if (obj.targetDate) {
        push(targets, obj.targetDate, {
          goalTitle: goal.title,
          objectiveText: obj.text,
          completed: obj.completed || false
        });
      }
    });
  });

  return { completions, deadlines, targets };
}

function changeMonth(delta) {
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() + delta);
  renderCalendar();
}

function renderCalendar() {
  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();

  document.getElementById('currentMonth').textContent =
    currentCalendarDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const { completions, deadlines, targets } = buildCalendarIndex();

  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
    const header = document.createElement('div');
    header.className = 'calendar-day-header';
    header.textContent = day;
    grid.appendChild(header);
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const today = startOfToday();

  for (let i = firstDay - 1; i >= 0; i--) {
    grid.appendChild(createCalendarDay(daysInPrevMonth - i, { isOtherMonth: true }));
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    date.setHours(0, 0, 0, 0);
    const dateKey = formatDateKey(date);

    grid.appendChild(createCalendarDay(day, {
      date,
      isToday: date.getTime() === today.getTime(),
      completions: completions[dateKey] || [],
      deadlines: deadlines[dateKey] || [],
      targets: targets[dateKey] || []
    }));
  }

  // Always fill a 6x7 grid so the calendar doesn't change height month to month.
  const trailing = 42 - (firstDay + daysInMonth);
  for (let day = 1; day <= trailing; day++) {
    grid.appendChild(createCalendarDay(day, { isOtherMonth: true }));
  }
}

function createCalendarDay(dayNumber, options) {
  const {
    date = null,
    isOtherMonth = false,
    isToday = false,
    completions = [],
    deadlines = [],
    targets = []
  } = options;

  const cell = document.createElement('div');
  cell.className = 'calendar-day';

  if (isOtherMonth) cell.classList.add('other-month');
  if (isToday) cell.classList.add('today');
  if (completions.length > 0) cell.classList.add('has-completions');
  if (deadlines.length > 0) cell.classList.add('has-deadline');
  if (targets.length > 0) cell.classList.add('has-target');

  const number = document.createElement('div');
  number.className = 'calendar-day-number';
  number.textContent = dayNumber;
  cell.appendChild(number);

  if (deadlines.length > 0) {
    cell.appendChild(dayBadge('red', '\u{1F534}', deadlines.length));
  }

  if (targets.length > 0) {
    cell.appendChild(dayBadge('yellow', '\u{1F7E1}', targets.length));
  }

  if (completions.length > 0) {
    const dots = document.createElement('div');
    dots.className = 'calendar-day-dots';
    for (let i = 0; i < Math.min(completions.length, 3); i++) {
      const dot = document.createElement('div');
      dot.className = 'calendar-day-dot';
      dots.appendChild(dot);
    }
    cell.appendChild(dots);
  }

  if (completions.length > 0 || deadlines.length > 0 || targets.length > 0) {
    cell.style.cursor = 'pointer';
    cell.onclick = () => showDayDetails(date, completions, deadlines, targets);
  }

  return cell;
}

function dayBadge(colorClass, emoji, count) {
  const badge = document.createElement('div');
  badge.className = `deadline-badge ${colorClass}`;
  badge.textContent = count === 1 ? emoji : `${emoji}${count}`;
  return badge;
}

function showDayDetails(date, completions, deadlines, targets) {
  const sections = [];

  if (deadlines.length > 0) {
    sections.push(`
      <div class="section-title">&#128308; Goal Deadlines</div>
      ${deadlines.map(d => `
        <div class="deadline-item">
          <div class="detail-title">${escapeHtml(d.goalTitle)}</div>
          <div class="detail-meta">Progress: ${d.completedCount}/${d.totalCount} (${d.progress}%)</div>
        </div>
      `).join('')}
    `);
  }

  if (targets.length > 0) {
    sections.push(`
      <div class="section-title">&#128993; Objective Targets</div>
      ${targets.map(t => `
        <div class="target-item">
          <div class="detail-title">${escapeHtml(t.objectiveText)}</div>
          <div class="detail-meta">from: ${escapeHtml(t.goalTitle)}${t.completed ? ' ✓' : ''}</div>
        </div>
      `).join('')}
    `);
  }

  if (completions.length > 0) {
    sections.push(`
      <div class="section-title">&#9989; Completed</div>
      ${completions.map(c => `
        <div class="completion-item">
          <div class="detail-title">${escapeHtml(c.objectiveText)}</div>
          <div class="detail-meta">from: ${escapeHtml(c.goalTitle)}</div>
        </div>
      `).join('')}
    `);
  }

  document.getElementById('dayDetailsDate').textContent = date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });

  document.getElementById('dayDetailsContent').innerHTML = sections.length > 0
    ? sections.join('<div class="section-divider"></div>')
    : '<div class="no-completions">Nothing scheduled.</div>';

  document.getElementById('dayDetailsModal').classList.add('active');
}

function closeDayDetails(event) {
  // Ignore clicks that bubbled up from inside the dialog.
  if (event && event.target !== document.getElementById('dayDetailsModal')) return;
  document.getElementById('dayDetailsModal').classList.remove('active');
}

function renderGoalsSidebar() {
  const container = document.getElementById('goalsSidebarList');
  const goals = activeGoals().filter(goal => goal.deadline).sort(byDeadline);

  if (goals.length === 0) {
    container.innerHTML = '<div class="no-goals-sidebar">No goals with deadlines</div>';
    return;
  }

  const today = startOfToday();

  container.innerHTML = goals.map(goal => {
    const deadline = parseLocalDate(goal.deadline);
    const { completed, total } = goalCounts(goal);

    return `
      <div class="sidebar-goal-item" onclick="scrollToGoal('${goal.id}')">
        <div class="sidebar-goal-title">${escapeHtml(goal.title)}</div>
        <div class="sidebar-goal-deadline ${deadline < today ? 'overdue' : ''}">&#128308; ${formatDeadline(deadline)}</div>
        <div class="sidebar-goal-progress">${Math.round(goalProgress(goal))}% (${completed}/${total})</div>
      </div>
    `;
  }).join('');
}

function scrollToGoal(goalId) {
  activateTab('goals');
  loadGoals();

  const card = document.getElementById(`goal-${goalId}`);
  if (!card) return;

  card.classList.remove('collapsed');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });

  card.style.animation = 'none';
  requestAnimationFrame(() => {
    card.style.animation = 'pulse 0.5s ease-out';
  });
}

/* ------------------------------------------------------------------- init */

addObjectiveInput();
loadDailyTasks();
migrateObjectiveIds();
loadGoals();
renderCalendar();
renderGoalsSidebar();
renderPlanner();

// Keeps the now marker and the now/past-due emphasis honest while the tab sits
// open. Patches classes and one style rather than re-rendering, so an open time
// editor survives the tick.
setInterval(refreshTimeStates, 30000);
