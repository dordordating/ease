export const homeWidgets = Object.freeze(["today", "spaces", "calendar", "flashcards", "mail"]);

export const defaultHome = Object.freeze({
  start: "last",
  order: homeWidgets,
  widgets: Object.freeze(["today", "spaces"])
});

export const assistantLimits = Object.freeze({ prompt: 2000, source: 6000, sources: 4, context: 12000, history: 2, answer: 8000, taskLabels: 64 });

export function normalizeHome(value) {
  const picks = list => Array.isArray(list) ? list.filter(id => homeWidgets.includes(id)) : [];
  const order = [...new Set([...picks(value?.order), ...homeWidgets])];
  const enabled = Array.isArray(value?.widgets) ? picks(value.widgets) : defaultHome.widgets;
  return {
    start: value?.start === "home" ? "home" : "last", order, widgets: order.filter(id => enabled.includes(id)),
    ...(value?.animateExamples === false && { animateExamples: false })
  };
}

export function changeHome(home, patch) {
  const next = normalizeHome(home);
  if (["home", "last"].includes(patch.start)) next.start = patch.start;
  if (patch.animateExamples === false) next.animateExamples = false;
  else if (patch.animateExamples === true) delete next.animateExamples;
  if (homeWidgets.includes(patch.id) && typeof patch.enabled === "boolean") {
    const enabled = new Set(next.widgets);
    if (patch.enabled) enabled.add(patch.id);
    else enabled.delete(patch.id);
    next.widgets = next.order.filter(id => enabled.has(id));
  }
  if (homeWidgets.includes(patch.id) && homeWidgets.includes(patch.target) && patch.id !== patch.target
    && ["before", "after"].includes(patch.position)) {
    const order = next.order.filter(id => id !== patch.id);
    order.splice(order.indexOf(patch.target) + (patch.position === "after" ? 1 : 0), 0, patch.id);
    next.order = order;
    next.widgets = order.filter(id => next.widgets.includes(id));
  }
  return next;
}
