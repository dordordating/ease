import { calendarReminderOffsets, calendarReminderSchedule } from './calendar-store.js';
import { calendarSystemFor, defaultCalendar } from './workspace-data.js';
import { mailMessageLink } from './mail-api.js';

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
  holidays: initialHolidays = [],
  navigation = {},
  settingsButton,
  onPreferences,
  onHoliday,
  onSaveEvent,
  onDeleteEvent,
  renderConnections,
}) {
  const localeInfo = new Intl.Locale(locale);
  const localeWeekStart = ((localeInfo.getWeekInfo?.() ?? localeInfo.weekInfo)?.firstDay ?? 1) % 7;
  const direction = (localeInfo.getTextInfo?.() ?? localeInfo.textInfo)?.direction;
  const rtl = (direction ?? container.closest('[dir]')?.dir) === 'rtl';
  const preferences = { ...defaultCalendar, ...initialPreferences };
  const formatTime = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', timeStyle: 'short' });
  const formatCount = new Intl.NumberFormat(locale);
  const formatMarkerCount = new Intl.NumberFormat(locale, { useGrouping: false });
  let formatMonth;
  let formatWeek;
  let formatDay;
  let formatWeekDay;
  let formatDate;
  let monthDayNumber;
  let eventsByDate;
  let holidays = new Set(initialHolidays);
  let selectedDay = navigation.selectedDay ?? localToday();
  let activeDay = navigation.activeDay ?? selectedDay;
  let editorEvent;
  let editorDay;
  let followUp;
  let detailEvent;
  let eventOrigin;
  let showingSettings = false;
  let confirmingDelete = false;
  let savingSettings = false;
  let savingHoliday = false;
  let savingEvent = false;
  let deletingEvent = false;
  let endMode = 'auto';

  function configureDates() {
    const options = {
      timeZone: 'UTC',
      calendar: calendarSystemFor(locale, preferences.system),
    };
    formatMonth = new Intl.DateTimeFormat(locale, { ...options, month: 'long', year: 'numeric' });
    formatWeek = new Intl.DateTimeFormat(locale, { ...options, month: 'short', day: 'numeric', year: 'numeric' });
    formatDay = new Intl.DateTimeFormat(locale, { ...options, day: 'numeric' });
    formatWeekDay = new Intl.DateTimeFormat(locale, { ...options, weekday: 'long', month: 'short', day: 'numeric' });
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
      dayEvents.sort((a, b) => (a.start || a.end || '').localeCompare(b.start || b.end || '')
        || (a.title ?? '').localeCompare(b.title ?? '', locale));
    }
  }

  container.innerHTML = `
    <section class="calendar calendar-settings-view" id="calendar-settings-view" aria-labelledby="calendar-settings-heading" hidden>
      <h2 id="calendar-settings-heading" data-label="calendarSettings"></h2>
      <div class="calendar-options">
        <div class="calendar-view-switch">
          <button type="button" class="calendar-view-button" data-view="month" data-label="calendarMonthView"></button>
          <button type="button" class="calendar-view-button" data-view="week" data-label="calendarWeekView"></button>
        </div>
      </div>
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
        <label><span data-label="calendarEventDisplay"></span>
          <select class="calendar-select" data-calendar-event-display>
            <option value="dots" data-label="calendarEventDots"></option>
            <option value="count" data-label="calendarEventCountMode"></option>
            <option value="titles" data-label="calendarEventTitles"></option>
            <option value="cards" data-label="calendarEventCards"></option>
          </select>
        </label>
      </div>
      <p class="calendar-form-status" data-calendar-settings-status role="status" hidden></p>
      <div class="calendar-connections"></div>
    </section>
    <div class="calendar calendar-main">
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
      <div class="calendar-week-list" role="list" aria-labelledby="calendar-month-heading" hidden></div>
      <div class="calendar-summary">
        <div class="calendar-summary-copy">
          <span class="calendar-summary-label" data-label="calendarSelected"></span>
          <span class="calendar-summary-date" aria-live="polite"></span>
          <span class="calendar-summary-holiday" data-label="calendarHoliday" hidden></span>
        </div>
        <button type="button" class="calendar-holiday-toggle"></button>
        <p class="calendar-form-status" data-calendar-holiday-status role="status" hidden></p>
      </div>
      <section class="calendar-agenda" aria-labelledby="calendar-agenda-heading">
        <div class="calendar-agenda-header">
          <h4 id="calendar-agenda-heading" data-label="calendarEvents"></h4>
          <button type="button" class="calendar-add-event">${icon('plus')}<span data-label="calendarAddEvent"></span></button>
        </div>
        <form class="calendar-event-form" hidden>
          <h5 class="calendar-form-title"></h5>
          <p class="calendar-form-date"></p>
          <p class="calendar-form-date calendar-follow-up-hint" data-label="mailChooseDay" hidden></p>
          <label class="calendar-field">
            <span data-label="calendarEventTitle"></span>
            <input name="title" type="text" maxlength="160" dir="auto" required>
          </label>
          <div class="calendar-time-fields" id="calendar-time-fields">
            <label class="calendar-field">
              <span data-label="calendarStarts"></span>
              <input name="start" type="time">
            </label>
            <div class="calendar-end-fields" hidden>
              <label class="calendar-field">
                <span data-label="calendarEnds"></span>
                <input name="end" type="time">
              </label>
              <button type="button" class="icon-button calendar-remove-end">${icon('close')}</button>
              <label class="calendar-end-next-day">
                <input name="endNextDay" type="checkbox">
                <span data-label="calendarEndNextDay"></span>
              </label>
            </div>
            <button type="button" class="secondary-button calendar-add-end" hidden>${icon('plus')}<span data-label="calendarAddEnd"></span></button>
          </div>
          <label class="calendar-field calendar-reminder-field" hidden>
            <span data-label="calendarReminder"></span>
            <select name="reminder" class="calendar-select"></select>
          </label>
          <p class="calendar-form-status calendar-reminder-status" role="status" hidden></p>
          <label class="calendar-field">
            <span data-label="calendarLocation"></span>
            <input name="location" type="text" maxlength="240" dir="auto">
          </label>
          <label class="calendar-field">
            <span data-label="calendarNotes"></span>
            <textarea name="notes" rows="2" maxlength="2000" dir="auto"></textarea>
          </label>
          <a class="calendar-mail-link" target="_blank" rel="noopener noreferrer" data-label="mailOpenMessage" hidden></a>
          <p class="calendar-form-status" role="status" hidden></p>
          <div class="calendar-form-actions">
            <button type="submit" class="primary-button" data-label="save"></button>
            <button type="button" class="secondary-button" data-calendar-cancel data-label="cancel"></button>
          </div>
        </form>
        <div class="calendar-events"></div>
      </section>
      <div class="calendar-month-cards" hidden></div>
    </div>
    <section class="calendar calendar-event-detail" aria-labelledby="calendar-detail-title" hidden>
      <div class="calendar-detail-heading">
        <button type="button" class="calendar-detail-back">${icon(rtl ? 'chevron-right' : 'chevron-left')}<span data-label="calendarBack"></span></button>
        <h3 data-label="calendarEventDetails"></h3>
      </div>
      <h4 class="calendar-detail-title" id="calendar-detail-title" dir="auto"></h4>
      <dl class="calendar-detail-fields"></dl>
      <div class="calendar-detail-actions">
        <button type="button" class="secondary-button calendar-detail-edit">${icon('edit')}<span data-label="edit"></span></button>
        <button type="button" class="secondary-button calendar-detail-delete">${icon('trash')}<span data-label="remove"></span></button>
      </div>
      <div class="calendar-event-confirm" hidden>
        <p class="calendar-confirm-message"></p>
        <p class="calendar-form-status" role="status" hidden></p>
        <div class="calendar-form-actions">
          <button type="button" class="secondary-button" data-calendar-delete-cancel data-label="cancel"></button>
          <button type="button" class="secondary-button" data-calendar-delete-confirm data-label="remove"></button>
        </div>
      </div>
    </section>
  `;

  const heading = container.querySelector('.calendar-month');
  const todayButton = container.querySelector('.calendar-today');
  const previousButton = container.querySelector('[data-month-step="-1"]');
  const nextButton = container.querySelector('[data-month-step="1"]');
  const viewButtons = Array.from(container.querySelectorAll('.calendar-view-button'));
  const systemSelect = container.querySelector('[data-calendar-system]');
  const weekSelect = container.querySelector('[data-calendar-week-start]');
  const eventDisplaySelect = container.querySelector('[data-calendar-event-display]');
  const settingsStatus = container.querySelector('[data-calendar-settings-status]');
  const grid = container.querySelector('.calendar-grid');
  const body = grid.tBodies[0];
  const weekList = container.querySelector('.calendar-week-list');
  const monthCards = container.querySelector('.calendar-month-cards');
  const selectedDate = container.querySelector('.calendar-summary-date');
  const holidayBadge = container.querySelector('.calendar-summary-holiday');
  const holidayButton = container.querySelector('.calendar-holiday-toggle');
  const holidayStatus = container.querySelector('[data-calendar-holiday-status]');
  const addButton = container.querySelector('.calendar-add-event');
  const agenda = container.querySelector('.calendar-events');
  const editor = container.querySelector('.calendar-event-form');
  const editorTitle = editor.elements.namedItem('title');
  const editorDate = editor.querySelector('.calendar-form-date');
  const editorMail = editor.querySelector('.calendar-mail-link');
  const followUpHint = editor.querySelector('.calendar-follow-up-hint');
  const endFields = editor.querySelector('.calendar-end-fields');
  const endNextDayLabel = editor.querySelector('.calendar-end-next-day');
  const removeEnd = editor.querySelector('.calendar-remove-end');
  const addEnd = editor.querySelector('.calendar-add-end');
  const startField = editor.elements.namedItem('start');
  const endField = editor.elements.namedItem('end');
  const endNextDay = editor.elements.namedItem('endNextDay');
  const reminderField = editor.querySelector('.calendar-reminder-field');
  const reminder = editor.elements.namedItem('reminder');
  const reminderStatus = editor.querySelector('.calendar-reminder-status');
  const editorStatus = editor.querySelector('.calendar-form-status');
  const editorCancel = editor.querySelector('[data-calendar-cancel]');
  const detailView = container.querySelector('.calendar-event-detail');
  const detailTitle = detailView.querySelector('.calendar-detail-title');
  const detailFields = detailView.querySelector('.calendar-detail-fields');
  const detailBack = detailView.querySelector('.calendar-detail-back');
  const detailActions = detailView.querySelector('.calendar-detail-actions');
  const detailEdit = detailView.querySelector('.calendar-detail-edit');
  const detailDelete = detailView.querySelector('.calendar-detail-delete');
  const deletePrompt = detailView.querySelector('.calendar-event-confirm');
  const deleteCancelButton = deletePrompt.querySelector('[data-calendar-delete-cancel]');
  const deleteConfirmButton = deletePrompt.querySelector('[data-calendar-delete-confirm]');
  const deleteStatus = deletePrompt.querySelector('.calendar-form-status');

  for (const label of container.querySelectorAll('[data-label]')) label.textContent = t(label.dataset.label);
  removeEnd.setAttribute('aria-label', t('calendarRemoveEnd'));
  removeEnd.title = t('calendarRemoveEnd');
  reminder.add(new Option(t('calendarNoReminder'), ''));
  for (const offset of calendarReminderOffsets) reminder.add(new Option(reminderLabel(offset), String(offset)));
  holidayButton.hidden = !onHoliday;
  const settingsView = container.querySelector('.calendar-settings-view');
  const calendarView = container.querySelector('.calendar-main');
  settingsButton?.setAttribute('aria-controls', settingsView.id);
  settingsButton?.setAttribute('aria-expanded', 'false');
  settingsButton?.addEventListener('click', () => {
    showingSettings = !showingSettings;
    updateViews();
    const workspace = container.closest('.workspace');
    if (workspace) workspace.scrollTop = 0;
  });
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

  function eventDisplayMode() {
    const { eventDisplay } = preferences;
    return ['dots', 'count', 'titles', 'cards'].includes(eventDisplay) ? eventDisplay : defaultCalendar.eventDisplay;
  }

  function updateControls() {
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.view === preferences.view));
      button.disabled = savingSettings;
    }
    systemSelect.value = preferences.system ?? '';
    weekSelect.value = preferences.firstDay ?? '';
    eventDisplaySelect.value = eventDisplayMode();
    systemSelect.disabled = savingSettings;
    weekSelect.disabled = savingSettings;
    eventDisplaySelect.disabled = savingSettings;
  }

  function updateHolidaySummary() {
    const marked = holidays.has(dayKey(selectedDay));
    holidayBadge.hidden = !marked;
    holidayButton.disabled = savingHoliday;
    holidayButton.textContent = t(marked ? 'calendarUnmarkHoliday' : 'calendarMarkHoliday');
  }

  function makeEventButton(event, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.event = event.id;
    button.disabled = !editor.hidden;
    button.addEventListener('click', () => openDetails(event, button));
    return button;
  }

  function eventTitle(event) {
    return event.title || t('calendarUntitledEvent');
  }

  function eventSource(event) {
    if (event.provider === 'google') return t('googleCalendar');
    if (event.provider === 'apple') return t('appleCalendar');
    return t('localWorkspace');
  }

  function eventItem(event, card) {
    const button = makeEventButton(event, card
      ? 'calendar-event-card'
      : 'calendar-event calendar-event-content');
    appendText(button, 'span', 'calendar-event-title', eventTitle(event));
    appendText(button, 'span', 'calendar-event-time', eventTime(event));
    if (event.notes?.trim()) appendText(button, 'span', 'calendar-event-notes', event.notes);
    if (event.readOnly) appendText(button, 'span', 'calendar-event-provider', eventSource(event));
    return button;
  }

  function titleMarkers(dayEvents, limit) {
    const markers = document.createElement('span');
    markers.className = 'calendar-event-markers';
    for (const event of dayEvents.slice(0, limit)) {
      const chip = makeEventButton(event, 'calendar-event-chip');
      chip.dir = 'auto';
      chip.textContent = eventTitle(event);
      chip.title = chip.textContent;
      markers.append(chip);
    }
    if (dayEvents.length > limit) {
      const count = formatMarkerCount.format(dayEvents.length - limit);
      appendText(markers, 'span', 'calendar-event-marker-more', t('calendarEventMore', { count }));
      markers.lastElementChild.dir = 'ltr';
    }
    return markers;
  }

  function makeDayButton(day, today, dayEvents, mode, weekly) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    button.dataset.day = day;
    button.tabIndex = day === activeDay ? 0 : -1;
    if (weekly) button.classList.add('calendar-week-day-button');
    appendText(button, 'span', 'calendar-day-number', formatDay.format(day * dayLength));
    if (weekly) appendText(button, 'span', 'calendar-week-day-label', longWeekday.format(day * dayLength));

    const label = [formatDate.format(day * dayLength)];
    if (dayEvents.length) {
      button.classList.add('has-events');
      button.dataset.eventDisplay = mode;
      label.push(t('calendarEventCount', { count: formatCount.format(dayEvents.length) }));
      if (mode === 'dots' || mode === 'count' || (!weekly && mode === 'cards')) {
        const markers = document.createElement('span');
        markers.className = 'calendar-event-markers';
        markers.setAttribute('aria-hidden', 'true');
        if (mode === 'count') {
          appendText(markers, 'span', 'calendar-event-marker-count', formatMarkerCount.format(dayEvents.length));
        } else {
          appendText(markers, 'span', 'calendar-event-dot', '');
        }
        button.append(markers);
      }
    }
    const holiday = holidays.has(dayKey(day));
    if (holiday) label.push(t('calendarHoliday'));
    button.setAttribute('aria-label', label.join(', '));
    button.classList.toggle('is-holiday', holiday);
    button.classList.toggle('is-selected', day === selectedDay);
    button.classList.toggle('is-today', day === today);
    if (weekly) button.setAttribute('aria-pressed', String(day === selectedDay));
    if (day === today) button.setAttribute('aria-current', 'date');
    return button;
  }

  function renderMonth(start, firstDate, end, today, mode) {
    body.replaceChildren();
    for (let week = start; week < end; week += 7) {
      const row = body.insertRow();
      for (let offset = 0; offset < 7; offset += 1) {
        const day = week + offset;
        const cell = row.insertCell();
        cell.className = 'calendar-cell';
        if (day < firstDate || day >= end) continue;

        const dayEvents = eventsByDate.get(dayKey(day)) ?? [];
        const button = makeDayButton(day, today, dayEvents, mode, false);
        cell.setAttribute('aria-selected', String(day === selectedDay));
        if (mode === 'titles' && dayEvents.length) {
          const block = document.createElement('div');
          block.className = 'calendar-day-titles';
          block.append(button, titleMarkers(dayEvents, 1));
          cell.append(block);
        } else {
          cell.append(button);
        }
      }
    }
  }

  function renderWeek(start, end, today, mode) {
    weekList.replaceChildren();
    for (let day = start; day < end; day += 1) {
      const dayEvents = eventsByDate.get(dayKey(day)) ?? [];
      const section = document.createElement('div');
      section.className = 'calendar-week-day';
      section.setAttribute('role', 'listitem');
      section.append(makeDayButton(day, today, dayEvents, mode, true));
      const showCards = mode === 'cards' && day >= selectedDay;
      if (dayEvents.length && (showCards || mode === 'titles')) {
        const events = document.createElement('div');
        events.className = 'calendar-week-events';
        if (showCards) events.append(...dayEvents.map(event => eventItem(event, true)));
        else events.append(titleMarkers(dayEvents, 2));
        section.append(events);
      }
      weekList.append(section);
    }
  }

  function renderMonthCards(firstDate, end) {
    monthCards.replaceChildren();
    for (let day = Math.max(firstDate, selectedDay); day < end; day += 1) {
      const dayEvents = eventsByDate.get(dayKey(day));
      if (!dayEvents?.length) continue;
      const group = document.createElement('section');
      group.className = 'calendar-card-group';
      appendText(group, 'h4', 'calendar-card-group-label', formatWeekDay.format(day * dayLength));
      group.append(...dayEvents.map(event => eventItem(event, true)));
      monthCards.append(group);
    }
  }

  function updateGrid(focusDay = false) {
    const today = localToday();
    const weekly = preferences.view === 'week';
    const mode = eventDisplayMode();
    const firstDate = weekly ? activeDay - weekOffset(activeDay) : monthStart(activeDay);
    const start = firstDate - weekOffset(firstDate);
    const end = weekly ? start + 7 : nextMonth(firstDate);
    const periodLabel = weekly
      ? formatWeek.formatRange(start * dayLength, (end - 1) * dayLength)
      : formatMonth.format(firstDate * dayLength);
    const dateLabel = formatDate.format(selectedDay * dayLength);
    if (heading.textContent !== periodLabel) heading.textContent = periodLabel;
    if (selectedDate.textContent !== dateLabel) selectedDate.textContent = dateLabel;
    updateHolidaySummary();
    previousButton.setAttribute('aria-label', t(weekly ? 'previousWeek' : 'previousMonth'));
    nextButton.setAttribute('aria-label', t(weekly ? 'nextWeek' : 'nextMonth'));

    calendarView.classList.toggle('is-week', weekly);
    calendarView.dataset.eventDisplay = mode;
    grid.hidden = weekly;
    weekList.hidden = !weekly;
    monthCards.hidden = weekly || mode !== 'cards';
    if (weekly) {
      body.replaceChildren();
      renderWeek(start, end, today, mode);
    } else {
      weekList.replaceChildren();
      renderMonth(start, firstDate, end, today, mode);
    }
    if (monthCards.hidden) monthCards.replaceChildren();
    else renderMonthCards(firstDate, end);
    if (focusDay) calendarView.querySelector(`[data-day="${activeDay}"]`)?.focus();
  }

  function updateAgenda() {
    const dayEvents = eventsByDate.get(dayKey(selectedDay)) ?? [];
    const cardMode = eventDisplayMode() === 'cards';
    agenda.replaceChildren();
    if (cardMode) return;
    if (!dayEvents.length) {
      if (editor.hidden) appendText(agenda, 'p', 'calendar-empty', t('calendarNoEvents'));
      return;
    }
    agenda.append(...dayEvents.map(event => eventItem(event, false)));
  }

  function eventTime(event) {
    if (!event.start) {
      return event.end ? `${t('calendarEnds')} ${formatTime.format(timeValue(event.end))}` : t('calendarAllDay');
    }
    const start = timeValue(event.start);
    if (!event.end) return formatTime.format(start);
    const end = timeValue(event.end);
    if (event.endNextDay) return `${formatTime.format(start)} – ${formatTime.format(end)} · ${t('calendarEndNextDay')}`;
    if (start <= end) return formatTime.formatRange(start, end);
    return `${formatTime.format(start)} – ${formatTime.format(end)}`;
  }

  function reminderLabel(minutes) {
    if (minutes === 0) return t('calendarReminderAtStart');
    if (minutes === 60) return t('calendarReminderHour');
    if (minutes === 1440) return t('calendarReminderDay');
    return t('calendarReminderMinutes', { count: formatCount.format(minutes) });
  }

  function appendText(parent, tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.dir = 'auto';
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function setStatus(element, message) {
    element.textContent = message ? t(message) : '';
    element.hidden = !message;
  }

  async function runChange(callback, ...args) {
    try {
      return await callback?.(...args);
    } catch {
      return false;
    }
  }

  function updateViews() {
    const showingDetails = Boolean(detailEvent) && editor.hidden && !showingSettings;
    settingsView.hidden = !showingSettings;
    detailView.hidden = !showingDetails;
    calendarView.hidden = showingSettings || showingDetails;
    if (settingsButton) {
      const label = t(showingSettings ? 'close' : 'calendarSettings');
      settingsButton.setAttribute('aria-expanded', String(showingSettings));
      settingsButton.setAttribute('aria-label', label);
      settingsButton.title = label;
    }
  }

  function findEvent(id) {
    for (const events of eventsByDate.values()) {
      const event = events.find(item => item.id === id);
      if (event) return event;
    }
  }

  function buttonOrigin(button) {
    return button && [body, weekList, agenda, monthCards].find(list => list.contains(button));
  }

  function eventButtonIn(origin, id) {
    return Array.from(origin?.querySelectorAll('button[data-event]') ?? []).find(button => button.dataset.event === id);
  }

  function openDetails(event, opener) {
    if (!editor.hidden || deletingEvent) return false;
    eventOrigin = buttonOrigin(opener);
    detailEvent = event;
    confirmingDelete = false;
    showingSettings = false;
    setStatus(deleteStatus);
    showDay(Date.parse(event.date) / dayLength, { select: true });
    renderDetail();
    updateViews();
    const workspace = container.closest('.workspace');
    if (workspace) workspace.scrollTop = 0;
    detailBack.focus();
    return true;
  }

  function openEvent(id) {
    const event = findEvent(id);
    return event ? openDetails(event) : false;
  }

  function closeDetails(restoreFocus = true) {
    const id = detailEvent?.id;
    detailEvent = undefined;
    confirmingDelete = false;
    updateViews();
    if (restoreFocus) (eventButtonIn(eventOrigin, id) ?? addButton).focus();
    eventOrigin = undefined;
  }

  function renderDetail() {
    if (!detailEvent) return;
    detailTitle.textContent = eventTitle(detailEvent);
    detailFields.replaceChildren();
    const fields = [
      ['calendarEventDate', formatDate.format(Date.parse(detailEvent.date))],
      ['calendarStarts', detailEvent.start && formatTime.format(timeValue(detailEvent.start))],
      ['calendarEnds', detailEvent.end && (detailEvent.endNextDay
        ? `${formatDate.format(Date.parse(detailEvent.date) + dayLength)}, ${formatTime.format(timeValue(detailEvent.end))}`
        : formatTime.format(timeValue(detailEvent.end)))],
      ['calendarReminder', detailEvent.start && calendarReminderOffsets.includes(detailEvent.reminderMinutes)
        && reminderLabel(detailEvent.reminderMinutes)],
      ['calendarLocation', detailEvent.location],
      ['calendarNotes', detailEvent.notes],
      ['calendar', eventSource(detailEvent)],
    ];
    for (const [key, value] of fields) {
      if (!value) continue;
      appendText(detailFields, 'dt', '', t(key));
      appendText(detailFields, 'dd', '', value);
    }
    const mailUrl = mailMessageLink(null, detailEvent.mailUrl);
    if (mailUrl) {
      appendText(detailFields, 'dt', '', t('mail'));
      const row = appendText(detailFields, 'dd', '', '');
      const link = appendText(row, 'a', 'calendar-mail-link', t('mailOpenMessage'));
      link.href = mailUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }

    detailActions.hidden = Boolean(detailEvent.readOnly) || confirmingDelete;
    deletePrompt.hidden = !confirmingDelete;
    deletePrompt.querySelector('.calendar-confirm-message').textContent = t('calendarConfirmDelete', {
      title: eventTitle(detailEvent),
    });
    detailBack.disabled = deletingEvent;
    deleteCancelButton.disabled = deletingEvent;
    deleteConfirmButton.disabled = deletingEvent;
  }

  function cancelDelete() {
    confirmingDelete = false;
    setStatus(deleteStatus);
    renderDetail();
    detailDelete.focus();
  }

  detailBack.addEventListener('click', () => closeDetails());
  detailEdit.addEventListener('click', () => openEditor(detailEvent));
  detailDelete.addEventListener('click', () => {
    confirmingDelete = true;
    renderDetail();
    deleteCancelButton.focus();
  });
  deleteCancelButton.addEventListener('click', cancelDelete);
  deleteConfirmButton.addEventListener('click', async () => {
    if (!detailEvent || deletingEvent) return;
    const { id, date } = detailEvent;
    deletingEvent = true;
    setStatus(deleteStatus);
    renderDetail();
    const deleted = await runChange(onDeleteEvent, id);
    deletingEvent = false;
    if (deleted) {
      const dayEvents = eventsByDate.get(date) ?? [];
      eventsByDate.set(date, dayEvents.filter(event => event.id !== id));
      closeDetails(false);
      updateGrid();
      updateAgenda();
      addButton.focus();
    } else {
      renderDetail();
      setStatus(deleteStatus, 'deleteFailed');
      deleteConfirmButton.focus();
    }
  });
  detailView.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || deletingEvent) return;
    event.preventDefault();
    if (confirmingDelete) cancelDelete();
    else closeDetails();
  });

  function fillDefaultEnd() {
    const end = timeValue(startField.value) + 3_600_000;
    endField.value = new Date(end).toISOString().slice(11, 16);
    endNextDay.checked = end >= dayLength;
  }

  function reminderMinutes() {
    return startField.value && reminder.value !== '' ? Number(reminder.value) : null;
  }

  function showTimingFields() {
    const hasStart = Boolean(startField.value);
    const showEnd = endMode === 'manual' || (endMode === 'auto' && hasStart);
    endFields.hidden = !showEnd;
    endNextDayLabel.hidden = !hasStart;
    addEnd.hidden = !hasStart || showEnd;
    reminderField.hidden = !hasStart;
    endField.disabled = !showEnd || savingEvent;
    endNextDay.disabled = !showEnd || !hasStart || savingEvent;
    reminder.disabled = !hasStart || savingEvent;
  }

  function showReminderStatus() {
    const schedule = calendarReminderSchedule({
      date: dayKey(editorDay), start: startField.value, reminderMinutes: reminderMinutes(),
    });
    setStatus(reminderStatus, schedule?.reminderAt <= Date.now() ? 'calendarReminderPast' : undefined);
  }

  async function requestReminderPermission() {
    try {
      if (chrome.permissions?.request && !await chrome.permissions.request({ permissions: ['notifications'] })) {
        return 'calendarReminderPermission';
      }
      if (typeof chrome.notifications?.create !== 'function') return 'calendarReminderUnavailable';
      if (chrome.notifications.getPermissionLevel && await chrome.notifications.getPermissionLevel() !== 'granted') {
        return 'calendarReminderPermission';
      }
    } catch {
      return 'calendarReminderUnavailable';
    }
  }

  function setEditorBusy(busy) {
    savingEvent = busy;
    for (const input of editor.elements) input.disabled = busy;
    showTimingFields();
  }

  function openEditor(event, seed) {
    if (!editor.hidden) return;
    editorEvent = event;
    followUp = seed;
    editorDay = event ? Date.parse(event.date) / dayLength : selectedDay;
    editor.hidden = false;
    addButton.disabled = true;
    editor.querySelector('.calendar-form-title').textContent = t(event ? 'calendarEditEvent' : 'calendarAddEvent');
    editorDate.textContent = formatDate.format(editorDay * dayLength);
    followUpHint.hidden = !followUp;
    editorTitle.value = event?.title ?? (seed?.title ?? '').slice(0, 160);
    const mailUrl = mailMessageLink(null, event?.mailUrl ?? seed?.mailUrl);
    editorMail.hidden = !mailUrl;
    if (mailUrl) editorMail.href = mailUrl;
    else editorMail.removeAttribute('href');
    startField.value = event?.start ?? '';
    endField.value = event?.end ?? '';
    endNextDay.checked = event?.endNextDay === true;
    endMode = event?.end ? 'manual' : event?.start ? 'omitted' : 'auto';
    reminder.value = calendarReminderOffsets.includes(event?.reminderMinutes) ? String(event.reminderMinutes) : '';
    editor.elements.namedItem('location').value = event?.location ?? '';
    editor.elements.namedItem('notes').value = event?.notes ?? '';
    editorTitle.setCustomValidity('');
    endField.setCustomValidity('');
    setStatus(editorStatus);
    showTimingFields();
    showReminderStatus();
    updateGrid();
    updateAgenda();
    updateViews();
    editorTitle.focus();
  }

  function closeEditor() {
    editor.hidden = true;
    editorEvent = undefined;
    followUp = undefined;
    addButton.disabled = false;
    if (detailEvent) {
      showDay(Date.parse(detailEvent.date) / dayLength, { select: true });
    } else {
      updateGrid();
      updateAgenda();
    }
    updateViews();
    if (detailEvent) {
      renderDetail();
      detailEdit.focus();
    } else {
      addButton.focus();
    }
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
    const start = startField.value;
    const end = endField.value;
    const overnight = Boolean(start && end && endNextDay.checked);
    if (start && end && !overnight && end <= start) {
      endField.setCustomValidity(t('calendarTimeOrder'));
      endField.reportValidity();
      return;
    }
    const draft = {
      date: dayKey(editorDay),
      title,
      start,
      end,
      endNextDay: overnight,
      reminderMinutes: reminderMinutes(),
      location: editor.elements.namedItem('location').value.trim(),
      notes: editor.elements.namedItem('notes').value.trim(),
    };
    if (editorEvent) draft.id = editorEvent.id;
    if (followUp) draft.mailUrl = followUp.mailUrl;
    setEditorBusy(true);
    const schedule = calendarReminderSchedule(draft);
    const permissionIssue = schedule?.reminderAt > Date.now() ? await requestReminderPermission() : undefined;
    if (permissionIssue) {
      setEditorBusy(false);
      setStatus(reminderStatus, permissionIssue);
      reminder.focus();
      return;
    }
    const saved = await runChange(onSaveEvent, draft);
    setEditorBusy(false);
    if (saved) {
      if (draft.id && detailEvent?.id === draft.id) detailEvent = { ...detailEvent, ...draft };
      closeEditor();
    } else {
      setStatus(editorStatus, 'saveFailed');
    }
  });
  editorTitle.addEventListener('input', () => editorTitle.setCustomValidity(''));
  startField.addEventListener('input', () => {
    endField.setCustomValidity('');
    if (startField.value && endMode === 'auto') fillDefaultEnd();
    if (!startField.value) {
      if (endMode === 'auto') endField.value = '';
      endNextDay.checked = false;
      reminder.value = '';
    }
    showTimingFields();
    showReminderStatus();
  });
  endField.addEventListener('input', () => {
    endMode = 'manual';
    endField.setCustomValidity('');
    if (!endField.value) endNextDay.checked = false;
  });
  endNextDay.addEventListener('change', () => {
    endMode = 'manual';
    endField.setCustomValidity('');
  });
  reminder.addEventListener('change', showReminderStatus);
  addEnd.addEventListener('click', () => {
    endMode = 'auto';
    fillDefaultEnd();
    showTimingFields();
    endField.focus();
  });
  removeEnd.addEventListener('click', () => {
    endMode = 'omitted';
    endField.value = '';
    endNextDay.checked = false;
    endField.setCustomValidity('');
    showTimingFields();
    (addEnd.hidden ? startField : addEnd).focus();
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
      setStatus(holidayStatus);
      if (followUp && !savingEvent) {
        editorDay = day;
        editorDate.textContent = formatDate.format(editorDay * dayLength);
        showReminderStatus();
      }
      updateAgenda();
    }
    updateGrid(focusDay);
  }

  todayButton.addEventListener('click', () => showDay(localToday(), { select: true }));
  previousButton.addEventListener('click', () => showDay(movePeriod(-1)));
  nextButton.addEventListener('click', () => showDay(movePeriod(1)));

  holidayButton.addEventListener('click', async () => {
    if (savingHoliday) return;
    const date = dayKey(selectedDay);
    const enabled = !holidays.has(date);
    savingHoliday = true;
    setStatus(holidayStatus);
    updateHolidaySummary();
    const saved = await runChange(onHoliday, date, enabled);
    savingHoliday = false;
    if (saved) {
      if (enabled) holidays.add(date);
      else holidays.delete(date);
      updateGrid(document.activeElement?.matches('.calendar-day'));
    } else {
      updateHolidaySummary();
      setStatus(holidayStatus, 'saveFailed');
    }
    if (document.activeElement === document.body) holidayButton.focus();
  });

  calendarView.addEventListener('click', event => {
    const dayButton = event.target.closest('.calendar-day');
    if (dayButton) showDay(Number(dayButton.dataset.day), { focusDay: true, select: true });
  });

  calendarView.addEventListener('keydown', event => {
    const dayButton = event.target.closest('.calendar-day');
    if (!dayButton || event.altKey || event.ctrlKey || event.metaKey) return;
    const day = Number(dayButton.dataset.day);
    const verticalStep = preferences.view === 'week' ? 1 : 7;
    let destination;
    switch (event.key) {
      case 'ArrowLeft': destination = day + (rtl ? 1 : -1); break;
      case 'ArrowRight': destination = day + (rtl ? -1 : 1); break;
      case 'ArrowUp': destination = day - verticalStep; break;
      case 'ArrowDown': destination = day + verticalStep; break;
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
  eventDisplaySelect.addEventListener('change', () => changePreferences({ eventDisplay: eventDisplaySelect.value }));

  function update({ preferences: nextPreferences, events, holidays: nextHolidays } = {}) {
    const focused = document.activeElement;
    const focusDay = focused?.matches('.calendar-day');
    const focusedEvent = focused?.closest('button[data-event]');
    const focusedOrigin = buttonOrigin(focusedEvent);
    if (nextPreferences) {
      Object.assign(preferences, nextPreferences);
      configureDates();
      updateWeekdays();
      if (!editor.hidden) {
        editor.querySelector('.calendar-form-date').textContent = formatDate.format(editorDay * dayLength);
      }
    }
    if (events) {
      setEvents(events);
      if (detailEvent) {
        const refreshed = findEvent(detailEvent.id);
        if (refreshed) detailEvent = refreshed;
        else if (!deletingEvent && editor.hidden) closeDetails(false);
      }
    }
    if (nextHolidays) holidays = new Set(nextHolidays);
    updateControls();
    updateGrid(focusDay);
    updateAgenda();
    renderDetail();
    if (focusedEvent) eventButtonIn(focusedOrigin, focusedEvent.dataset.event)?.focus();
  }

  configureDates();
  updateWeekdays();
  setEvents(initialEvents);
  update();
  renderConnections?.(container.querySelector('.calendar-connections'));
  return {
    update, openEvent,
    openFollowUp({ title, url }) {
      const mailUrl = mailMessageLink(null, url);
      if (!mailUrl || !editor.hidden) return;
      showDay(localToday(), { select: true });
      openEditor(undefined, { title, mailUrl });
      editor.scrollIntoView({ block: 'nearest' });
    }
  };
}
