const dayLength = 86_400_000;

function localToday() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / dayLength;
}

export function renderCalendar(container, { locale, t, icon }) {
  const localeInfo = new Intl.Locale(locale);
  const firstDayOfWeek = (localeInfo.getWeekInfo?.() ?? localeInfo.weekInfo)?.firstDay ?? 1;
  const rtl = (localeInfo.getTextInfo?.() ?? localeInfo.textInfo)?.direction === 'rtl';
  const dateOptions = {
    timeZone: 'UTC',
    calendar: localeInfo.language === 'fa' ? 'persian' : 'gregory',
  };
  const formatMonth = new Intl.DateTimeFormat(locale, { ...dateOptions, month: 'long', year: 'numeric' });
  const formatDay = new Intl.DateTimeFormat(locale, { ...dateOptions, day: 'numeric' });
  const formatDate = new Intl.DateTimeFormat(locale, { ...dateOptions, dateStyle: 'full' });
  const monthDayNumber = new Intl.DateTimeFormat(locale, { ...dateOptions, day: 'numeric', numberingSystem: 'latn' });
  const shortWeekday = new Intl.DateTimeFormat(locale, { ...dateOptions, weekday: 'short' });
  const longWeekday = new Intl.DateTimeFormat(locale, { ...dateOptions, weekday: 'long' });

  function monthStart(day) {
    const dayPart = monthDayNumber.formatToParts(day * dayLength).find(part => part.type === 'day');
    return day - Number(dayPart.value) + 1;
  }

  function weekOffset(day) {
    return (new Date(day * dayLength).getUTCDay() - firstDayOfWeek + 7) % 7;
  }

  function nextMonth(start) {
    return monthStart(start + 32);
  }

  let selectedDay = localToday();
  let activeDay = selectedDay;
  let visibleMonth = monthStart(activeDay);

  container.innerHTML = `
    <div class="calendar">
      <div class="calendar-toolbar">
        <h3 class="calendar-month" id="calendar-month-heading" aria-live="polite"></h3>
        <button type="button" class="calendar-today"></button>
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
        <span class="calendar-summary-label"></span>
        <span class="calendar-summary-date" aria-live="polite"></span>
      </p>
    </div>
  `;

  const heading = container.querySelector('.calendar-month');
  const todayButton = container.querySelector('.calendar-today');
  const previousButton = container.querySelector('[data-month-step="-1"]');
  const nextButton = container.querySelector('[data-month-step="1"]');
  const grid = container.querySelector('.calendar-grid');
  const body = grid.tBodies[0];
  const selectedDate = container.querySelector('.calendar-summary-date');

  todayButton.textContent = t('today');
  previousButton.setAttribute('aria-label', t('previousMonth'));
  nextButton.setAttribute('aria-label', t('nextMonth'));
  previousButton.innerHTML = icon(rtl ? 'chevron-right' : 'chevron-left');
  nextButton.innerHTML = icon(rtl ? 'chevron-left' : 'chevron-right');
  container.querySelector('.calendar-summary-label').textContent = t('calendarSelected');

  for (let offset = 0; offset < 7; offset += 1) {
    // The first day of the Unix epoch was Thursday.
    const weekday = (firstDayOfWeek + offset - 4 + 7) % 7 * dayLength;
    const cell = document.createElement('th');
    cell.className = 'calendar-weekday';
    cell.scope = 'col';
    cell.setAttribute('aria-label', longWeekday.format(weekday));
    cell.textContent = shortWeekday.format(weekday);
    grid.tHead.rows[0].append(cell);
  }

  function updateView(focusDay = false) {
    const today = localToday();
    const start = visibleMonth - weekOffset(visibleMonth);
    const end = nextMonth(visibleMonth);
    const monthLabel = formatMonth.format(visibleMonth * dayLength);
    const dateLabel = formatDate.format(selectedDay * dayLength);
    if (heading.textContent !== monthLabel) heading.textContent = monthLabel;
    if (selectedDate.textContent !== dateLabel) selectedDate.textContent = dateLabel;

    body.replaceChildren();
    for (let week = start; week < end; week += 7) {
      const row = body.insertRow();
      for (let offset = 0; offset < 7; offset += 1) {
        const day = week + offset;
        const cell = row.insertCell();
        cell.className = 'calendar-cell';
        if (day < visibleMonth || day >= end) continue;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-day';
        button.dataset.day = day;
        button.tabIndex = day === activeDay ? 0 : -1;
        button.textContent = formatDay.format(day * dayLength);
        button.setAttribute('aria-label', formatDate.format(day * dayLength));
        button.classList.toggle('is-selected', day === selectedDay);
        button.classList.toggle('is-today', day === today);
        cell.setAttribute('aria-selected', String(day === selectedDay));
        if (day === today) button.setAttribute('aria-current', 'date');
        cell.append(button);
      }
    }

    if (focusDay) body.querySelector(`[data-day="${activeDay}"]`).focus();
  }

  function moveMonth(step) {
    const currentMonth = monthStart(activeDay);
    const destination = step < 0 ? monthStart(currentMonth - 1) : nextMonth(currentMonth);
    return Math.min(destination + activeDay - currentMonth, nextMonth(destination) - 1);
  }

  function showDay(day, focusDay = false) {
    activeDay = day;
    visibleMonth = monthStart(day);
    updateView(focusDay);
  }

  todayButton.addEventListener('click', () => {
    selectedDay = localToday();
    showDay(selectedDay);
  });
  previousButton.addEventListener('click', () => showDay(moveMonth(-1)));
  nextButton.addEventListener('click', () => showDay(moveMonth(1)));

  body.addEventListener('click', event => {
    const dayButton = event.target.closest('.calendar-day');
    if (!dayButton) return;
    selectedDay = Number(dayButton.dataset.day);
    showDay(selectedDay, true);
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
      case 'PageUp': destination = moveMonth(-1); break;
      case 'PageDown': destination = moveMonth(1); break;
      default: return;
    }

    event.preventDefault();
    showDay(destination, true);
  });

  updateView();
}
