import { maxClipboardHistoryTextLength } from "./clipboard-history-store.js";

const sampleInterval = 1500;
const input = document.getElementById("clipboard-reader");
let pastedText;
let previousText;

document.addEventListener("paste", (event) => {
  pastedText = event.clipboardData?.getData("text/plain");
  event.preventDefault();
});

function sampleClipboard() {
  pastedText = undefined;
  try {
    input.focus();
    // Extension clipboard permission enables paste in this offscreen document.
    // Async Clipboard reads generally require a focused top-level page.
    document.execCommand("paste");
  } catch {
    return;
  }
  if (pastedText === undefined) return;
  const text = pastedText.length <= maxClipboardHistoryTextLength ? pastedText : "";
  pastedText = undefined;
  const changed = previousText !== undefined && previousText !== text;
  previousText = text;
  if (!changed || !text.trim()) return;
  chrome.runtime.sendMessage({ type: "ease-clipboard-history-capture", text }).catch(() => {});
}

sampleClipboard();
setInterval(sampleClipboard, sampleInterval);
