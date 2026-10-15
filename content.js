// Copy Transcript: one button on YouTube watch pages that copies the transcript.
// The text comes from YouTube's own transcript panel, opened off-screen and closed again,
// because direct caption downloads now need a token only YouTube's player can make.
'use strict';

const PANEL = 'ytd-engagement-panel-section-list-renderer';
const SEGMENT = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
const SEGMENT_TEXT = '.segment-text, span[role="text"], .ytAttributedStringHost';
const STAMP = '.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp';
const LOAD_MS = 10000;                 // longest wait for the first lines
const QUIET_MS = 1000;                 // lines stopped arriving, while the last one is far from the video's end
const END_QUIET_MS = 150;              // ...and once it is within END_S of the end
const END_S = 30;

let running = '';                      // video id of the copy in progress
let cache = { id: '', text: '', words: 0 };
let stale = new WeakMap();             // lines on screen when the video changed, with their text then
let toastTimer, placeTimer;

// Screen readers hear each message through a live region that is always rendered and present before
// the first message. The toast itself is visibility:hidden between messages, which takes it out of the
// accessibility tree, so it cannot be the live region.
const live = make('div', 'ct-live');
live.setAttribute('role', 'status');
const toast = make('div', 'ct-toast');
toast.setAttribute('aria-hidden', 'true');
toast.append(make('span', 'ct-msg'), make('span', 'ct-meta'));
document.body.append(live, toast);

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
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const countWords = (s) => {
  let n = 0;                                           // segmenter, not spaces: Thai and CJK have none between words
  for (const w of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(s)) if (w.isWordLike) n++;
  return n;
};
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
  const start = Date.now();
  try {
    const lines = await readTranscript();
    if (videoId() !== id) return;      // moved on to another video; drop this copy
    if (!lines) return say('No transcript for this video');
    if (!lines.length) {
      return say("Transcript didn't load. Try again.", `Stopped after ${Math.round((Date.now() - start) / 1000)} s`);
    }
    const body = lines.join(' ');
    cache = { id, text: header(id) + body, words: countWords(body) };
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
  const title = clean(h1 ? h1.textContent : document.title.replace(/ - YouTube$/, ''));
  return `${title}\nhttps://www.youtube.com/watch?v=${id}\n\n`;
}

async function deliver({ text, words }) {
  if (await write(text)) say('Transcript copied', `${words.toLocaleString('en-US')} word${words === 1 ? '' : 's'}`, 2400);
  else say("Couldn't copy. Click again.", 'Text is ready');
}

// Returns the transcript lines, [] if the panel never filled, or null if the video has none.
async function readTranscript() {
  if (segments().length) return collect();          // panel already open: read it, leave it open

  const kept = [...document.querySelectorAll(PANEL)].filter(shown);
  kept.forEach((p) => p.setAttribute('ct-keep', ''));
  document.documentElement.classList.add('ct-busy');  // panels opened now load unseen
  let expander = null;
  try {
    let show = findShowButton();
    if (!show) {
      if (!document.querySelector(`${PANEL}[target-id*="transcript" i]`)) return null;
      const more = document.querySelector('ytd-watch-metadata #expand');  // button may sit in the collapsed description
      if (more && shown(more)) {                      // hidden when the description is already expanded: leave it be
        expander = more;
        more.click();
      }
      show = await waitFor(findShowButton, 1500);
      if (!show) return [];
    }
    const start = Date.now();
    let chip = false, again = false;
    show.click();
    const ready = await waitFor(() => {
      if (segments().length) return true;
      const t = Date.now() - start;
      if (!chip && t > 300) {                         // the "In this video" panel can open on Timeline or Chapters
        const tab = transcriptTab();
        if (tab) {
          tab.click();
          chip = true;
        }
      }
      if (!again && t > 2500 && ![...document.querySelectorAll(PANEL)].some((p) => shown(p) && !p.hasAttribute('ct-keep'))) {
        again = true;                                 // nothing opened: YouTube ignored the click (handler not ready yet)
        (findShowButton() || show).click();
      }
      return false;
    }, LOAD_MS);
    return ready ? await collect() : [];
  } finally {
    for (const p of document.querySelectorAll(PANEL)) if (shown(p) && !p.hasAttribute('ct-keep')) close(p);
    if (expander) document.querySelector('ytd-watch-metadata #collapse')?.click();
    await waitFor(() => ![...document.querySelectorAll(PANEL)].some((p) => shown(p) && !p.hasAttribute('ct-keep')), 500);
    kept.forEach((p) => p.removeAttribute('ct-keep'));
    document.documentElement.classList.remove('ct-busy');
  }
}

