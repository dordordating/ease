import { calendarMonthStart, dayKey, dayLength, localeWeekStart, localToday, weekOffsetFor } from "./calendar-dates.js";

export function createDatePicker({ dateLocale, firstDay, label, t, icon, onChange, onOpen, value: initial = "" }) {
  const localeInfo = new Intl.Locale(dateLocale);
  const rtl = (localeInfo.getTextInfo?.() ?? localeInfo.textInfo)?.direction === "rtl";
  const options = { timeZone: "UTC" };
  const dayNumber = new Intl.DateTimeFormat(dateLocale, { ...options, day: "numeric" });
  const dayStart = new Intl.DateTimeFormat(dateLocale, { ...options, day: "numeric", numberingSystem: "latn" });
  const monthLabel = new Intl.DateTimeFormat(dateLocale, { ...options, month: "long", year: "numeric" });
  const selectedLabel = new Intl.DateTimeFormat(dateLocale, { ...options, dateStyle: "medium" });
  const fullLabel = new Intl.DateTimeFormat(dateLocale, { ...options, dateStyle: "full" });
  const weekdayLabel = new Intl.DateTimeFormat(dateLocale, { ...options, weekday: "short" });
  const weekStart = firstDay ?? localeWeekStart(dateLocale);
  let value = initial;
  let active;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(name, run, { symbol, className = "secondary-button" } = {}) {
    const item = node("button", className);
    item.type = "button";
    if (symbol) {
      item.innerHTML = icon(symbol);
      item.setAttribute("aria-label", name);
      item.title = name;
    } else item.textContent = name;
    item.addEventListener("click", run);
    return item;
  }

  const field = node("div", "field date-picker-field");
  const trigger = button(label, toggle, { className: "secondary-button date-picker-trigger" });
  const face = node("span", "date-picker-value");
  const mark = node("span");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = icon("calendar");
  trigger.replaceChildren(face, mark);
  trigger.setAttribute("aria-expanded", "false");
  field.append(node("span", "", label), trigger);

  const panel = node("div", "date-picker-panel");
  panel.hidden = true;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", label);
  const heading = node("div", "date-picker-heading");
  const month = node("strong");
  month.setAttribute("aria-live", "polite");
  heading.append(
    button(t("datePickerPrevious"), () => moveMonth(-1), { symbol: rtl ? "chevron-right" : "chevron-left", className: "icon-button" }),
    month,
    button(t("datePickerNext"), () => moveMonth(1), { symbol: rtl ? "chevron-left" : "chevron-right", className: "icon-button" })
  );
  const weekdays = node("div", "date-picker-grid date-picker-weekdays");
  const sunday = Date.UTC(2024, 0, 7);
  for (let offset = 0; offset < 7; offset += 1) {
    weekdays.append(node("span", "", weekdayLabel.format(sunday + ((weekStart + offset) % 7) * dayLength)));
  }
  const dates = node("div", "date-picker-grid");
  const actions = node("div", "date-picker-heading");
  const clear = button(t("datePickerClear"), () => select(""));
  actions.append(button(t("todoToday"), () => select(dayKey(localToday()))), clear);
  panel.append(heading, weekdays, dates, actions);

  function setValue(next) {
    value = next;
    const text = value ? selectedLabel.format(Date.parse(value)) : t("datePickerChoose");
    face.textContent = text;
    trigger.setAttribute("aria-label", `${label} · ${text}`);
  }

  function close(restoreFocus = false) {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }

  function toggle() {
    if (!panel.hidden) return close();
    onOpen?.(panel);
    active = value ? Date.parse(value) / dayLength : localToday();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    render(true);
  }

  function select(next) {
    setValue(next);
    close(true);
    onChange?.(value);
  }

  const monthStart = day => calendarMonthStart(dayStart, day);
  const nextMonth = start => monthStart(start + 32);

  function moveMonth(offset, focus = false) {
    const start = monthStart(active);
    const target = offset === 1 ? nextMonth(start) : monthStart(start - 1);
    active = Math.min(target + active - start, nextMonth(target) - 1);
    render(focus);
  }

  function render(focus) {
    const start = monthStart(active);
    const end = nextMonth(start);
    const today = localToday();
    month.textContent = monthLabel.format(start * dayLength);
    dates.replaceChildren();
    for (let index = 0; index < weekOffsetFor(start, weekStart); index += 1) dates.append(node("span"));
    for (let day = start; day < end; day += 1) {
      const iso = dayKey(day);
      const item = button(dayNumber.format(day * dayLength), () => select(iso), { className: "date-picker-day" });
      item.dataset.date = iso;
      item.setAttribute("aria-label", fullLabel.format(day * dayLength));
      item.setAttribute("aria-pressed", String(iso === value));
      if (day === today) item.setAttribute("aria-current", "date");
      item.tabIndex = day === active ? 0 : -1;
      dates.append(item);
    }
    clear.disabled = !value;
    if (focus) dates.querySelector('[tabindex="0"]')?.focus();
  }

  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!event.target.matches(".date-picker-day")) return;
    const weekOffset = weekOffsetFor(active, weekStart);
    const moves = { ArrowUp: -7, ArrowDown: 7, ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1, Home: -weekOffset, End: 6 - weekOffset };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault();
      active += moves[event.key];
      render(true);
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      moveMonth(event.key === "PageDown" ? 1 : -1, true);
    }
  });

  setValue(value);
  return { field, panel, close, setValue, get value() { return value; } };
}
