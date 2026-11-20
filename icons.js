const paths = {
  clipboard: '<rect x="7" y="4" width="10" height="4" rx="1.5"/><path d="M17 6h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2M8 13h8M8 17h5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h2m4 0h2m-8 3h2"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16M7 15l4-4 3 2 6-7m-5 0h5v5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 8 8 6 8-6"/>',
  translate: '<path d="M3 5h12M9 3v2m4 0c-1 6-4 9-9 11m2-8c2 4 4 6 7 7m1 5 4-9 4 9m-6.7-3h5.4"/>',
  sparkles: '<path d="M10 3c1 5 2 6 7 7-5 1-6 2-7 7-1-5-2-6-7-7 5-1 6-2 7-7Zm8 11c.5 2.5 1.5 3.5 4 4-2.5.5-3.5 1.5-4 4-.5-2.5-1.5-3.5-4-4 2.5-.5 3.5-1.5 4-4ZM19 3v4m-2-2h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-.8 2.6-2 1.2-2.7-.5L2 9l1.8 2v2L2 15l1.5 2.7 2.7-.5 2 1.2L9 21h6l.8-2.6 2-1.2 2.7.5L22 15l-1.8-2v-2L22 9l-1.5-2.7-2.7.5-2-1.2L15 3Z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16m3-11v6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v11"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  pin: '<path d="m15 3 6 6-3 1-3 4v3l-1 1-8-8 1-1h3l4-3 1-3ZM9 15l-6 6"/>',
  edit: '<path d="m14 6 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M10 14h8"/>',
  "chevron-left": '<path d="m15 6-6 6 6 6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  device: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 15.6A9 9 0 0 1 8.4 3.5 9 9 0 1 0 20.5 15.6Z"/>',
  arrow: '<path d="M6 12h12m-5-5 5 5-5 5"/>'
};

export function icon(name) {
  return `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
