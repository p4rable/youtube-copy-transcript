// Copy Transcript: one button on YouTube watch pages that copies the transcript.
// The text comes from YouTube's own transcript panel, opened off-screen and closed again,
// because direct caption downloads now need a token only YouTube's player can make.
'use strict';

const PANEL = 'ytd-engagement-panel-section-list-renderer';
const SEGMENT = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
const SEGMENT_TEXT = '.segment-text, span[role="text"], .ytAttributedStringHost';
const LOAD_MS = 10000;

let running = '';                      // video id of the copy in progress
let cache = { id: '', text: '', words: 0 };
let toast, toastTimer, placeTimer;

const label = make('span', 'ct-label', 'Copy transcript');
const glyph = make('span', 'ct-glyph', '¶');
glyph.setAttribute('aria-hidden', 'true');
const button = make('button', 'ct-btn');
button.type = 'button';
button.append(glyph, label);
button.addEventListener('click', copy);

const rowWatcher = new MutationObserver(() => button.isConnected || place());

function make(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = (el) => el.getClientRects().length > 0;
const videoId = () => (location.pathname === '/watch' && new URLSearchParams(location.search).get('v')) || '';

// The button goes right after Share. YouTube renders the row late and sometimes redraws it,
// so retry for a few seconds and watch that one row (not the page).
function place(tries = 0) {
  clearTimeout(placeTimer);
  if (!videoId() || button.isConnected) return;
  const row = document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
  if (!row) {
    if (tries < 40) placeTimer = setTimeout(place, 250, tries + 1);
    return;
  }
  row.after(button);
  rowWatcher.disconnect();
  rowWatcher.observe(row.parentNode, { childList: true });
}

async function copy() {
  const id = videoId();
  if (running || !id) return;
  if (cache.id === id) return deliver(cache);
  running = id;
  button.style.minWidth = `${button.getBoundingClientRect().width}px`;  // keep the row still while the label is shorter
  label.textContent = 'Copying…';
  button.setAttribute('aria-busy', 'true');
  try {
    const lines = await readTranscript();
    if (videoId() !== id) return;      // moved on to another video; drop this copy
    if (!lines) return say('No transcript for this video');
    if (!lines.length) return say("Transcript didn't load. Try again.", 'Stopped after 10 s');
    const body = lines.join(' ');
    cache = { id, text: header(id) + body, words: body.split(' ').length };
    await deliver(cache);
  } finally {
    running = '';
    label.textContent = 'Copy transcript';
    button.removeAttribute('aria-busy');
    button.style.minWidth = '';
  }
}

function header(id) {
  const h1 = document.querySelector('ytd-watch-metadata h1');
  const title = (h1 ? h1.textContent : document.title.replace(/ - YouTube$/, '')).replace(/\s+/g, ' ').trim();
  return `${title}\nhttps://www.youtube.com/watch?v=${id}\n\n`;
}

async function deliver({ text, words }) {
  if (await write(text)) say('Transcript copied', `${words.toLocaleString('en-US')} word${words === 1 ? '' : 's'}`, 2400);
  else say("Couldn't copy. Click again.", 'Text is ready');
}

// Returns the transcript lines, [] if the panel never filled, or null if the video has none.
async function readTranscript() {
  let lines = readLines();
  if (lines.length) return loadAll(lines);          // panel already open: read it, leave it open

  const kept = [...document.querySelectorAll(PANEL)].filter(shown);
  kept.forEach((p) => p.setAttribute('ct-keep', ''));
  document.documentElement.classList.add('ct-busy');  // panels opened now stay off-screen
  let expander = null;
  try {
    let show = findShowButton();
    if (!show) {
      if (!document.querySelector(`${PANEL}[target-id*="transcript" i]`)) return null;
      expander = document.querySelector('ytd-watch-metadata #expand');  // button may sit in the collapsed description
      if (expander) expander.click();
      show = await waitFor(findShowButton, 1500);
      if (!show) return [];
    }
    show.click();
    lines = await waitFor(found, 3000);
    if (!lines) {
      const tab = transcriptTab();                    // panels with Chapters / Transcript tabs
      if (tab) tab.click();
      lines = await waitFor(found, LOAD_MS - 3000);
    }
    return lines ? await loadAll(lines) : [];
  } finally {
    for (const p of document.querySelectorAll(PANEL)) if (shown(p) && !p.hasAttribute('ct-keep')) close(p);
    if (expander) document.querySelector('ytd-watch-metadata #collapse')?.click();
    await waitFor(() => ![...document.querySelectorAll(PANEL)].some((p) => shown(p) && !p.hasAttribute('ct-keep')), 500);
    kept.forEach((p) => p.removeAttribute('ct-keep'));
    document.documentElement.classList.remove('ct-busy');
  }
}

function readLines() {
  const lines = [];
  for (const seg of document.querySelectorAll(SEGMENT)) {
    const t = shown(seg) && seg.querySelector(SEGMENT_TEXT)?.textContent.replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
  }
  return lines;
}

const found = () => {
  const lines = readLines();
  return lines.length ? lines : null;
};

const findShowButton = () =>
  document.querySelector('ytd-video-description-transcript-section-renderer button') ||
  [...document.querySelectorAll('ytd-watch-flexy button')].find((b) =>
    /show transcript/i.test(b.getAttribute('aria-label') || b.textContent));

const transcriptTab = () =>
  [...document.querySelectorAll(`${PANEL} [role="tab"]`)].find((t) =>
    /transcript/i.test(t.textContent) && t.getAttribute('aria-selected') !== 'true');

function close(panel) {
  const x = panel.querySelector('#visibility-button button, button[aria-label*="close" i]');
  if (x) x.click();
  else panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
}

// Long transcripts can load in batches as the list scrolls; scroll until no new lines appear.
async function loadAll(lines) {
  const segs = [...document.querySelectorAll(SEGMENT)].filter(shown);
  const last = segs[segs.length - 1];
  const panel = last && last.closest(PANEL);
  if (!panel) return lines;
  let box = last.parentElement;
  while (box && box.scrollHeight <= box.clientHeight) box = box === panel ? null : box.parentElement;
  if (!box) return lines;
  const top = box.scrollTop;
  for (let i = 0; i < 40; i++) {
    box.scrollTop = box.scrollHeight;
    await sleep(250);
    const more = readLines();
    if (more.length <= lines.length) break;
    lines = more;
  }
  box.scrollTop = top;
  return lines;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end || videoId() !== running) return v || null;
    await sleep(100);
  }
}

async function write(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const area = make('textarea', 'ct-copy');            // fallback when the Clipboard API refuses
  area.value = text;
  const prev = document.activeElement;
  document.body.append(area);
  area.focus({ preventScroll: true });
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  area.remove();
  if (prev && prev.focus) prev.focus({ preventScroll: true });
  return ok;
}

function say(msg, meta = '', ms = 4000) {
  if (!toast) {
    toast = make('div', 'ct-toast');
    toast.setAttribute('role', 'status');
    toast.append(make('span', 'ct-msg'), make('span', 'ct-meta'));
  }
  toast.firstChild.textContent = msg;
  toast.lastChild.textContent = meta;
  (document.fullscreenElement || document.body).append(toast);
  toast.classList.remove('ct-on');
  void toast.offsetWidth;                              // restart the fade
  toast.classList.add('ct-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('ct-on'), ms);
}

document.addEventListener('yt-navigate-finish', () => place());
place();
