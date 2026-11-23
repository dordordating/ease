import { assistantExamples } from "./home-locales.js";

export function renderAssistantExamples({ node, button, t, locale, onSelect }) {
  const catalog = assistantExamples(locale);
  const graphemes = new Intl.Segmenter(locale, { granularity: "grapheme" });
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const root = node("div", "assistant-examples");
  const example = button("", "assistant-example", { iconOnly: true, onClick: () => onSelect(current.prompt) });
  const text = node("span", "assistant-example-text");
  text.dir = "auto";
  text.setAttribute("aria-hidden", "true");
  example.append(text);
  const next = button(t("assistantNextExample"), "icon-button assistant-example-next", {
    symbol: "refresh", iconOnly: true, onClick: showNext
  });
  root.append(example, next);

  let queue = [];
  let current;
  let characters = [];
  let position = 0;
  let timer;
  let visible = false;

  function draw() {
    text.textContent = characters.slice(0, position).join("");
  }

  function advance(erase) {
    position = erase ? Math.max(0, position - 2) : Math.min(characters.length, position + 2);
    draw();
    if (erase && position === 0) timer = setTimeout(showNext, 150);
    else if (!erase && position === characters.length) timer = setTimeout(() => advance(true), 2400);
    else timer = setTimeout(() => advance(erase), erase ? 18 : 42);
  }

  function resume() {
    clearTimeout(timer);
    const playing = visible && !document.hidden && !root.matches(":has(:focus-visible)");
    root.dataset.typing = String(playing && !motion.matches);
    if (!playing || motion.matches) {
      position = characters.length;
      draw();
      if (playing) timer = setTimeout(showNext, 4800);
    } else {
      timer = position === characters.length
        ? setTimeout(() => advance(true), 2400)
        : setTimeout(() => advance(false), 42);
    }
  }

  function showNext() {
    if (!queue.length) {
      queue = [...catalog];
      for (let index = queue.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        [queue[index], queue[other]] = [queue[other], queue[index]];
      }
      if (queue.length > 1 && queue.at(-1) === current) [queue[0], queue[queue.length - 1]] = [queue.at(-1), queue[0]];
    }
    current = queue.pop();
    characters = Array.from(graphemes.segment(current.prompt), item => item.segment);
    position = 0;
    draw();
    const label = t("assistantUseExample", { prompt: current.prompt });
    example.setAttribute("aria-label", label);
    example.title = current.prompt;
    resume();
  }

  root.addEventListener("focusin", resume);
  root.addEventListener("focusout", () => queueMicrotask(resume));

  return {
    root,
    show() {
      visible = true;
      document.addEventListener("visibilitychange", resume);
      motion.addEventListener("change", resume);
      if (current) resume();
      else showNext();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", resume);
    }
  };
}
