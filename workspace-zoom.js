import { normalizeWorkspaceZoom, workspaceZoomLevels } from "./workspace-data.js";

const wheelDistance = 40;
const wheelPause = 180;
const wheelStepInterval = 75;

function stepZoom(zoom, direction) {
  const index = workspaceZoomLevels.indexOf(zoom);
  return workspaceZoomLevels[Math.min(workspaceZoomLevels.length - 1, Math.max(0, index + direction))];
}

export function initWorkspaceZoom({ app, onZoom, zoom }) {
  const document = app.ownerDocument;
  const root = document.documentElement;
  let saved = normalizeWorkspaceZoom(zoom);
  let desired = saved;
  let pending;
  let disposed = false;
  let wheelTotal = 0;
  let lastWheel = -Infinity;
  let lastStep = -Infinity;

  function apply() {
    root.style.setProperty("--workspace-zoom", String(desired / 100));
  }

  function setZoom(value) {
    if (disposed) return Promise.resolve(false);
    desired = normalizeWorkspaceZoom(value);
    apply();
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        while (!disposed && saved !== desired) {
          const requested = desired;
          let accepted;
          try {
            accepted = await onZoom(requested) !== false;
          } catch {
            accepted = false;
          }
          if (accepted) {
            saved = requested;
          } else if (desired === requested) {
            desired = saved;
            if (!disposed) apply();
            return false;
          }
        }
        return !disposed;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  }

  function wheel(event) {
    if (!event.ctrlKey || !event.cancelable) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? app.clientHeight : 1;
    const delta = event.deltaY * units;
    if (!Number.isFinite(delta) || delta === 0) return;
    event.preventDefault();
    const now = event.timeStamp;
    const direction = Math.sign(delta);
    if (now - lastWheel > wheelPause || (wheelTotal && direction !== Math.sign(wheelTotal))) wheelTotal = 0;
    lastWheel = now;
    wheelTotal += delta;
    if (Math.abs(wheelTotal) < wheelDistance || now - lastStep < wheelStepInterval) return;
    lastStep = now;
    wheelTotal = 0;
    const next = stepZoom(desired, -direction);
    if (next !== desired) setZoom(next);
  }

  apply();
  document.addEventListener("wheel", wheel, { capture: true, passive: false });
  return {
    setZoom,
    update({ zoom: value }) {
      if (disposed || value === undefined) return;
      saved = normalizeWorkspaceZoom(value);
      if (pending) return;
      desired = saved;
      apply();
    },
    dispose() {
      disposed = true;
      document.removeEventListener("wheel", wheel, { capture: true });
      root.style.removeProperty("--workspace-zoom");
    }
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderWorkspaceZoomControl(container, { locale, t, zoom, onZoom }) {
  const format = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const field = element("fieldset", "choice-group workspace-zoom-setting");
  const title = element("legend", "", t("workspaceZoom"));
  const buttons = element("div", "workspace-zoom-controls");
  const announcement = element("span", "workspace-zoom-announcement");
  announcement.setAttribute("role", "status");
  let current;
  let lastRequest = 0;

  function button(id, label, text, action) {
    const control = element("button", "workspace-zoom-button", text);
    control.id = `workspace-zoom-${id}`;
    control.type = "button";
    control.title = t(label);
    control.setAttribute("aria-label", control.title);
    control.addEventListener("click", action);
    return control;
  }

  const decrease = button("out", "workspaceZoomOut", "−", () => change(stepZoom(current, -1)));
  const reset = button("reset", "workspaceZoomReset", "", () => change(100));
  const increase = button("in", "workspaceZoomIn", "+", () => change(stepZoom(current, 1)));
  buttons.append(decrease, reset, increase);
  field.append(title, buttons, announcement, element("p", "setting-hint workspace-zoom-hint", t("workspaceZoomHint")));
  container.append(field);

  function update(next) {
    const value = normalizeWorkspaceZoom(next);
    if (value === current) return;
    current = value;
    const display = format.format(value / 100);
    reset.textContent = display;
    reset.setAttribute("aria-label", `${t("workspaceZoomReset")} (${display})`);
    decrease.setAttribute("aria-disabled", String(stepZoom(value, -1) === value));
    increase.setAttribute("aria-disabled", String(stepZoom(value, 1) === value));
    reset.setAttribute("aria-disabled", String(value === 100));
    announcement.textContent = display;
  }

  async function change(next) {
    if (next === current) return;
    const previous = current;
    const request = ++lastRequest;
    update(next);
    let accepted;
    try {
      accepted = await onZoom(next) !== false;
    } catch {
      accepted = false;
    }
    if (!accepted && lastRequest === request && current === next) update(previous);
  }

  update(zoom);
  return { update };
}
