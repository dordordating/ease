import { normalizeTranslatorSite, requestTranslatorSitePermission } from "./translator-site-access.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function renderTranslatorSites(parent, { t, icon, sites: initialSites, requestInWorker, onUpdate }) {
  const section = element("section", "translator-inline-sites");
  const title = element("h3", "", t("translatorInline"));
  const hint = element("p", "", t("translatorInlineHint"));
  const form = element("form", "translator-site-form");
  const label = element("label", "translator-field");
  const input = element("input");
  input.type = "text";
  input.dir = "ltr";
  input.autocomplete = "url";
  input.spellcheck = false;
  input.placeholder = t("translatorInlinePlaceholder");
  label.append(element("span", "", t("translatorInlineSite")), input);
  const enable = element("button", "secondary-button", t("translatorInlineEnable"));
  enable.type = "submit";
  const status = element("p", "translator-feedback");
  status.setAttribute("role", "status");
  status.hidden = true;
  const list = element("ul", "translator-site-list");
  form.append(label, enable);
  section.append(title, hint, form, status, list);
  parent.append(section);

  function report(key, values, kind = "error") {
    status.hidden = !key;
    status.textContent = key ? t(key, values) : "";
    status.dataset.kind = kind;
  }

  function update(sites) {
    list.replaceChildren();
    list.hidden = !sites.length;
    for (const site of sites) {
      const row = element("li", "translator-site-row");
      const name = element("span", "", new URL(site).hostname);
      name.title = site;
      name.dir = "ltr";
      const remove = element("button", "icon-button");
      const removeLabel = t("translatorInlineRemove", { site: name.textContent });
      remove.type = "button";
      remove.title = removeLabel;
      remove.setAttribute("aria-label", removeLabel);
      remove.innerHTML = icon("close");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        report();
        if (!await onUpdate(site, false, (code) => report(code))) remove.disabled = false;
      });
      row.append(name, remove);
      list.append(row);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (enable.disabled) return;
    const site = normalizeTranslatorSite(input.value);
    if (!site) {
      report("translatorInlineInvalid");
      return;
    }
    enable.disabled = true;
    report();
    try {
      const permissionError = requestInWorker ? null : await requestTranslatorSitePermission(site);
      if (permissionError) {
        report(permissionError);
        return;
      }
      if (await onUpdate(site, true, (code) => report(code), requestInWorker)) {
        input.value = "";
        report("translatorInlineEnabled", { site: new URL(site).hostname }, "info");
      }
    } catch {
      report("translatorInlineFailed");
    } finally {
      enable.disabled = false;
    }
  });

  chrome.tabs?.query?.({ active: true, currentWindow: true }).then(([tab]) => {
    if (!input.value) input.value = normalizeTranslatorSite(tab?.url) ?? "";
  }).catch(() => {});
  update(initialSites);
  return { update };
}
