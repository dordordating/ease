// Rebuild message markup from an inert template with a static set of elements and properties.
const tags = new Set("a abbr article b blockquote br caption center code col colgroup dd del div dl dt em font footer h1 h2 h3 h4 h5 h6 header hr i img li main ol p pre s section small span strike strong sub sup table tbody td th thead tfoot tr u ul".split(" "));
const discard = new Set("applet area audio base button canvas embed form frame frameset head iframe input link map math meta noscript object picture script select source style svg template textarea track video".split(" "));
const properties = [
  "background-color", "border", "border-bottom", "border-collapse", "border-color", "border-left", "border-radius",
  "border-right", "border-spacing", "border-style", "border-top", "border-width", "color", "direction", "font-family",
  "font-size", "font-style", "font-weight", "height", "letter-spacing", "line-height", "list-style-type", "margin",
  "margin-bottom", "margin-left", "margin-right", "margin-top", "max-width", "padding", "padding-bottom", "padding-left",
  "padding-right", "padding-top", "text-align", "text-decoration", "vertical-align", "white-space", "width"
];

function safeLink(value) {
  try {
    const target = new URL(value);
    if (target.protocol === "https:" && !target.username && !target.password) return target.href;
  } catch {}
  return null;
}

function rebuild(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const inert = template.content.ownerDocument;
  const clean = inert.createElement("div");
  let elements = 3500;

  function walk(parent, target, depth) {
    if (depth > 48) return;
    for (const node of parent.childNodes) {
      if (--elements < 0) return;
      if (node.nodeType === 3) {
        target.append(inert.createTextNode(node.data));
        continue;
      }
      if (node.nodeType !== 1 || node.namespaceURI !== "http://www.w3.org/1999/xhtml" || discard.has(node.localName)) continue;
      if (!tags.has(node.localName)) {
        walk(node, target, depth + 1);
        continue;
      }
      const item = inert.createElement(node.localName);
      if (node.localName === "a") {
        const link = safeLink(node.getAttribute("href"));
        if (link) {
          item.href = link;
          item.target = "_blank";
          item.rel = "noopener noreferrer";
          item.referrerPolicy = "no-referrer";
        }
      }
      if (node.localName === "img") {
        const src = node.getAttribute("src");
        const alt = node.getAttribute("alt")?.slice(0, 200) ?? "";
        if (!src || src.length > 33_000 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\r\n]+$/iu.test(src)) {
          if (alt) target.append(inert.createTextNode(alt));
          continue;
        }
        // Use a separate inert tree for sanitized nodes so assigning src cannot load from the extension page.
        item.setAttribute("src", src);
        item.alt = alt;
      }
      for (const key of ["dir", "lang", "align", "valign", "bgcolor", "width", "height", "colspan", "rowspan", "cellpadding", "cellspacing", "border", "color"]) {
        const value = node.getAttribute(key);
        if (value && value.length <= 40 && /^[\w\s#%.+-]+$/u.test(value)) item.setAttribute(key, value);
      }
      for (const property of properties) {
        const value = node.style.getPropertyValue(property);
        if (value && value.length <= 150 && !/[\\;{}@]/u.test(value) && !/\b(?:url|attr|var|image-set|expression)\s*\(/iu.test(value)) {
          item.style.setProperty(property, value);
        }
      }
      target.append(item);
      walk(node, item, depth + 1);
    }
  }

  walk(template.content, clean, 0);
  return clean.innerHTML;
}

export function htmlMailFrame(html, title) {
  const frame = document.createElement("iframe");
  frame.className = "mail-html-frame";
  frame.title = title;
  frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  frame.referrerPolicy = "no-referrer";
  const content = rebuild(html);
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; form-action \'none\'; base-uri \'none\'">'
    + '<style>body{font:14px/1.5 system-ui,sans-serif;margin:10px;color:#19202f;background:#fff;overflow-wrap:anywhere}'
    + 'img,table{max-width:100%}pre{white-space:pre-wrap}a{color:#1455ac}</style>'
    + '<body dir="auto">' + content + '</body>';
  return frame;
}
