import { icon } from "./icons.js";

const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const pad = number => String(number).padStart(2, "0");

function parseTime(text) {
  const digits = text.trim().replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15));
  if (!digits) return "";
  const parts = digits.match(/^(\d{1,2})[:：](\d{2})$/u) ?? digits.match(/^(\d{2})(\d{2})$/u);
  const value = parts && `${pad(parts[1])}:${parts[2]}`;
  return value && validTime.test(value) ? value : null;
}

export function createTimePicker({ locale, t, label, value = "", required = false }) {
  const numbers = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  const format = value => numbers.format(Number(value));
  const element = document.createElement("div");
  element.className = "time-picker";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = 5;
  input.placeholder = "--:--";
  input.required = required;
  input.dir = "ltr";
  input.setAttribute("aria-label", label);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "icon-button time-picker-trigger";
  trigger.innerHTML = icon("clock");
  trigger.setAttribute("aria-label", `${label} · ${t("timePickerOpen")}`);
  trigger.title = t("timePickerOpen");

  const panel = document.createElement("div");
  panel.id = `time-picker-${crypto.randomUUID()}`;
  panel.className = "time-picker-panel";
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", label);
  trigger.setAttribute("popovertarget", panel.id);
  trigger.setAttribute("aria-expanded", "false");

  const columns = document.createElement("div");
  columns.className = "time-picker-columns";
  columns.dir = "ltr";
  const hours = column("timePickerHour", 24, 1, hour => {
    commit(`${hour}:${current.slice(3) || "00"}`);
    focusOption(minutes);
  });
  const minutes = column("timePickerMinute", 60, 5, minute => {
    const hour = current.slice(0, 2) || pad(new Date().getHours());
    commit(`${hour}:${minute}`);
    close();
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "secondary-button time-picker-clear";
  clear.textContent = t("calendarClearTime");
  clear.hidden = required;
  clear.addEventListener("click", () => {
    commit("");
    close();
  });
  panel.append(columns, clear);
  element.append(input, trigger, panel);
  let current = "";
  let externalError = "";

  function column(key, limit, step, select) {
    const container = document.createElement("div");
    container.className = "time-picker-column";
    const name = document.createElement("span");
    name.textContent = t(key);
    const list = document.createElement("div");
    list.className = "time-picker-options";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", t(key));
    const options = new Map();
    for (let number = 0; number < limit; number += step) {
      const key = pad(number);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = format(number);
      button.dataset.timeOption = key;
      button.tabIndex = -1;
      button.addEventListener("click", () => select(key));
      options.set(key, button);
      list.append(button);
    }
    container.append(name, list);
    columns.append(container);
    return { list, options };
  }

  function focusOption(column, button = column.list.querySelector('[tabindex="0"]')) {
    if (!button) return;
    for (const option of column.options.values()) option.tabIndex = option === button ? 0 : -1;
    button.focus({ preventScroll: true });
    const below = button.offsetTop + button.offsetHeight - column.list.clientHeight;
    if (button.offsetTop < column.list.scrollTop) column.list.scrollTop = button.offsetTop;
    else if (below > column.list.scrollTop) column.list.scrollTop = below;
  }

  function mark(column, selected, fallback) {
    const active = column.options.get(selected) ?? column.options.get(fallback);
    for (const [value, button] of column.options) {
      button.setAttribute("aria-pressed", String(value === selected));
      button.tabIndex = button === active ? 0 : -1;
    }
  }

  function refreshOptions() {
    mark(hours, current.slice(0, 2), pad(new Date().getHours()));
    mark(minutes, current.slice(3), "00");
    clear.disabled = !current;
  }

  function validate() {
    input.setCustomValidity(externalError || (parseTime(input.value) === null ? t("timePickerInvalid") : ""));
  }

  function setValue(value) {
    current = validTime.test(value) ? value : "";
    input.value = current ? current.split(":").map(format).join(":") : "";
    validate();
    if (panel.matches(":popover-open")) refreshOptions();
  }

  function commit(value) {
    setValue(value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function close() {
    if (panel.matches(":popover-open")) panel.hidePopover();
    input.focus({ preventScroll: true });
  }

  input.addEventListener("input", event => {
    const next = parseTime(input.value);
    if (next === null) event.stopPropagation();
    else {
      current = next;
      if (panel.matches(":popover-open")) refreshOptions();
    }
    validate();
  });
  input.addEventListener("blur", () => {
    if (parseTime(input.value) !== null) setValue(current);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && event.altKey && !trigger.disabled) {
      event.preventDefault();
      if (!panel.matches(":popover-open")) trigger.click();
    }
  });

  panel.addEventListener("toggle", event => {
    const open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const bounds = element.getBoundingClientRect();
    const popup = panel.getBoundingClientRect();
    const zoom = panel.offsetWidth ? popup.width / panel.offsetWidth : 1;
    const rtl = getComputedStyle(element).direction === "rtl";
    const left = Math.max(4, Math.min(rtl ? bounds.right - popup.width : bounds.left, innerWidth - popup.width - 4));
    const spaceBelow = innerHeight - bounds.bottom - 8;
    const y = popup.height <= spaceBelow || spaceBelow >= bounds.top
      ? bounds.bottom + 4 : bounds.top - popup.height - 4;
    const top = Math.max(4, Math.min(y, innerHeight - popup.height - 4));
    panel.style.left = `${left / zoom}px`;
    panel.style.top = `${top / zoom}px`;
    refreshOptions();
    focusOption(hours);
  });
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const column = hours.list.contains(event.target) ? hours : minutes.list.contains(event.target) ? minutes : null;
    if (!column) return;
    const buttons = [...column.options.values()];
    const index = buttons.indexOf(event.target);
    const next = {
      ArrowDown: (index + 1) % buttons.length,
      ArrowUp: (index - 1 + buttons.length) % buttons.length,
      Home: 0, End: buttons.length - 1
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      focusOption(column, buttons[next]);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      focusOption(event.key === "ArrowLeft" ? hours : minutes);
    }
  });

  setValue(value);
  return {
    element,
    get value() { return current; },
    set value(value) { setValue(value); },
    set disabled(disabled) {
      input.disabled = disabled;
      trigger.disabled = disabled;
      if (disabled && panel.matches(":popover-open")) panel.hidePopover();
    },
    set required(required) { input.required = required; clear.hidden = required; },
    focus() { input.focus(); },
    setCustomValidity(message) { externalError = message; validate(); },
    reportValidity() { return input.reportValidity(); }
  };
}
