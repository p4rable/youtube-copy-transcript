// End-to-end tests: real Chromium with the unpacked extension, on a local copy of YouTube's
// watch-page structure served at https://www.youtube.com/watch (requests never leave the browser).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = readFileSync(new URL('fixture.html', import.meta.url), 'utf8');
const TITLE = 'Why suspension bridges sag on purpose';
let ctx;

before(async () => {
  ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.youtube.com' });
  await ctx.route('https://www.youtube.com/**', (r) => r.fulfill({ contentType: 'text/html', body: fixture }));
});
after(async () => { await ctx?.close(); });   // ctx is unset if the browser failed to start

async function open(fx, v = 'vid1') {
  const page = await ctx.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${v}&fx=${fx}`);
  await page.waitForSelector('.ct-btn');
  return page;
}

const toast = (page) => page.waitForFunction(() => {
  const t = document.querySelector('.ct-toast.ct-on');
  return t && [t.querySelector('.ct-msg').textContent, t.querySelector('.ct-meta').textContent];
}, null, { timeout: 15000 }).then((h) => h.jsonValue());

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const fx = (page) => page.evaluate(() => window.fx);

function expected(v, n) {
  const lines = Array.from({ length: n }, (_, i) => `Line ${i + 1} of ${v}: the cable hangs in a curve.`);
  return `${TITLE}\nhttps://www.youtube.com/watch?v=${v}\n\n${lines.join(' ')}`;
}

async function settled(page) {
  const state = await page.evaluate(() => ({
    busy: document.documentElement.classList.contains('ct-busy'),
    keep: document.querySelectorAll('[ct-keep]').length,
    label: document.querySelector('.ct-btn').textContent,
    ariaBusy: document.querySelector('.ct-btn').getAttribute('aria-busy'),
  }));
  assert.deepEqual(state, { busy: false, keep: 0, label: '¶Copy transcript', ariaBusy: null });
}

test('button sits right after Share and only on watch pages', async () => {
  const page = await open('classic');
  const order = await page.$$eval('ytd-menu-renderer > *', (els) => els.map((e) => e.id || e.className));
  assert.deepEqual(order, ['top-level-buttons-computed', 'ct-btn', 'flexible-item-buttons', 'pill']);
  assert.equal(await page.$eval('.ct-btn', (b) => b.getAttribute('type')), 'button');
  await page.goto('https://www.youtube.com/results?search_query=bridges&fx=classic');
  await page.waitForTimeout(600);
  assert.equal(await page.$('.ct-btn'), null);
  await page.close();
});

test('classic markup: copies title, link and flowing text; panel stays invisible and closes', async () => {
  const page = await open('classic');
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  const t0 = Date.now();
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  const ms = Date.now() - t0;
  assert.equal(await clipboard(page), expected('vid1', 40));
  const log = await fx(page);
  assert.equal(log.showClicks, 1);
  assert.equal(log.closeClicks, 1);
  assert.equal(log.renders[0].panelOpacity, '0', 'panel invisible while it loads');
  assert.equal(log.renders[0].panelPosition, 'fixed', 'panel out of the page flow');
  assert.equal(log.renders[0].relatedTop, log.relatedTopBefore, 'page did not move');
  assert.equal(await page.$eval(
    'ytd-engagement-panel-section-list-renderer', (p) => p.getAttribute('visibility')), 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  await settled(page);
  console.log(`  classic copy took ${ms} ms (fixture panel loads in 300 ms)`);
  await page.close();
});

test('busy state: label changes, button keeps its width so the row does not shift', async () => {
  const page = await open('classic');
  const box = () => page.$eval('.ct-btn', (b) => [Math.round(b.getBoundingClientRect().width), b.textContent]);
  const shareX = () => page.$eval('#top-level-buttons-computed .pill:last-child', (b) => b.getBoundingClientRect().x);
  const [w] = await box();
  const x = await shareX();
  await page.click('.ct-btn');
  assert.deepEqual(await box(), [w, '¶Copying…']);
  assert.equal(await shareX(), x);
  await toast(page);
  assert.deepEqual(await box(), [w, '¶Copy transcript']);
  assert.equal(await page.$eval('.ct-btn', (b) => b.style.minWidth), '');
  await page.close();
});

test('2026 markup (transcript-segment-view-model): no timestamps or screen-reader labels leak in', async () => {
  const page = await open('modern');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  const text = await clipboard(page);
  assert.equal(text, expected('vid1', 40));
  assert.doesNotMatch(text, /seconds|\d:\d\d/);
  await settled(page);
  await page.close();
});

test('no transcript: says so quickly and touches nothing', async () => {
  const page = await open('none');
  const t0 = Date.now();
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['No transcript for this video', '']);
  assert.ok(Date.now() - t0 < 1500);
  const log = await fx(page);
  assert.equal(log.expandClicks, 0);
  assert.equal(await page.$eval('.ct-toast .ct-meta', (m) => getComputedStyle(m).display), 'none');
  await settled(page);
  await page.close();
});

