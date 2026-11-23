import { assistantExamples } from "./home-locales.js";

export function renderAssistantExamples({ node, button, t, locale, onSelect }) {
  const catalog = assistantExamples(locale);
  const graphemes = new Intl.Segmenter(locale, { granularity: "grapheme" });
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const root = node("div", "assistant-examples");
  const example = button("", "assistant-example", { iconOnly: true, onClick: () => onSelect(current.prompt) });
  const fit = node("span", "assistant-example-fit");
  fit.dir = "auto";
  fit.setAttribute("aria-hidden", "true");
  const text = node("span", "assistant-example-text");
  text.dir = "auto";
  text.setAttribute("aria-hidden", "true");
  example.append(fit, text);
  root.append(example);

  let queue = [];
  let current;
  let characters = [];
  let position = 0;
  let phase = "typing";
  let timer;
  let visible = false;

  function draw() {
    text.textContent = characters.slice(0, position).join("");
  }

  function advance() {
    if (phase === "pause") return showNext();
    if (phase === "read") phase = "erase";
    position += phase === "erase" ? -1 : 1;
    draw();
    if (position === 0) phase = "pause";
    if (position === characters.length) phase = "read";
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    const playing = visible && !document.hidden;
    root.dataset.typing = String(playing && !motion.matches);
    if (!playing) return;
    if (motion.matches) {
      position = characters.length;
      phase = "read";
      draw();
      if (!example.matches(":focus-visible")) timer = setTimeout(showNext, 6500);
    } else if (!example.matches(":focus-visible") || phase === "typing") {
      const delay = { typing: 64, read: 4200, erase: 24, pause: 310 };
      timer = setTimeout(advance, delay[phase]);
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
    phase = "typing";
    fit.textContent = current.prompt;
    draw();
    const label = t("assistantUseExample", { prompt: current.prompt });
    example.setAttribute("aria-label", label);
    example.title = current.prompt;
    schedule();
  }

  root.addEventListener("focusin", schedule);
  root.addEventListener("focusout", () => queueMicrotask(schedule));

  return {
    root,
    show() {
      visible = true;
      document.addEventListener("visibilitychange", schedule);
      motion.addEventListener("change", schedule);
      if (current) schedule();
      else showNext();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
      root.dataset.typing = "false";
      document.removeEventListener("visibilitychange", schedule);
      motion.removeEventListener("change", schedule);
    }
  };
}