// Transcript lines on screen for the current video. A panel left open across navigation can still
// show the previous video's lines; those are skipped until their text changes.
const segments = () =>
  [...document.querySelectorAll(SEGMENT)].filter((s) => shown(s) && !(stale.has(s) && stale.get(s) === s.textContent));

const lineText = (seg) => clean(seg.querySelector(SEGMENT_TEXT)?.textContent || '');

const seconds = (t) => (/^\d+(:\d+)*$/.test((t = (t || '').trim())) ? t.split(':').reduce((s, p) => s * 60 + +p, 0) : NaN);

// The last line starts within END_S of the video's end (the player's own duration display; not during an ad).
const nearEnd = (seg) => !!seg &&
  seconds(seg.querySelector(STAMP)?.textContent) >=
  seconds(document.querySelector('#movie_player:not(.ad-showing) .ytp-time-duration')?.textContent) - END_S;

// Reads the open transcript once its lines stop arriving. They can render in chunks or load as the list
// scrolls, so wait until none has appeared for a moment: briefly when the last line is near the end of
// the video, longer when it is not (a slow batch may still be coming).
async function collect() {
  let segs = segments();
  const box = scroller(segs[segs.length - 1]);
  const top = box && box.scrollTop;
  let count = 0, quietSince = 0;
  const end = Date.now() + LOAD_MS;
  while (Date.now() < end && videoId() === running) {
    segs = segments();
    if (segs.length !== count) {
      count = segs.length;
      quietSince = Date.now();
      if (box) box.scrollTop = box.scrollHeight;     // lists that load more as they scroll
    } else if (Date.now() - quietSince >= (nearEnd(segs[count - 1]) ? END_QUIET_MS : QUIET_MS)) break;
    await sleep(50);
  }
  if (box) box.scrollTop = top;
  return segs.map(lineText).filter(Boolean);
}

// The scrollable list holding the lines, inside its panel.
function scroller(seg) {
  const panel = seg && seg.closest(PANEL);
  let box = panel && seg.parentElement;
  while (box && box.scrollHeight <= box.clientHeight) box = box === panel ? null : box.parentElement;
  return box;
}

const findShowButton = () =>
  document.querySelector('ytd-video-description-transcript-section-renderer button') ||
  [...document.querySelectorAll('ytd-watch-flexy button')].find((b) =>
    /show transcript/i.test(b.getAttribute('aria-label') || b.textContent));

// The Transcript chip of a panel the click opened (or a transcript-type panel already open), if it isn't
// selected. Chip names are localized and only the English one is known, so otherwise take the last chip:
// YouTube puts Transcript last (Chapters / Transcript, or Timeline / Chapters / Transcript).
const transcriptTab = () => {
  const candidate = (p) => shown(p) &&
    (!p.hasAttribute('ct-keep') || /transcript|timeline|macro-markers/i.test(p.getAttribute('target-id')));
  for (const panel of [...document.querySelectorAll(PANEL)].filter(candidate)) {
    const tabs = [...panel.querySelectorAll('[role="tab"]')].filter(shown);
    const tab = tabs.find((t) => /transcript/i.test(t.textContent)) || (tabs.length > 1 && tabs[tabs.length - 1]);
    if (tab && tab.getAttribute('aria-selected') !== 'true') return tab;
  }
};

function close(panel) {
  const x = panel.querySelector('#visibility-button button, button[aria-label*="close" i]');
  if (x) x.click();
  else panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end || videoId() !== running) return v || null;
    await sleep(50);
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
  const host = document.fullscreenElement || document.body;
  if (toast.parentNode !== host) host.append(live, toast);  // move only when needed, so the live region stays put
  toast.firstChild.textContent = msg;
  toast.lastChild.textContent = meta;
  toast.classList.remove('ct-on');
  void toast.offsetWidth;                              // restart the fade
  toast.classList.add('ct-on');
  live.textContent = meta ? `${msg} ${meta}` : msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('ct-on');
    live.textContent = '';                             // so the same message next time is new text, and announced
  }, ms);
}

document.addEventListener('yt-navigate-start', () => {
  stale = new WeakMap();
  for (const s of document.querySelectorAll(SEGMENT)) stale.set(s, s.textContent);
});
document.addEventListener('yt-navigate-finish', () => place());
place();
