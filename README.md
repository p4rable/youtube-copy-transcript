# Copy Transcript

A tiny Chrome extension that adds one button to YouTube: **¶ Copy transcript**. Click it and the video's full transcript is on your clipboard, with a small note in the corner to confirm.

```
Why suspension bridges sag on purpose
https://www.youtube.com/watch?v=VIDEO_ID

So here's the thing most people get wrong about suspension bridges. The cables aren't pulled tight...
```

The copied text starts with the title and link, followed by the transcript as plain, flowing text with no timestamps.

## Install

1. Download this repository (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and choose the folder.

The button appears in the row under any YouTube video, right after **Share**.

## How it works

YouTube now protects its caption files with a token that only its own player can create, so downloading them directly returns empty files for a growing number of videos. This extension uses YouTube's own transcript panel instead:

1. It clicks YouTube's **Show transcript** control. If there isn't one, the video has no transcript.
2. The panel opens off-screen, so the page doesn't move.
3. It reads the lines (waiting up to 10 seconds), then closes the panel. If you already had the panel open, it reads it and leaves it open.
4. It copies the text and shows the note.

## Messages

| Note | Meaning |
| --- | --- |
| *Transcript copied* · N WORDS | Done. |
| *No transcript for this video* | YouTube has no transcript for it (also live streams until they end). |
| *Couldn't copy. Click again.* | The browser refused the clipboard (for example, the window lost focus). The text is kept, so the next click copies it instantly. |
| *Transcript didn't load. Try again.* · STOPPED AFTER N S | The panel stayed empty (it waits up to 10 seconds), or its Show transcript control never appeared. The note says how long it waited. |

## Footprint

- Three files that run: `manifest.json`, `content.js`, `content.css`. No libraries, no build step.
- No permissions beyond running on `www.youtube.com`. No background worker, no network requests of its own, no data leaves the page.
- Nothing runs between clicks. The script wakes only on YouTube's navigation event, plus a small observer on the button row so the button comes back if YouTube redraws it.

Not supported: Shorts, embedded players, YouTube Music, and the mobile site.

## Tests

End-to-end tests run real Chromium with the extension loaded, against a local copy of YouTube's page structure (classic and 2026 transcript markup, no transcript, slow or empty panel, tabbed panel (English and Thai), long transcripts that load in fast or slow batches, a description you expanded yourself, navigation between videos, clipboard refusal, dark theme).

```
cd test
npm install
npx playwright install chromium
npm test
```

YouTube changes its page markup from time to time. If the button stops working, the selectors at the top of `content.js` are the place to look.