test('transcript button hidden in the collapsed description: expands, copies, collapses', async () => {
  const page = await open('lazydesc');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  const log = await fx(page);
  assert.equal(log.expandClicks, 1);
  assert.equal(log.collapseClicks, 1);
  await settled(page);
  await page.close();
});

test('panel with Chapters / Transcript tabs: switches to Transcript', async () => {
  const page = await open('tabs');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  await settled(page);
  await page.close();
});

test('long transcript that loads in batches: gets every line', async () => {
  const page = await open('incremental');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '2,000 words']);
  assert.equal(await clipboard(page), expected('vid1', 200));
  await settled(page);
  await page.close();
});

test('batches that take over half a second still all arrive', async () => {
  const page = await open('slowbatch');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '2,000 words']);
  assert.equal(await clipboard(page), expected('vid1', 200));
  await settled(page);
  await page.close();
});

test('tabbed panel in another language: still switches to the transcript tab', async () => {
  const page = await open('tabs&hl=th');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  await settled(page);
  await page.close();
});

// The 2026 "In this video" panel: Show transcript can open it on Timeline, so the Transcript chip must be
// picked. Chip names are localized; in Thai the English name matches nothing.
for (const [hl, name] of [['', 'English'], ['th', 'Thai']]) {
  test(`"In this video" panel (Timeline / Chapters / Transcript), ${name} interface: picks the Transcript chip`, async () => {
    const page = await open(`consolidated${hl && `&hl=${hl}`}`);
    const t0 = Date.now();
    await page.click('.ct-btn');
    assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
    const ms = Date.now() - t0;
    assert.equal(await clipboard(page), expected('vid1', 40));
    assert.equal((await fx(page)).chipClicks, 1);
    assert.ok(ms < 2000, `took ${ms} ms`);
    await settled(page);
    await page.close();
  });
}

test('Thai transcript: copied exactly, words counted the Thai way', async () => {
  const page = await open('consolidated&hl=th&lines=th');
  await page.click('.ct-btn');
  const [msg, meta] = await toast(page);
  const lines = Array.from({ length: 40 }, (_, i) => `บรรทัดที่ ${i + 1} ของ vid1: สายเคเบิล ห้อยเป็นเส้นโค้ง`);
  const body = lines.join(' ');
  assert.equal(await clipboard(page), `${TITLE}\nhttps://www.youtube.com/watch?v=vid1\n\n${body}`);
  const words = await page.evaluate((t) =>   // Chromium's own Thai word segmentation, as the extension uses
    [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(t)].filter((w) => w.isWordLike).length, body);
  assert.ok(words > 40 * 4, `segmented into ${words} words`);
  assert.deepEqual([msg, meta], ['Transcript copied', `${words.toLocaleString('en-US')} words`]);
  await page.close();
});

test('"In this video" panel already on its Transcript chip: never switches away', async () => {
  const page = await open('consolidated&hl=th&chip=transcript');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  assert.equal((await fx(page)).chipClicks, 0);
  await page.close();
});

test('a list that renders only when on screen still renders, unseen', async () => {
  const page = await open('lazyview');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  const log = await fx(page);
  assert.equal(log.renders[0].panelOpacity, '0');
  assert.equal(log.renders[0].relatedTop, log.relatedTopBefore, 'page did not move');
  await settled(page);
  await page.close();
});

