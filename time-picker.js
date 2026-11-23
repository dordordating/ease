const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const pad = number => String(number).padStart(2, "0");

export function createTimePicker({ locale, t, label, value = "", required = false }) {
  const numbers = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  const format = value => numbers.format(Number(value));
  const element = document.createElement("div");
  element.className = "time-picker";
  element.dir = "ltr";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", label);
  const hours = document.createElement("select");
  const minutes = document.createElement("select");
  hours.dataset.timePart = "hour";
  minutes.dataset.timePart = "minute";
  hours.setAttribute("aria-label", `${label} · ${t("timePickerHour")}`);
  minutes.setAttribute("aria-label", `${label} · ${t("timePickerMinute")}`);
  hours.required = required;
  hours.add(new Option("—", ""));
  for (let hour = 0; hour < 24; hour += 1) hours.add(new Option(format(hour), pad(hour)));
  for (let minute = 0; minute < 60; minute += 5) minutes.add(new Option(format(minute), pad(minute)));
  const divider = document.createElement("span");
  divider.textContent = ":";
  divider.setAttribute("aria-hidden", "true");
  element.append(hours, divider, minutes);
  let legacy;

  function selectMinutes(value) {
    legacy?.remove();
    legacy = undefined;
    if (Number(value) % 5) {
      legacy = new Option(format(value), value);
      minutes.add(legacy, [...minutes.options].find(option => Number(option.value) > Number(value)) ?? null);
    }
    minutes.value = value;
  }

  function setValue(value) {
    const [hour, minute] = validTime.test(value) ? value.split(":") : ["", "00"];
    hours.value = hour;
    selectMinutes(minute);
    minutes.disabled = hours.disabled || !hour;
  }

  hours.addEventListener("input", () => {
    if (!hours.value) selectMinutes("00");
    minutes.disabled = hours.disabled || !hours.value;
  });
  minutes.addEventListener("input", () => {
    if (!legacy?.selected) {
      legacy?.remove();
      legacy = undefined;
    }
  });
  setValue(value);

  return {
    element,
    get value() { return hours.value ? `${hours.value}:${minutes.value}` : ""; },
    set value(value) { setValue(value); },
    set disabled(value) {
      hours.disabled = value;
      minutes.disabled = value || !hours.value;
    },
    set required(value) { hours.required = value; },
    focus() { hours.focus(); },
    setCustomValidity(message) { hours.setCustomValidity(message); },
    reportValidity() { return hours.reportValidity(); }
  };
}
