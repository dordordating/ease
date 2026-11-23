function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderWorkspaceSync(parent, { locale, dateLocale = locale, t, send }) {
  const box = element("div", "account-details");
  const status = element("p");
  status.setAttribute("role", "status");
  const error = element("p", "account-error-message");
  error.setAttribute("role", "alert");
  const actions = element("div", "connection-actions");
  const buttons = ["cloud", "local"].map(action => {
    const label = t(action === "cloud" ? "syncUseCloud" : "syncUseLocal");
    const button = element("button", action === "cloud" ? "primary-button" : "secondary-button", label);
    button.type = "button";
    button.addEventListener("click", () => perform(action));
    return button;
  });
  actions.append(...buttons);
  box.append(status, error, actions);
  parent.append(box);
  const formatter = new Intl.DateTimeFormat(dateLocale, { dateStyle: "short", timeStyle: "short" });
  let current = { kind: "guest" };
  let busy = false;
  let version = 0;
  let actionError;

  function draw() {
    const { kind, lastSyncedAt, firstConflict } = current;
    box.hidden = kind === "guest";
    const issue = actionError || current.error;
    status.textContent = busy ? t("syncWorking") : kind === "conflict" ? t(firstConflict ? "syncCloudExists" : "syncConflict")
      : issue ? "" : lastSyncedAt ? t("syncLastSynced", { date: formatter.format(lastSyncedAt) }) : t("syncWorking");
    status.hidden = !status.textContent;
    error.hidden = !issue;
    error.textContent = issue ? t(issue) : "";
    actions.hidden = kind !== "conflict" || issue === "syncLegacyPending";
    for (const button of buttons) button.disabled = busy;
  }

  async function refresh() {
    const id = ++version;
    try {
      const response = await send("status");
      if (!box.isConnected || id !== version) return;
      if (response?.status) {
        const next = response.status;
        if (next.accountId !== current.accountId || next.lastSyncedAt > (current.lastSyncedAt ?? 0)) actionError = undefined;
        current = next;
      } else actionError = response?.error ?? "syncUnavailable";
    } catch {
      if (id !== version || !box.isConnected) return;
      actionError = "syncUnavailable";
    }
    draw();
  }

  async function perform(action) {
    if (busy) return;
    version += 1;
    busy = true;
    actionError = undefined;
    draw();
    try {
      const response = await send(action, current.accountId);
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

  draw();
  refresh();
  return refresh;
}