test('Show transcript ignoring the first click (handler not ready yet): clicks again', async () => {
  const page = await open('late');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  const log = await fx(page);
  assert.equal(log.ignoredClicks, 1);
  assert.equal(log.showClicks, 1);
  await settled(page);
  await page.close();
});

test('transcript ending long before the video does (music outro): slow batches still all arrive', async () => {
  const page = await open('slowbatch&dur=45:00');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '2,000 words']);
  assert.equal(await clipboard(page), expected('vid1', 200));
  await page.close();
});

test('copy finishes within 300 ms of the last line appearing', async () => {
  for (const mode of ['classic', 'modern', 'consolidated', 'consolidated&hl=th', 'incremental']) {
    const page = await open(mode);
    await page.click('.ct-btn');
    await toast(page);
    const log = await fx(page);
    const ms = log.toasts[0] - log.lastRenderAt;
    console.log(`  ${mode}: note shown ${ms} ms after the last line rendered`);
    assert.ok(ms <= 300, `${mode}: ${ms} ms`);
    await page.close();
  }
});

test('a description the user expanded stays expanded', async () => {
  const page = await open('classic');
  await page.evaluate(() => {
    document.querySelector('ytd-video-description-transcript-section-renderer').remove();
    document.querySelector('#expand').click();
  });
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ["Transcript didn't load. Try again.", 'Stopped after 2 s']);
  assert.equal(await page.$eval('ytd-text-inline-expander', (e) => e.hasAttribute('is-expanded')), true);
  const log = await fx(page);
  assert.equal(log.expandClicks, 1);
  assert.equal(log.collapseClicks, 0);
  await settled(page);
  await page.close();
});

