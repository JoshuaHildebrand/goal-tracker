/*
 * Goal Tracker
 *
 * A dependency-free goal tracker backed by localStorage.
 *
 * Storage layout:
 *   goal:<id>   -> a single Goal object (see the shape below)
 *   dailyTasks  -> an array of DailyTask objects, all days in one list
 *
 * Goal {
 *   id, title, deadline: 'YYYY-MM-DD'|null, isBoolean, completed,
 *   completedDate?: ISO, notes, archived?: true, createdAt: ISO,
 *   objectives: [{ text, completed, completedDate?: ISO, targetDate?: 'YYYY-MM-DD' }]
 * }
 *
 * DailyTask {
 *   id, objectiveId: '<goalId>-<index>'|'boolean-<goalId>'|null,
 *   goalId, objectiveIndex, goalTitle, objectiveText,
 *   date: 'YYYY-MM-DD', completed, isBoolean?, isQuickTask?
 * }
 *
 * Objectives are addressed by their array index, so a task's objectiveId is
 * only valid while that index is stable. See "Known issues" in README.md.
 */

const GOAL_PREFIX = 'goal:';
const DAILY_TASKS_KEY = 'dailyTasks';
const TAB_ORDER = ['goals', 'todo', 'calendar', 'archive'];

let currentCalendarDate = new Date();
let dailyTasks = [];

/* ---------------------------------------------------------------- storage */

function goalKey(id) {
  return `${GOAL_PREFIX}${id}`;
}

