const day = 24 * 60 * 60 * 1000;
const archiveAfter = 7 * day;
const removeAfter = 3 * day;
const trackingInterval = 6 * 60 * 60 * 1000;

function paidTime(order, now) {
  return order.paidAt ?? order.tracking?.placedAt ?? order.invoiceQuote?.checkedAt ?? now;
}

function orderAccount(order) {
  return order.orderAccountId ?? order.buyer?.accountId ?? null;
}

function protectedWatch(watch, state) {
  return (state.payment?.owner === state.owner && state.payment?.id === watch.id)
    || ["running", "submitting", "awaiting"].includes(state.jobs[watch.id]?.status);
}

export function archiveShoppingOrder(watch, job, now) {
  const { id, title, image, quantity } = watch;
  return { id, title, image, quantity, variant: watch.optionLabel || watch.variantLabel,
    orderId: job.orderId, orderAccountId: orderAccount(job), paidAt: paidTime(job, now), invoiceQuote: job.invoiceQuote,
    tracking: job.tracking, trackingAttemptAt: job.trackingAttemptAt };
}

export function shoppingOrders(watches, state) {
  const orders = new Map(Object.values(state.history).map(order => [order.orderId, order]));
  for (const watch of watches) {
    const job = state.jobs[watch.id];
    if (job?.status === "paid" && job.orderId) orders.set(job.orderId, job);
  }
  return [...orders.values()];
}

function orderCheckAt(order) {
  return (order.trackingAttemptAt ?? -trackingInterval) + trackingInterval;
}

export function shoppingOrdersToCheck(watches, state, now, force = false) {
  return shoppingOrders(watches, state).filter(order => !order.tracking?.finished && (force || orderCheckAt(order) <= now))
    .sort((a, b) => orderCheckAt(a) - orderCheckAt(b))
    .slice(0, 8)
    .map(order => ({ id: order.orderId, accountId: orderAccount(order) }));
}

export function nextShoppingOrderWork(watches, state, now, track) {
  const deadlines = [];
  for (const watch of watches) {
    const job = state.jobs[watch.id];
    if (job?.status === "paid") {
      if (job.orderId) deadlines.push(job.paidAt == null ? now : job.paidAt + archiveAfter);
    } else if (watch.endAt != null && !protectedWatch(watch, state)) {
      deadlines.push(watch.endAt + removeAfter);
    }
  }
  if (track) {
    deadlines.push(...shoppingOrders(watches, state).filter(order => !order.tracking?.finished).map(orderCheckAt));
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function maintainShoppingOrders(watches, state, updates, now) {
  function track(order) {
    const sample = updates.get(order.orderId);
    if (!sample || sample.accountId !== orderAccount(order) || sample.checkedAt <= (order.trackingAttemptAt ?? 0)) return order;
    return { ...order, trackingAttemptAt: sample.checkedAt, ...(sample.tracking ? { tracking: sample.tracking } : {}) };
  }
  const history = Object.fromEntries(Object.entries(state.history).map(([id, order]) => [id, track(order)]));
  const jobs = { ...state.jobs };
  const remaining = watches.filter(watch => {
    const id = watch.id;
    const job = jobs[id];
    if (job?.status === "paid") {
      if (!job.orderId) return true;
      const tracked = track(job);
      const paidAt = paidTime(tracked, now);
      jobs[id] = tracked.paidAt === paidAt ? tracked : { ...tracked, paidAt };
      if (now < paidAt + archiveAfter) return true;
      history[job.orderId] = archiveShoppingOrder(watch, jobs[id], now);
    } else if (watch.endAt == null || now < watch.endAt + removeAfter || protectedWatch(watch, state)) {
      return true;
    }
    delete jobs[id];
    return false;
  });
  return { watches: remaining, jobs, history };
}
