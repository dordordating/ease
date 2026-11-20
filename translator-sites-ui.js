import { requestInlineTranslatorPermission } from "./translator-site-access.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function renderTranslatorSites(parent, { t, enabled: initialEnabled, requestInWorker, onUpdate }) {
  const section = element("section", "translator-inline-sites");
  const title = element("h3", "", t("translatorInline"));
  const hint = element("p", "", t("translatorInlineHint"));
  const privacy = element("p", "", t("translatorInlinePrivacy"));
  const control = element("button", "secondary-button translator-inline-switch");
  control.type = "button";
  control.setAttribute("role", "switch");
  const indicator = element("span", "translator-inline-switch-indicator");
  indicator.setAttribute("aria-hidden", "true");
  control.append(element("span", "", t("translatorInlineEnable")), indicator);
  const status = element("p", "translator-feedback");
  status.setAttribute("role", "status");
  status.hidden = true;
  section.append(title, hint, privacy, control, status);
  parent.append(section);
  let enabled;

  function report(key, kind = "error") {
    status.hidden = !key;
    status.textContent = key ? t(key) : "";
    status.dataset.kind = kind;
  }

  function update(value) {
    enabled = value === true;
    control.setAttribute("aria-checked", String(enabled));
  }

  control.addEventListener("click", async () => {
    if (control.disabled) return;
    const next = !enabled;
    control.disabled = true;
    report();
    try {
      // Permission prompts in a toolbar popup are requested on the first worker message hop.
      const permissionError = next && !requestInWorker ? await requestInlineTranslatorPermission() : null;
      if (permissionError) {
        report(permissionError);
        return;
      }
      if (await onUpdate(next, (code) => report(code), next && requestInWorker)) {
        update(next);
        if (next) report("translatorInlineEnabled", "info");
      }
    } catch {
      report("translatorInlineFailed");
    } finally {
      control.disabled = false;
    }
  });

  update(initialEnabled);
  return { update };
}
