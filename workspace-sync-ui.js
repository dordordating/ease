function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderWorkspaceSync(parent, { locale, dateLocale = locale, t, send }) {
  const box = element("section", "account-card");
  const details = element("div", "account-details");
  const title = element("h3", "", t("syncTitle"));
  const status = element("p");
  status.setAttribute("role", "status");
  const error = element("p", "account-error-message");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const form = element("form", "dialog-fields");
  const label = element("label", "field");
  const passphrase = element("input");
  passphrase.type = "password";
  passphrase.required = true;
  passphrase.minLength = 10;
  passphrase.maxLength = 256;
  passphrase.autocomplete = "current-password";
  passphrase.setAttribute("aria-describedby", "workspace-sync-passphrase-hint");
  const hint = element("p", "field-hint", t("syncPassphraseHint"));
  hint.id = "workspace-sync-passphrase-hint";
  label.append(element("span", "", t("syncPassphrase")), passphrase);
  const submit = element("button", "primary-button", t("syncEnable"));
  form.append(label, hint, submit);
  const actions = element("div", "connection-actions");
  const buttons = {};
  for (const [action, key] of Object.entries({ sync: "syncNow", cloud: "syncUseCloud", local: "syncUseLocal", disable: "syncDisable" })) {
    const button = element("button", action === "cloud" || action === "sync" ? "primary-button" : "secondary-button", t(key));
    button.type = "button";
    button.addEventListener("click", () => perform(action));
    actions.append(button);
    buttons[action] = button;
  }
  details.append(element("p", "", t("syncDescription")), status, error, form, actions);
  box.append(title, details);
  parent.append(box);
  const formatter = new Intl.DateTimeFormat(dateLocale, { dateStyle: "short", timeStyle: "short" });
  let current = { kind: "guest" };
  let busy = false;
  let version = 0;
  let actionError;

  function draw() {
    const { kind, lastSyncedAt, firstConflict } = current;
    const labels = { guest: "syncSignInRequired", locked: "syncLocked", conflict: firstConflict ? "syncCloudExists" : "syncConflict" };
    status.textContent = busy ? t("syncWorking") : labels[kind] ? t(labels[kind]) : kind === "active"
      ? (lastSyncedAt ? t("syncLastSynced", { date: formatter.format(lastSyncedAt) }) : t("syncEnabled")) : "";
    status.hidden = !status.textContent;
    const message = actionError || current.error;
    error.hidden = !message;
    error.textContent = message ? t(message) : "";
    form.hidden = kind !== "disabled" && kind !== "locked";
    submit.textContent = t(kind === "locked" ? "syncUnlock" : "syncEnable");
    buttons.sync.hidden = kind !== "active";
    buttons.cloud.hidden = buttons.local.hidden = kind !== "conflict";
    buttons.disable.hidden = !["active", "conflict", "locked"].includes(kind);
    actions.hidden = Object.values(buttons).every((button) => button.hidden);
    for (const control of [passphrase, submit, ...Object.values(buttons)]) control.disabled = busy;
  }

  async function refresh() {
    const id = ++version;
    try {
      const response = await send("status");
      if (!box.isConnected || id !== version) return;
      if (response?.status) {
        const next = response.status;
        if (next.kind === "guest" || next.lastSyncedAt > (current.lastSyncedAt ?? 0)) actionError = undefined;
        current = next;
      } else actionError = response?.error ?? "syncUnavailable";
      draw();
    } catch {
      if (id !== version) return;
      actionError = "syncUnavailable";
      draw();
    }
  }

  async function perform(action, value) {
    if (busy) return;
    version++;
    busy = true;
    actionError = undefined;
    draw();
    try {
      const response = await send(action, value);
      if (response?.status) current = response.status;
      else actionError = response?.error ?? "syncUnavailable";
    } catch {
      actionError = "syncUnavailable";
    } finally {
      busy = false;
      if (box.isConnected) {
        draw();
        await refresh();
      }
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = passphrase.value;
    passphrase.value = "";
    perform("enable", value);
  });
  draw();
  refresh();
  return refresh;
}
