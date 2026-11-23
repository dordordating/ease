export function streamAnswerText(output, locale, reducedMotion) {
  const words = new Intl.Segmenter(locale, { granularity: "word" });
  const text = document.createTextNode("");
  output.append(text);
  let pending = "";
  let timer;
  let onFinish;

  function paint() {
    timer = undefined;
    let end = pending.length;
    if (output.isConnected && !output.closest("[hidden]") && !document.hidden && !reducedMotion.matches) {
      let budget = text.length ? Math.max(1, Math.ceil(pending.length / 150)) : 1;
      for (const { index, isWordLike } of words.segment(pending)) {
        if (isWordLike && budget-- === 0) {
          end = index;
          break;
        }
      }
    }
    text.appendData(pending.slice(0, end));
    pending = pending.slice(end);
    if (pending) timer = setTimeout(paint, 18);
    else {
      const complete = onFinish;
      onFinish = undefined;
      complete?.();
    }
  }

  return {
    write(value) {
      pending += value;
      if (timer === undefined && pending) paint();
    },
    finish(complete, flush = false) {
      if (flush) {
        clearTimeout(timer);
        timer = undefined;
        text.appendData(pending);
        pending = "";
      }
      if (pending) onFinish = complete;
      else complete();
    }
  };
}