// Older records predate some fields; normalise so callers can assume the shape.
function normalizeGoal(goal) {
  if (!Array.isArray(goal.objectives)) goal.objectives = [];
  return goal;
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

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function todayKey() {
  return formatDateKey(new Date());
}

/* --------------------------------------------------------------- utitlity */

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
    renderObjectiveSelector();
    renderDailyTasks();
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
      : objectiveInputValues().map(text => ({ text, completed: false })),
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

function renderObjective(goal, obj, index) {
  return `
    <div>
      <div class="objective-checkbox ${obj.completed ? 'completed' : ''}">
        <input type="checkbox" id="obj-${goal.id}-${index}" ${obj.completed ? 'checked' : ''}
          onchange="toggleObjective('${goal.id}', ${index})">
        <label for="obj-${goal.id}-${index}"
          ondblclick="event.preventDefault(); editObjectiveText('${goal.id}', ${index})">${escapeHtml(obj.text)}</label>
        <button class="target-date-toggle" onclick="toggleTargetDate('${goal.id}', ${index})">&#128197;</button>
        <button class="btn-remove" onclick="removeObjective('${goal.id}', ${index})">&times;</button>
      </div>
      <div class="target-date-section" id="target-section-${goal.id}-${index}">
        <input type="date" id="target-${goal.id}-${index}" value="${obj.targetDate || ''}"
          onchange="saveObjectiveTarget('${goal.id}', ${index})">
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
        ? goal.objectives.map((obj, index) => renderObjective(goal, obj, index)).join('')
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

  if (!updateGoal(goalId, goal => { goal.objectives.push({ text, completed: false }); })) return;

  input.value = '';

  const wasCollapsed = document.getElementById(`goal-${goalId}`).classList.contains('collapsed');
  loadGoals();
  if (!wasCollapsed) {
    document.getElementById(`goal-${goalId}`).classList.remove('collapsed');
  }
}

function toggleObjective(goalId, objectiveIndex) {
  let nowCompleted = false;

  const updated = updateGoal(goalId, goal => {
    const objective = goal.objectives[objectiveIndex];
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

  const row = document.querySelector(`.objective-checkbox:has(#obj-${goalId}-${objectiveIndex})`);
  if (row) row.classList.toggle('completed', nowCompleted);

  updateGoalCardProgress(goalId);
  syncObjectiveWithDailyTasks(goalId, objectiveIndex, nowCompleted);
}

function editObjectiveText(goalId, objectiveIndex) {
  const label = document.querySelector(`label[for="obj-${goalId}-${objectiveIndex}"]`);
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
      if (!goal.objectives[objectiveIndex]) return false;
      goal.objectives[objectiveIndex].text = newText;
    });
    if (!updated) return;

    const newLabel = document.createElement('label');
    newLabel.htmlFor = `obj-${goalId}-${objectiveIndex}`;
    newLabel.textContent = newText;
    newLabel.ondblclick = event => {
      event.preventDefault();
      editObjectiveText(goalId, objectiveIndex);
    };
    input.replaceWith(newLabel);

    // Keep any to-do entries pointing at this objective in step.
    const objectiveId = `${goalId}-${objectiveIndex}`;
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

function removeObjective(goalId, objectiveIndex) {
  if (!confirm('Remove this objective?')) return;
  if (!updateGoal(goalId, goal => { goal.objectives.splice(objectiveIndex, 1); })) return;

  loadGoals();
}

function toggleTargetDate(goalId, objectiveIndex) {
  const section = document.getElementById(`target-section-${goalId}-${objectiveIndex}`);
  section.classList.toggle('show');

  if (section.classList.contains('show')) {
    document.getElementById(`target-${goalId}-${objectiveIndex}`).focus();
  }
}

function saveObjectiveTarget(goalId, objectiveIndex) {
  const targetDate = document.getElementById(`target-${goalId}-${objectiveIndex}`).value;

  const updated = updateGoal(goalId, goal => {
    if (!goal.objectives[objectiveIndex]) return false;
    goal.objectives[objectiveIndex].targetDate = targetDate || null;
  });
  if (!updated) return;

  if (isTabActive('calendar')) renderCalendar();
}

/* ------------------------------------------------------------ daily tasks */

function updateTodayDate() {
  document.getElementById('todayDate').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function todaysTasks() {
  const key = todayKey();
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
    date: todayKey(),
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

  const addedIds = new Set(todaysTasks().map(task => task.objectiveId));

  const html = goals.map(goal => {
    if (goal.isBoolean) {
      if (goal.completed) return '';

      const inList = addedIds.has(`boolean-${goal.id}`);
      return `
        <div class="goal-objectives-group">
          <div class="goal-objectives-title">${escapeHtml(goal.title)} (Yes/No Goal)</div>
          <div class="selectable-objective ${inList ? 'in-list' : ''}"
            onclick="toggleDailyTask('${goal.id}', -1)">
            <span>${inList ? '✓ ' : ''}Complete this goal</span>
          </div>
        </div>
      `;
    }

    const pending = goal.objectives
      .map((obj, index) => ({ ...obj, index }))
      .filter(obj => !obj.completed);

    if (pending.length === 0) return '';

    return `
      <div class="goal-objectives-group">
        <div class="goal-objectives-title">${escapeHtml(goal.title)}</div>
        ${pending.map(obj => {
          const inList = addedIds.has(`${goal.id}-${obj.index}`);
          return `
            <div class="selectable-objective ${inList ? 'in-list' : ''}"
              onclick="toggleDailyTask('${goal.id}', ${obj.index})">
              <span>${inList ? '✓ ' : ''}${escapeHtml(obj.text)}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }).join('');

  container.innerHTML = html || '<div class="empty-planner">All objectives completed!</div>';
}

// `objectiveIndex` of -1 addresses a boolean goal as a whole. Titles are read
// from storage here rather than passed through the markup, so a goal title
// containing quotes or backslashes can't break out of the onclick attribute.
function toggleDailyTask(goalId, objectiveIndex) {
  const goal = readGoal(goalId);
  if (!goal) return;

  const isBoolean = objectiveIndex < 0;
  const objectiveId = isBoolean ? `boolean-${goalId}` : `${goalId}-${objectiveIndex}`;
  const dateKey = todayKey();

  const existingIndex = dailyTasks.findIndex(
    task => task.objectiveId === objectiveId && task.date === dateKey
  );

  if (existingIndex >= 0) {
    dailyTasks.splice(existingIndex, 1);
  } else {
    const objective = isBoolean ? null : goal.objectives[objectiveIndex];
    if (!isBoolean && !objective) return;

    dailyTasks.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      objectiveId,
      goalId,
      objectiveIndex,
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
  const tasks = todaysTasks();

  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-planner">No tasks for today.</div>';
    return;
  }

  container.innerHTML = tasks.map(task => `
    <div class="daily-task ${task.completed ? 'completed' : ''}">
      <input type="checkbox" ${task.completed ? 'checked' : ''}
        onchange="toggleDailyTaskCompletion('${task.id}')">
      <div class="daily-task-text">
        <div class="daily-task-goal">from ${escapeHtml(task.goalTitle)}</div>
        <div class="daily-task-objective">${escapeHtml(task.objectiveText)}</div>
      </div>
      <button class="btn-remove" onclick="removeDailyTask('${task.id}')">&times;</button>
    </div>
  `).join('');
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

      const objective = goal.objectives[task.objectiveIndex];
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
          `.objective-checkbox:has(#obj-${task.goalId}-${task.objectiveIndex})`
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

function syncObjectiveWithDailyTasks(goalId, objectiveIndex, isCompleted) {
  const objectiveId = `${goalId}-${objectiveIndex}`;

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
loadGoals();
renderCalendar();
renderGoalsSidebar();
renderObjectiveSelector();
updateTodayDate();
