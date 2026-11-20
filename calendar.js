const dayLength = 86_400_000;

function localToday() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / dayLength;
}

function dayKey(day) {
  return new Date(day * dayLength).toISOString().slice(0, 10);
}

function timeValue(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours * 60 + minutes) * 60_000;
}

export function renderCalendar(container, {
  locale,
  t,
  icon,
  preferences: initialPreferences,
  events: initialEvents = [],
  navigation = {},
  onPreferences,
  onSaveEvent,
  onDeleteEvent,
  renderConnections,
}) {
  const localeInfo = new Intl.Locale(locale);
  const localeWeekStart = ((localeInfo.getWeekInfo?.() ?? localeInfo.weekInfo)?.firstDay ?? 1) % 7;
  const direction = (localeInfo.getTextInfo?.() ?? localeInfo.textInfo)?.direction;
  const rtl = (direction ?? container.closest('[dir]')?.dir) === 'rtl';
  const preferences = { system: null, view: 'month', firstDay: null, ...initialPreferences };
  const formatTime = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', timeStyle: 'short' });
  const formatCount = new Intl.NumberFormat(locale);
  let formatMonth;
  let formatWeek;
  let formatDay;
  let formatDate;
  let monthDayNumber;
  let eventsByDate;
  let selectedDay = navigation.selectedDay ?? localToday();
  let activeDay = navigation.activeDay ?? selectedDay;
  let editorEvent;
  let editorDay;
  let deleteCandidate;
  let savingSettings = false;
  let savingEvent = false;
  let deletingEvent = false;

  function configureDates() {
    const options = {
      timeZone: 'UTC',
      calendar: preferences.system ?? (localeInfo.language === 'fa' ? 'persian' : 'gregory'),
    };
    formatMonth = new Intl.DateTimeFormat(locale, { ...options, month: 'long', year: 'numeric' });
    formatWeek = new Intl.DateTimeFormat(locale, { ...options, month: 'short', day: 'numeric', year: 'numeric' });
    formatDay = new Intl.DateTimeFormat(locale, { ...options, day: 'numeric' });
    formatDate = new Intl.DateTimeFormat(locale, { ...options, dateStyle: 'full' });
    monthDayNumber = new Intl.DateTimeFormat(locale, { ...options, day: 'numeric', numberingSystem: 'latn' });
  }

  function monthStart(day) {
    const dayPart = monthDayNumber.formatToParts(day * dayLength).find(part => part.type === 'day');
    return day - Number(dayPart.value) + 1;
  }

  function weekOffset(day) {
    const weekday = new Date(day * dayLength).getUTCDay();
    return (weekday - (preferences.firstDay ?? localeWeekStart) + 7) % 7;
  }

  function nextMonth(start) {
    return monthStart(start + 32);
  }

  function setEvents(events) {
    eventsByDate = new Map();
    for (const event of events) {
      if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
      eventsByDate.get(event.date).push(event);
    }
    for (const dayEvents of eventsByDate.values()) {
      dayEvents.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.title.localeCompare(b.title, locale));
    }
  }

  container.innerHTML = `
    <div class="calendar">
      <div class="calendar-options">
        <div class="calendar-view-switch">
          <button type="button" class="calendar-view-button" data-view="month" data-label="calendarMonthView"></button>
          <button type="button" class="calendar-view-button" data-view="week" data-label="calendarWeekView"></button>
        </div>
        <details class="calendar-config">
          <summary class="calendar-config-toggle">${icon('settings')}<span data-label="calendarSettings"></span></summary>
          <div class="calendar-config-fields">
            <label><span data-label="calendarSystem"></span>
              <select class="calendar-select" data-calendar-system>
                <option value="" data-label="calendarSystemDefault"></option>
                <option value="gregory" data-label="calendarGregorian"></option>
                <option value="persian" data-label="calendarPersian"></option>
                <option value="islamic-civil" data-label="calendarHijri"></option>
              </select>
            </label>
            <label><span data-label="calendarWeekStart"></span>
              <select class="calendar-select" data-calendar-week-start>
                <option value="" data-label="calendarSystemDefault"></option>
              </select>
            </label>
          </div>
        </details>
        <p class="calendar-form-status" data-calendar-settings-status role="status" hidden></p>
      </div>
      <div class="calendar-toolbar">
        <h3 class="calendar-month" id="calendar-month-heading" aria-live="polite"></h3>
        <button type="button" class="calendar-today" data-label="today"></button>
        <div class="calendar-nav">
          <button type="button" class="calendar-nav-button" data-month-step="-1"></button>
          <button type="button" class="calendar-nav-button" data-month-step="1"></button>
        </div>
      </div>
      <table class="calendar-grid" role="grid" aria-labelledby="calendar-month-heading">
        <thead><tr></tr></thead>
        <tbody></tbody>
      </table>
      <p class="calendar-summary">
        <span class="calendar-summary-label" data-label="calendarSelected"></span>
        <span class="calendar-summary-date" aria-live="polite"></span>
      </p>
      <section class="calendar-agenda" aria-labelledby="calendar-agenda-heading">
        <div class="calendar-agenda-header">
          <h4 id="calendar-agenda-heading" data-label="calendarEvents"></h4>
          <button type="button" class="calendar-add-event">${icon('plus')}<span data-label="calendarAddEvent"></span></button>
        </div>
        <form class="calendar-event-form" hidden>
          <h5 class="calendar-form-title"></h5>
          <p class="calendar-form-date"></p>
          <label class="calendar-field">
            <span data-label="calendarEventTitle"></span>
            <input name="title" type="text" maxlength="160" dir="auto" required>
          </label>
          <label class="calendar-all-day">
            <input name="allDay" type="checkbox" checked>
            <span data-label="calendarAllDay"></span>
          </label>
          <div class="calendar-time-fields">
            <label class="calendar-field">
              <span data-label="calendarStarts"></span>
              <input name="start" type="time" required>
            </label>
            <label class="calendar-field">
              <span data-label="calendarEnds"></span>
              <input name="end" type="time" required>
            </label>
          </div>
          <label class="calendar-field">
            <span data-label="calendarLocation"></span>
            <input name="location" type="text" maxlength="240" dir="auto">
          </label>
          <label class="calendar-field">
            <span data-label="calendarNotes"></span>
            <textarea name="notes" rows="2" maxlength="2000" dir="auto"></textarea>
          </label>
          <p class="calendar-form-status" role="status" hidden></p>
          <div class="calendar-form-actions">
            <button type="submit" class="primary-button" data-label="save"></button>
            <button type="button" class="secondary-button" data-calendar-cancel data-label="cancel"></button>
          </div>
        </form>
        <div class="calendar-events"></div>
      </section>
      <div class="calendar-connections"></div>
    </div>
  `;

  const heading = container.querySelector('.calendar-month');
  const todayButton = container.querySelector('.calendar-today');
  const previousButton = container.querySelector('[data-month-step="-1"]');
  const nextButton = container.querySelector('[data-month-step="1"]');
  const viewButtons = Array.from(container.querySelectorAll('.calendar-view-button'));
  const systemSelect = container.querySelector('[data-calendar-system]');
  const weekSelect = container.querySelector('[data-calendar-week-start]');
  const settingsStatus = container.querySelector('[data-calendar-settings-status]');
  const grid = container.querySelector('.calendar-grid');
  const body = grid.tBodies[0];
  const selectedDate = container.querySelector('.calendar-summary-date');
  const addButton = container.querySelector('.calendar-add-event');
  const agenda = container.querySelector('.calendar-events');
  const editor = container.querySelector('.calendar-event-form');
  const editorTitle = editor.elements.namedItem('title');
  const allDayField = editor.elements.namedItem('allDay');
  const startField = editor.elements.namedItem('start');
  const endField = editor.elements.namedItem('end');
  const editorStatus = editor.querySelector('.calendar-form-status');
  const editorCancel = editor.querySelector('[data-calendar-cancel]');

  for (const label of container.querySelectorAll('[data-label]')) label.textContent = t(label.dataset.label);
  previousButton.innerHTML = icon(rtl ? 'chevron-right' : 'chevron-left');
  nextButton.innerHTML = icon(rtl ? 'chevron-left' : 'chevron-right');

  const shortWeekday = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: localeInfo.language === 'fa' ? 'narrow' : 'short',
  });
  const longWeekday = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long' });
  const weekdays = Array.from({ length: 7 }, (_, day) => {
    // The first day of the Unix epoch was Thursday.
    const time = (day - 4 + 7) % 7 * dayLength;
    return { label: shortWeekday.format(time), fullLabel: longWeekday.format(time) };
  });
  for (const [day, weekday] of weekdays.entries()) {
    weekSelect.add(new Option(weekday.fullLabel, String(day)));
  }

  function updateWeekdays() {
    const header = grid.tHead.rows[0];
    header.replaceChildren();
    for (let offset = 0; offset < 7; offset += 1) {
      const weekday = weekdays[((preferences.firstDay ?? localeWeekStart) + offset) % 7];
      const cell = document.createElement('th');
      cell.className = 'calendar-weekday';
      cell.scope = 'col';
      cell.setAttribute('aria-label', weekday.fullLabel);
      cell.textContent = weekday.label;
      header.append(cell);
    }
  }

  function updateControls() {
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.view === preferences.view));
      button.disabled = savingSettings;
    }
    systemSelect.value = preferences.system ?? '';
    weekSelect.value = preferences.firstDay ?? '';
    systemSelect.disabled = savingSettings;
    weekSelect.disabled = savingSettings;
  }

  function updateGrid(focusDay = false) {
    const today = localToday();
    const weekly = preferences.view === 'week';
    const firstDate = weekly ? activeDay - weekOffset(activeDay) : monthStart(activeDay);
    const start = firstDate - weekOffset(firstDate);
    const end = weekly ? start + 7 : nextMonth(firstDate);
    const monthLabel = weekly
      ? formatWeek.formatRange(start * dayLength, (end - 1) * dayLength)
      : formatMonth.format(firstDate * dayLength);
    const dateLabel = formatDate.format(selectedDay * dayLength);
    if (heading.textContent !== monthLabel) heading.textContent = monthLabel;
    if (selectedDate.textContent !== dateLabel) selectedDate.textContent = dateLabel;
    previousButton.setAttribute('aria-label', t(weekly ? 'previousWeek' : 'previousMonth'));
    nextButton.setAttribute('aria-label', t(weekly ? 'nextWeek' : 'nextMonth'));

    body.replaceChildren();
    for (let week = start; week < end; week += 7) {
      const row = body.insertRow();
      for (let offset = 0; offset < 7; offset += 1) {
        const day = week + offset;
        const cell = row.insertCell();
        cell.className = 'calendar-cell';
        if (day < firstDate || day >= end) continue;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-day';
        button.dataset.day = day;
        button.tabIndex = day === activeDay ? 0 : -1;
        button.textContent = formatDay.format(day * dayLength);
        const eventCount = eventsByDate.get(dayKey(day))?.length ?? 0;
        const buttonDate = formatDate.format(day * dayLength);
        button.setAttribute('aria-label', eventCount
          ? `${buttonDate}, ${t('calendarEventCount', { count: formatCount.format(eventCount) })}`
          : buttonDate);
        if (eventCount) {
          button.classList.add('has-events');
          const dot = document.createElement('span');
          dot.className = 'calendar-event-dot';
          dot.setAttribute('aria-hidden', 'true');
          button.append(dot);
        }
        button.classList.toggle('is-selected', day === selectedDay);
        button.classList.toggle('is-today', day === today);
        cell.setAttribute('aria-selected', String(day === selectedDay));
        if (day === today) button.setAttribute('aria-current', 'date');
        cell.append(button);
      }
    }

    if (focusDay) body.querySelector(`[data-day="${activeDay}"]`).focus();
  }

  function updateAgenda() {
    const dayEvents = eventsByDate.get(dayKey(selectedDay)) ?? [];
    const focusedRow = document.activeElement.closest('.calendar-event');
    const focusedControl = focusedRow && Array.from(focusedRow.querySelectorAll('button')).indexOf(document.activeElement);
    agenda.replaceChildren();
    if (!dayEvents.length) {
      appendText(agenda, 'p', 'calendar-empty', t('calendarNoEvents'));
      agenda.firstElementChild.hidden = !editor.hidden;
      return;
    }
    for (const event of dayEvents) {
      const row = document.createElement('div');
      row.className = 'calendar-event';
      row.dataset.event = event.id;
      const content = document.createElement(event.readOnly ? 'div' : 'button');
      content.className = 'calendar-event-content';
      if (!event.readOnly) {
        content.type = 'button';
        content.title = t('calendarEditEvent');
        content.disabled = !editor.hidden;
        content.addEventListener('click', () => openEditor(event));
      }
      appendText(content, 'span', 'calendar-event-title', event.title || t('calendarEventTitle'));
      const time = eventTime(event);
      appendText(content, 'span', 'calendar-event-time', time);
      if (event.location) appendText(content, 'span', 'calendar-event-location', event.location);
      if (event.notes && event.readOnly) appendText(content, 'span', 'calendar-event-notes', event.notes);
      if (event.provider === 'google' || event.provider === 'apple') {
        appendText(content, 'span', 'calendar-event-provider', t(event.provider === 'google' ? 'googleCalendar' : 'appleCalendar'));
      }
      row.append(content);
      if (!event.readOnly) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'calendar-event-delete';
        remove.setAttribute('aria-label', t('calendarDeleteEvent'));
        remove.title = t('calendarDeleteEvent');
        remove.disabled = deletingEvent;
        remove.innerHTML = icon('trash');
        remove.addEventListener('click', () => {
          if (deletingEvent) return;
          deleteCandidate = event.id;
          updateAgenda();
          agenda.querySelector('.calendar-event-confirm button').focus();
        });
        row.append(remove);
        if (deleteCandidate === event.id) row.append(deletePrompt(event));
      }
      agenda.append(row);
    }
    if (focusedRow && focusedControl >= 0) {
      Array.from(agenda.children).find(row => row.dataset.event === focusedRow.dataset.event)
        ?.querySelectorAll('button')[focusedControl]?.focus();
    }
  }

  function eventTime(event) {
    if (!event.start) {
      return event.end ? `${t('calendarEnds')} ${formatTime.format(timeValue(event.end))}` : t('calendarAllDay');
    }
    const start = timeValue(event.start);
    if (!event.end) return formatTime.format(start);
    const end = timeValue(event.end);
    if (start <= end) return formatTime.formatRange(start, end);
    return `${formatTime.format(start)} – ${formatTime.format(end)}`;
  }

  function appendText(parent, tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.dir = 'auto';
    element.textContent = text;
    parent.append(element);
  }

  function deletePrompt(event) {
    const prompt = document.createElement('div');
    prompt.className = 'calendar-event-confirm';
    prompt.innerHTML = `
      <p></p>
      <p class="calendar-form-status" role="status" hidden></p>
      <div class="calendar-form-actions">
        <button type="button" class="secondary-button"></button>
        <button type="button" class="secondary-button"></button>
      </div>
    `;
    prompt.firstElementChild.textContent = t('calendarConfirmDelete', { title: event.title });
    const [cancel, remove] = prompt.querySelectorAll('button');
    cancel.textContent = t('cancel');
    remove.textContent = t('remove');
    cancel.disabled = deletingEvent;
    remove.disabled = deletingEvent;
    cancel.addEventListener('click', () => {
      deleteCandidate = undefined;
      updateAgenda();
      Array.from(agenda.children).find(row => row.dataset.event === event.id)
        ?.querySelector('.calendar-event-delete')?.focus();
    });
    remove.addEventListener('click', async () => {
      deletingEvent = true;
      cancel.disabled = true;
      remove.disabled = true;
      const deleted = await runChange(onDeleteEvent, event.id);
      deletingEvent = false;
      if (deleted) {
        deleteCandidate = undefined;
        if (editorEvent?.id === event.id) closeEditor();
        updateAgenda();
        addButton.focus();
      } else {
        updateAgenda();
        const currentPrompt = agenda.querySelector('.calendar-event-confirm');
        if (currentPrompt) {
          setStatus(currentPrompt.querySelector('[role="status"]'), 'deleteFailed');
          currentPrompt.querySelector('button').focus();
        }
      }
    });
    return prompt;
  }

  function setStatus(element, message) {
    element.textContent = message ? t(message) : '';
    element.hidden = !message;
  }

  async function runChange(callback, value) {
    try {
      return await callback?.(value);
    } catch {
      return false;
    }
  }

  function toggleTimes() {
    editor.querySelector('.calendar-time-fields').hidden = allDayField.checked;
    startField.disabled = allDayField.checked || savingEvent;
    endField.disabled = allDayField.checked || savingEvent;
  }

  function openEditor(event) {
    if (!editor.hidden) return;
    editorEvent = event;
    editorDay = selectedDay;
    editor.hidden = false;
    addButton.disabled = true;
    editor.querySelector('.calendar-form-title').textContent = t(event ? 'calendarEditEvent' : 'calendarAddEvent');
    editor.querySelector('.calendar-form-date').textContent = formatDate.format(editorDay * dayLength);
    editorTitle.value = event?.title ?? '';
    allDayField.checked = !event?.start;
    startField.value = event?.start || '09:00';
    endField.value = event?.end || '10:00';
    editor.elements.namedItem('location').value = event?.location ?? '';
    editor.elements.namedItem('notes').value = event?.notes ?? '';
    editorTitle.setCustomValidity('');
    endField.setCustomValidity('');
    setStatus(editorStatus);
    toggleTimes();
    updateAgenda();
    editorTitle.focus();
  }

  function closeEditor() {
    editor.hidden = true;
    editorEvent = undefined;
    addButton.disabled = false;
    updateAgenda();
    addButton.focus();
  }

  editor.addEventListener('submit', async event => {
    event.preventDefault();
    if (savingEvent) return;
    const title = editorTitle.value.trim();
    if (!title) {
      editorTitle.setCustomValidity(t('calendarTitleRequired'));
      editorTitle.reportValidity();
      return;
    }
    if (!allDayField.checked && endField.value <= startField.value) {
      endField.setCustomValidity(t('calendarTimeOrder'));
      endField.reportValidity();
      return;
    }
    const draft = {
      date: dayKey(editorDay),
      title,
      start: allDayField.checked ? '' : startField.value,
      end: allDayField.checked ? '' : endField.value,
      location: editor.elements.namedItem('location').value.trim(),
      notes: editor.elements.namedItem('notes').value.trim(),
    };
    if (editorEvent) draft.id = editorEvent.id;
    savingEvent = true;
    for (const input of editor.elements) input.disabled = true;
    const saved = await runChange(onSaveEvent, draft);
    savingEvent = false;
    for (const input of editor.elements) input.disabled = false;
    toggleTimes();
    if (saved) closeEditor();
    else setStatus(editorStatus, 'saveFailed');
  });
  editorTitle.addEventListener('input', () => editorTitle.setCustomValidity(''));
  for (const field of [startField, endField]) {
    field.addEventListener('input', () => endField.setCustomValidity(''));
  }
  allDayField.addEventListener('change', () => {
    endField.setCustomValidity('');
    toggleTimes();
  });
  editorCancel.addEventListener('click', closeEditor);
  addButton.addEventListener('click', () => openEditor());

  function movePeriod(step, day = activeDay) {
    if (preferences.view === 'week') return day + step * 7;
    const currentMonth = monthStart(day);
    const destination = step < 0 ? monthStart(currentMonth - 1) : nextMonth(currentMonth);
    return Math.min(destination + day - currentMonth, nextMonth(destination) - 1);
  }

  function showDay(day, { focusDay = false, select = false } = {}) {
    activeDay = day;
    navigation.activeDay = day;
    if (select) {
      selectedDay = day;
      navigation.selectedDay = day;
      deleteCandidate = undefined;
      updateAgenda();
    }
    updateGrid(focusDay);
  }

  todayButton.addEventListener('click', () => showDay(localToday(), { select: true }));
  previousButton.addEventListener('click', () => showDay(movePeriod(-1), { select: true }));
  nextButton.addEventListener('click', () => showDay(movePeriod(1), { select: true }));

  body.addEventListener('click', event => {
    const dayButton = event.target.closest('.calendar-day');
    if (dayButton) showDay(Number(dayButton.dataset.day), { focusDay: true, select: true });
  });

  body.addEventListener('keydown', event => {
    const dayButton = event.target.closest('.calendar-day');
    if (!dayButton || event.altKey || event.ctrlKey || event.metaKey) return;
    const day = Number(dayButton.dataset.day);
    let destination;
    switch (event.key) {
      case 'ArrowLeft': destination = day + (rtl ? 1 : -1); break;
      case 'ArrowRight': destination = day + (rtl ? -1 : 1); break;
      case 'ArrowUp': destination = day - 7; break;
      case 'ArrowDown': destination = day + 7; break;
      case 'Home': destination = day - weekOffset(day); break;
      case 'End': destination = day + 6 - weekOffset(day); break;
      case 'PageUp': destination = movePeriod(-1, day); break;
      case 'PageDown': destination = movePeriod(1, day); break;
      default: return;
    }
    event.preventDefault();
    showDay(destination, { focusDay: true });
  });

  async function changePreferences(patch) {
    if (savingSettings) return;
    const control = document.activeElement;
    savingSettings = true;
    setStatus(settingsStatus);
    updateControls();
    const saved = await runChange(onPreferences, patch);
    savingSettings = false;
    if (saved) update({ preferences: patch });
    else {
      updateControls();
      setStatus(settingsStatus, 'saveFailed');
    }
    if (document.activeElement === document.body) control?.focus();
  }

  for (const button of viewButtons) {
    button.addEventListener('click', () => {
      if (button.dataset.view !== preferences.view) changePreferences({ view: button.dataset.view });
    });
  }
  systemSelect.addEventListener('change', () => changePreferences({ system: systemSelect.value || null }));
  weekSelect.addEventListener('change', () => changePreferences({ firstDay: weekSelect.value === '' ? null : Number(weekSelect.value) }));

  function update({ preferences: nextPreferences, events } = {}) {
    const focusDay = body.contains(document.activeElement);
    if (nextPreferences) {
      Object.assign(preferences, nextPreferences);
      configureDates();
      updateWeekdays();
      if (!editor.hidden) {
        editor.querySelector('.calendar-form-date').textContent = formatDate.format(editorDay * dayLength);
      }
    }
    if (events) setEvents(events);
    updateControls();
    updateGrid(focusDay);
    updateAgenda();
  }

  configureDates();
  updateWeekdays();
  setEvents(initialEvents);
  update();
  renderConnections?.(container.querySelector('.calendar-connections'));
  return { update };
}