test('panel already open: reads it and leaves it open', async () => {
  const page = await open('open');
  await page.waitForSelector('ytd-transcript-segment-renderer');
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  const log = await fx(page);
  assert.equal(log.showClicks, 1);
  assert.equal(log.closeClicks, 0);
  assert.equal(await page.$eval(
    'ytd-engagement-panel-section-list-renderer', (p) => p.getAttribute('visibility')), 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  await settled(page);
  await page.close();
});

test('panel never fills: gives up after 10 s and cleans up', async () => {
  const page = await open('never');
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  const t0 = Date.now();
  await page.click('.ct-btn');
  const [msg, meta] = await toast(page);
  const ms = Date.now() - t0;
  assert.equal(msg, "Transcript didn't load. Try again.");
  assert.match(meta, /^Stopped after 1[01] s$/);   // the real wait, which runs a little past 10 s
  assert.ok(ms >= 9500 && ms < 12000, `took ${ms} ms`);
  assert.equal(await clipboard(page), 'sentinel');
  assert.equal((await fx(page)).closeClicks, 1);
  assert.equal((await fx(page)).showClicks, 1, 'no second click once the panel opened');
  await settled(page);
  await page.close();
});

test('repeated clicks run one copy; a second copy of the same video is instant', async () => {
  const page = await open('classic');
  await page.click('.ct-btn');
  await page.click('.ct-btn', { force: true });
  await page.click('.ct-btn', { force: true });
  await toast(page);
  assert.equal((await fx(page)).showClicks, 1);
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await page.evaluate(() => document.querySelector('.ct-toast').classList.remove('ct-on'));
  const t0 = Date.now();
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(await clipboard(page), expected('vid1', 40));
  assert.equal((await fx(page)).showClicks, 1);
  await page.close();
});

test('moving to another video re-attaches the button and copies the new transcript', async () => {
  const page = await open('classic');
  await page.click('.ct-btn');
  await toast(page);
  await page.evaluate(() => window.fxNavigate('vid2', 'Why suspension bridges sag on purpose'));
  await page.waitForFunction(() => document.querySelector('#top-level-buttons-computed + .ct-btn'));
  await page.evaluate(() => document.querySelector('.ct-toast').classList.remove('ct-on'));
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid2', 40));
  await page.close();
});

// With &reuse=1 the new video's lines are written into the same elements, so only their text tells old from new.
for (const [fxMode, how] of [['open', 'new line elements'], ['open&reuse=1', 'reused line elements']]) {
  test(`panel left open across navigation (${how}): copies the new video, never the old one`, async () => {
    const page = await open(fxMode);
    await page.waitForSelector('ytd-transcript-segment-renderer');
    await page.evaluate(() => window.fxNavigate('vid2', 'Why suspension bridges sag on purpose', true));
    await page.waitForFunction(() => document.querySelector('#top-level-buttons-computed + .ct-btn'));
    await page.click('.ct-btn');
    assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
    assert.equal(await clipboard(page), expected('vid2', 40));
    assert.equal((await fx(page)).closeClicks, 0, "the user's own panel is not closed");
    assert.equal(await page.$eval(
      'ytd-engagement-panel-section-list-renderer', (p) => p.getAttribute('visibility')), 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    await settled(page);
    await page.close();
  });
}

test('YouTube redrawing the action row puts the button back', async () => {
  const page = await open('classic');
  await page.evaluate(() => window.fxRedrawRow());
  await page.waitForFunction(() => document.querySelector('#top-level-buttons-computed + .ct-btn'));
  assert.equal(await page.$$eval('.ct-btn', (b) => b.length), 1);
  await page.close();
});

test('navigating away mid-copy drops that copy silently', async () => {
  const page = await open('slow');
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await page.click('.ct-btn');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.fxNavigate('vid3', 'Another video'));
  await page.waitForTimeout(1500);
  assert.equal(await page.$('.ct-toast.ct-on'), null);
  assert.equal(await clipboard(page), 'sentinel');
  await settled(page);
  await page.close();
});

test('follows YouTube dark theme', async () => {
  const page = await open('classic');
  const color = () => page.$eval('.ct-btn', (b) => getComputedStyle(b).color);
  assert.equal(await color(), 'rgb(15, 15, 15)');
  await page.evaluate(() => document.documentElement.setAttribute('dark', ''));
  assert.equal(await color(), 'rgb(241, 241, 241)');
  await page.click('.ct-btn');
  await toast(page);
  assert.equal(await page.$eval('.ct-toast', (t) => getComputedStyle(t).backgroundColor), 'rgb(33, 33, 33)');
  await page.close();
});

// Headless Chromium never loses focus, so a refusal is simulated inside the extension's own
// (isolated) script world: the next Clipboard API write rejects, as it does in an unfocused window.
async function refuseNextWrite(page, execCommandWorks) {
  const cdp = await ctx.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.origin.startsWith('chrome-extension://')) worlds.push(context.id);
  });
  await cdp.send('Runtime.enable');
  assert.equal(worlds.length, 1, 'found the content script world');
  await cdp.send('Runtime.evaluate', { contextId: worlds[0], expression: `
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    let calls = 0;
    navigator.clipboard.writeText = (t) =>
      calls++ ? real(t) : Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'));
    ${execCommandWorks ? '' : 'document.execCommand = () => false;'}` });
}

test('Clipboard API refused: falls back to a plain copy', async () => {
  const page = await open('classic');
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await refuseNextWrite(page, true);
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.equal(await clipboard(page), expected('vid1', 40));
  assert.equal(await page.$('.ct-copy'), null);
  await page.close();
});

test('clipboard fully refused: keeps the text and the next click copies it', async () => {
  const page = await open('classic');
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await refuseNextWrite(page, false);
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ["Couldn't copy. Click again.", 'Text is ready']);
  assert.equal(await clipboard(page), 'sentinel');
  assert.equal(await page.$('.ct-copy'), null);
  await page.evaluate(() => document.querySelector('.ct-toast').classList.remove('ct-on'));
  const t0 = Date.now();
  await page.click('.ct-btn');
  assert.deepEqual(await toast(page), ['Transcript copied', '400 words']);
  assert.ok(Date.now() - t0 < 500, 'second click is instant');
  assert.equal(await clipboard(page), expected('vid1', 40));
  assert.equal((await fx(page)).showClicks, 1);
  await page.close();
});
