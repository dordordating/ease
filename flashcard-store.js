import { translatorLanguages } from "./translator-engine.js";

const languages = new Set(translatorLanguages);
const directions = ["recognition", "recall"];
const ratings = new Set(["again", "hard", "good", "easy"]);
const preferenceLimits = { newPerDay: 100, reviewsPerDay: 500 };
const maximumCards = 1_000;
const maximumInterval = 3_650;
const retryDelay = 10 * 60_000;
const activityDays = 90;

export const flashcardFieldLimits = Object.freeze({
  term: 1_000, answer: 1_000, usage: 720, example: 560, exampleTranslation: 560
});

export const defaultFlashcards = Object.freeze({
  language: "en",
  direction: "recognition",
  newPerDay: 10,
  reviewsPerDay: 50,
  cards: Object.freeze([]),
  activity: Object.freeze({})
});

export class FlashcardError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function invalid() {
  return new FlashcardError("flashcardInvalid");
}

function stateWithDefaults(state) {
  return { ...defaultFlashcards, ...state };
}

function activeDirections(direction) {
  return direction === "both" ? directions : [direction];
}

function dayKey(time) {
  const date = new Date(time);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDayAfter(now, days) {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayActivity(state, day) {
  return state.activity[day]?.[state.language] ?? { introduced: 0, reviewed: 0 };
}

function reviewVersion(card, direction) {
  return `${card.id}:${card.revision}:${direction}:${card.progress[direction]?.reviews ?? 0}`;
}

function cleanText(value, field) {
  if (typeof value !== "string") throw invalid();
  const text = value.trim();
  if (((field === "term" || field === "answer") && !text) || text.length > flashcardFieldLimits[field]) {
    throw invalid();
  }
  return text;
}

function isDuplicate(card, data) {
  return card.language === data.language
    && card.term.normalize("NFC") === data.term.normalize("NFC")
    && card.answer.normalize("NFC") === data.answer.normalize("NFC");
}

export function changeFlashcardPreferences(state, patch) {
  const next = stateWithDefaults(state);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid();

  if (Object.hasOwn(patch, "language")) {
    if (!languages.has(patch.language)) throw invalid();
    next.language = patch.language;
  }
  if (Object.hasOwn(patch, "direction")) {
    if (![...directions, "both"].includes(patch.direction)) throw invalid();
    next.direction = patch.direction;
  }
  for (const [key, maximum] of Object.entries(preferenceLimits)) {
    if (!Object.hasOwn(patch, key)) continue;
    if (!Number.isInteger(patch[key]) || patch[key] < 0 || patch[key] > maximum) throw invalid();
    next[key] = patch[key];
  }
  return next;
}

export function saveFlashcard(state, data) {
  const next = stateWithDefaults(state);
  if (!data || !languages.has(data.language)) throw invalid();
  if (data.id !== undefined && (typeof data.id !== "string" || !data.id)) throw invalid();
  const existing = next.cards.find(({ id }) => id === data.id);
  if (data.id !== undefined && !existing) throw invalid();

  const fields = { language: data.language };
  for (const field of Object.keys(flashcardFieldLimits)) {
    const optional = field !== "term" && field !== "answer";
    const value = optional && data[field] === undefined ? existing?.[field] ?? "" : data[field];
    fields[field] = cleanText(value, field);
  }
  if (next.cards.some(card => card.id !== existing?.id && isDuplicate(card, fields))) {
    throw new FlashcardError("flashcardDuplicate");
  }
  if (!existing && next.cards.length >= maximumCards) throw new FlashcardError("flashcardListFull");
  if (existing && Object.entries(fields).every(([field, value]) => existing[field] === value)) return next;

  const now = Date.now();
  const progress = existing?.language === fields.language
    ? existing.progress
    : { recognition: null, recall: null };
  const card = {
    id: existing?.id ?? crypto.randomUUID(),
    ...fields,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    revision: (existing?.revision ?? 0) + 1,
    progress
  };
  next.cards = existing ? next.cards.map(item => item.id === card.id ? card : item) : [...next.cards, card];
  return next;
}

export function removeFlashcard(state, id) {
  const next = stateWithDefaults(state);
  if (typeof id !== "string" || !id) throw invalid();
  return { ...next, cards: next.cards.filter(card => card.id !== id) };
}

function nextSchedule(previous, rating, now) {
  const reviews = (previous?.reviews ?? 0) + 1;
  if (rating === "again") return { reviews, intervalDays: 0, dueAt: now + retryDelay };

  const days = previous?.intervalDays ?? 0;
  const intervals = {
    hard: Math.max(1, Math.round(days * 1.2)),
    good: Math.max(3, Math.round(days * 2.3)),
    easy: Math.max(7, Math.round(days * 3.5))
  };
  const intervalDays = Math.min(maximumInterval, intervals[rating]);
  return { reviews, intervalDays, dueAt: startOfLocalDayAfter(now, intervalDays) };
}

function validTime(now) {
  return typeof now === "number" && Number.isFinite(new Date(now).getTime());
}

export function reviewFlashcard(state, result, now = Date.now()) {
  const next = stateWithDefaults(state);
  if (!result || typeof result.id !== "string" || !ratings.has(result.rating) || !directions.includes(result.direction) || !validTime(now)) {
    throw invalid();
  }
  const { id, direction, rating, version } = result;
  const card = next.cards.find(item => item.id === id);
  if (!card || card.language !== next.language || !activeDirections(next.direction).includes(direction)
    || reviewVersion(card, direction) !== version) {
    throw new FlashcardError("flashcardReviewChanged");
  }

  const day = dayKey(now);
  const counts = dayActivity(next, day);
  const previous = card.progress[direction];
  const introduced = counts.introduced + (previous ? 0 : 1);
  const reviewed = counts.reviewed + (previous ? 1 : 0);
  if (previous?.dueAt > now || (previous ? reviewed > next.reviewsPerDay : introduced > next.newPerDay)) {
    throw new FlashcardError("flashcardReviewChanged");
  }

  const updated = { ...card, progress: { ...card.progress, [direction]: nextSchedule(previous, rating, now) } };
  const activity = { ...next.activity, [day]: { ...next.activity[day], [next.language]: { introduced, reviewed } } };
  const previousDays = Object.keys(activity).filter(key => key !== day).sort().slice(1 - activityDays);
  next.cards = next.cards.map(item => item.id === id ? updated : item);
  next.activity = Object.fromEntries([...previousDays, day].map(key => [key, activity[key]]));
  return next;
}

export function flashcardQueue(state, now = Date.now()) {
  const current = stateWithDefaults(state);
  if (!validTime(now)) throw invalid();
  const counts = dayActivity(current, dayKey(now));
  const availableReviews = Math.max(0, current.reviewsPerDay - counts.reviewed);
  const availableNew = Math.max(0, current.newPerDay - counts.introduced);
  const tomorrow = startOfLocalDayAfter(now, 1);
  const deck = current.cards.filter(card => card.language === current.language);
  const due = [];
  const newCards = [];
  let nextDueAt = Infinity;

  for (const direction of activeDirections(current.direction)) {
    for (const card of deck) {
      const progress = card.progress[direction];
      const entry = { card, direction, version: reviewVersion(card, direction) };
      if (!progress) {
        newCards.push(entry);
      } else if (progress.dueAt <= now) {
        due.push(entry);
      } else if (current.reviewsPerDay > 0) {
        const availableAt = availableReviews ? progress.dueAt : Math.max(tomorrow, progress.dueAt);
        nextDueAt = Math.min(nextDueAt, availableAt);
      }
    }
  }

  due.sort((a, b) => a.card.progress[a.direction].dueAt - b.card.progress[b.direction].dueAt);
  const reviews = due.slice(0, availableReviews);
  const newEntries = newCards.slice(0, availableNew);
  if ((current.newPerDay > 0 && newCards.length > availableNew) || (current.reviewsPerDay > 0 && due.length > availableReviews)) {
    nextDueAt = Math.min(nextDueAt, tomorrow);
  }
  return {
    items: [...reviews, ...newEntries],
    dueCount: reviews.length,
    newCount: newEntries.length,
    reviewedToday: counts.introduced + counts.reviewed,
    nextDueAt: Number.isFinite(nextDueAt) ? nextDueAt : null
  };
}
