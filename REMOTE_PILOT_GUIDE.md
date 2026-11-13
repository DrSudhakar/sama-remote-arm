# Remote (browser) pilot — deployment, testing, and FAQ

This covers the **new remote arm**: `webexp/`, a one-page, no-install experiment that runs in a
participant's own browser from a link, saves to a free Firebase project when there is a
connection, and falls back to saving on the participant's own device when there isn't. It is
written for someone setting this up for the first time — each step says exactly what to click.

If you haven't done anything like this before, read the sections in order. Section 0 is the
one-paragraph mental model; everything after it is mechanics.

---

## 0. The mental model (read this first)

Three independent pieces, each simple on its own:

1. **The page** (`webexp/index.html` + `style.css` + `app.js` + `protocol.js`) is a single static
   website. It runs the whole experiment — consent, camera, recording, self-ratings — entirely in
   the participant's browser. It needs no server to *run*.
2. **GitHub Pages** just serves those files as a URL. It is a free static file host — think of it
   as a folder that anyone with the link can open in a browser. It cannot run code or receive
   uploads.
3. **Firebase** is where the recording and ratings actually land. It's a free Google service with
   two parts you'll use: **Storage** (holds the video + a small metadata file per participant) and
   **Firestore** (holds a matching database record). The page talks to Firebase directly from the
   participant's browser — there is no backend server for you to write or run.

If the participant is online when they finish, the page uploads straight to Firebase. If not, it
saves inside the browser itself (a technology called IndexedDB — just "a small database the
browser keeps on the participant's hard drive"), and automatically retries the upload the next
time that same browser opens the link while online. The participant never sees an "online/offline"
choice; the page detects it.

Nothing is installed. The participant clicks a link, allows camera access, and the page does the
rest.

---

## 1. Set up Firebase (≈10 minutes, one-time)

1. Go to <https://console.firebase.google.com/> and sign in with any Google account (a personal
   one is fine — this doesn't need to be institutional).
2. Click **"Add project"**. Name it anything (e.g. `sama-remote-pilot`). You can disable Google
   Analytics when asked — not needed here.
3. In the left sidebar, open **Build → Firestore Database**. Click **"Create database"**. Choose
   **"Start in production mode"** (not test mode — we'll paste our own locked-down rules in step
   5) and pick any region close to your participants.
4. In the left sidebar, open **Build → Storage**. Click **"Get started"**, accept the defaults,
   same region as Firestore.
5. Paste in the security rules (these are the actual access control — they matter more than
   keeping the config "secret", see the FAQ below):
   - Firestore: open **Build → Firestore Database → Rules** tab, delete the placeholder text, paste
     in the contents of `webexp/firestore.rules`, click **Publish**.
   - Storage: open **Build → Storage → Rules** tab, delete the placeholder text, paste in the
     contents of `webexp/storage.rules`, click **Publish**.
6. Get the config the page needs: click the gear icon next to "Project Overview" → **Project
   settings**. Scroll to **"Your apps"**, click the `</>` (web) icon, give the app any nickname,
   click **"Register app"**. Firebase shows a block of JavaScript starting with
   `const firebaseConfig = { ... }`. Copy those key/value pairs.
7. Open `webexp/firebase-config.js` in this repo and paste the real values over the
   `"PASTE_YOUR_..."` placeholders. All of these values (`apiKey` included) are meant to be public —
   they identify *which* Firebase project to talk to, not a secret credential. The rules you
   published in step 5 are what actually stop anyone else from reading or abusing the data.

That's the entire backend. No server to deploy, no server to keep running.

## 2. Publish the page on GitHub Pages (≈5 minutes, one-time)

1. Create a **new, separate** GitHub repository (don't reuse the main research-code repo — this
   one will be public, and keeping them separate means nobody browsing your analysis code stumbles
   into the participant-facing page, and vice versa). On github.com: **New repository** → any name
   (e.g. `sama-remote-arm`) → **Public** (GitHub Pages is free only on public repos for a personal
   account) → Create.
2. Push the contents of this repo's `webexp/` folder to that new repository's root (so
   `index.html` sits at the top level, not inside a `webexp/` subfolder there):
   ```
   cd webexp
   git init
   git add .
   git commit -m "Remote pilot page"
   git branch -M main
   git remote add origin https://github.com/<you>/sama-remote-arm.git
   git push -u origin main
   ```
3. On GitHub, open the new repo's **Settings → Pages**. Under "Build and deployment", set
   **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**. Save.
4. After a minute or two, GitHub shows the live URL, normally
   `https://<you>.github.io/sama-remote-arm/`. That is the link you send participants.
5. Nothing participant-specific (recordings, ratings) ever gets committed to this repo — only the
   code. Data goes straight from the participant's browser to Firebase, never through GitHub.

**Give each participant their own link** by appending `?pid=P101` (etc.) to the URL, e.g.
`https://<you>.github.io/sama-remote-arm/?pid=P101`. If you don't supply `?pid=`, the page
generates a random one itself and shows it on the final screen — usable, but harder to track who's
who, so supplying it is recommended.

## 3. Test it before sending it to anyone

**Automated test (run this first, every time you change `webexp/` code):**
```
pip install playwright && playwright install chromium   # one-time; already present in this dev container
python3 webexp/test_webexp_e2e.py
```
This drives a real (headless) browser through all six scenarios — successful upload, upload
failure falling back to local save, automatic retry on a later visit, fully offline, camera
permission denied, unsupported browser — using a fake camera and a mocked Firebase backend, so it
needs no real project and makes no real network calls. It should print
`ALL WEBEXP E2E CHECKS PASSED`.

**Manual test, with your real Firebase project (do this once before the first real participant):**
1. Open the GitHub Pages URL yourself, in a normal browser window, with your own webcam.
2. Go through the whole flow once for real: consent → allow camera → instructions → the five
   protocol blocks → rate yourself on the Monk scale and the Fitzpatrick question → submit.
3. In the Firebase console, check **Storage** for a new folder under
   `sessions/SAMA-REMOTE-2026/<your-test-pid>/` containing `webcam.webm` and `metadata.json`, and
   check **Firestore Database → Data** for a matching document under `sessions`. Delete this test
   entry afterward so it doesn't get mixed into real data.
4. Test the offline path for real: open your browser's DevTools (F12) → **Network** tab → set
   throttling to **"Offline"** → reload the page → go through the flow again → confirm it ends on
   "Saved on this device" rather than erroring. Then set throttling back to **"No throttling"** and
   reload the page again (don't need to redo the flow) — within a few seconds it should
   auto-upload that saved session in the background with no further clicks; you can confirm the
   same way as step 3.
5. Test on an actual phone/laptop you don't normally use, on an unfamiliar network, to catch
   anything specific to a device or browser you haven't tried (see the troubleshooting table below
   for the most likely issues).

## 4. Collecting what comes in

Nothing needs to be "sent back to you" — it's already in your Firebase project. When you want to
analyze a batch:
1. Firebase console → **Storage** → browse into `sessions/SAMA-REMOTE-2026/`. There is one folder
   per participant ID, each with `webcam.webm` (or `.mp4`) and `metadata.json`. Select the ones you
   want and use the **Download** button (or select a folder's files individually — the console
   doesn't offer one-click folder ZIP download, so for many participants at once the
   [`gsutil` or `firebase-tools` CLI](https://firebase.google.com/docs/storage/web/download-files)
   is faster, but isn't required for a small pilot).
2. Arrange the downloaded files into one folder with a subfolder per participant:
   ```
   downloads/
     P101/
       webcam.webm
       metadata.json
     P102/
       webcam.webm
       metadata.json
   ```
3. Run the importer, which converts these into the same session-folder layout the rest of the
   pipeline already reads:
   ```
   python pilot/tools/import_remote.py downloads --out pilot_data_REMOTE
   ```
   This writes `pilot_data_REMOTE/sessions/<pid>/session.json` + `events.csv`, and appends a row
   to `pilot_data_REMOTE/participants.csv` with `monk_self` and `fitzpatrick_self` taken from the
   participant's own ratings. It never writes a `monk_ratings.csv` row — there is no external
   rater in this arm, only self-report, and that's an honest limitation, not a bug (see §6).
4. **Analyze the remote arm as a separate pilot run**, not mixed into the lab pilot's
   `pilot_data/`. Two reasons: there's no grey card, so the color-correction/compression "ladder"
   (`pilot.ladder`) has nothing lossless to build from, and there's no reference HR/HRV signal.
   ```
   python -m sama prepare --set paths.pilot_root=pilot_data_REMOTE
   python -m sama qc      --set paths.pilot_root=pilot_data_REMOTE
   python -m sama pilot   --set paths.pilot_root=pilot_data_REMOTE \
                          --set paths.outputs=results/pilot_remote \
                          --set pilot.ladder.enabled=false \
                          --set ita.source=monk --set raters.n=1
   ```
   No changes to `sama/pilot.py` are needed for this — it already falls back to Monk-based
   stratification whenever a session has no grey-card reading, which is every remote session.

## 5. Ethics approval — before any real participant uses the link

The remote arm records a different kind of data under different conditions (unsupervised, in the
participant's own home, with only a self-reported skin-tone rating instead of a trained rater, and
a compressed rather than lossless video). Treat this as requiring its own amendment to the existing
pilot ethics application (`pilot/forms/06_ethics_pilot_application.md`) rather than assuming the
lab-pilot approval already covers it. Two placeholders in `webexp/index.html`'s consent screen —
`[TO FILL: researcher email]` and `[TO FILL: ethics committee reference]` — must be replaced with
real values once that approval is in hand, before the link goes to anyone outside your own testing.

## 6. What this arm can and can't tell you (be upfront about this)

Compared to the lab pilot, the remote arm trades supervision for reach. Be explicit about this in
any write-up:
- **No physiological reference signal.** The lab pilot's oximeter/ECG ground truth has no remote
  equivalent — there's nothing to validate rPPG estimates against here.
- **No external Monk rating.** Only the participant's own self-rating (Monk swatch + Fitzpatrick
  question) is collected; `monk_ratings.csv` is intentionally never populated for these sessions.
- **Compressed, not lossless, video.** Browser recording is `vp9`/`vp8`/H.264-encoded in real
  time; there's no camera-sensor-level capture to run the compression ladder against, so that
  analysis step is skipped (`pilot.ladder.enabled=false`) for this arm, not silently applied.
- **No controlled lighting or card-based white balance.** The protocol's `lighting_self_report`
  field is the only lighting information you get.
- **Self-paced, unsupervised protocol.** The consultation/arithmetic blocks are self-read rather
  than operator-delivered, which likely adds more behavioral variability than the lab version.

None of this makes the remote data useless — it's a legitimate, clearly-labeled different
condition — but presenting it as equivalent to the lab pilot would overstate what was measured.

---

## 7. Troubleshooting / anticipated bugs

| Symptom | Likely cause | Fix |
|---|---|---|
| Page loads but camera never starts, no error shown | Browser blocked camera silently (common on `http://` rather than `https://` — GitHub Pages is always `https://`, so this is more likely a corporate/managed-device policy blocking camera access site-wide) | Ask the participant to check their browser's camera permission icon in the address bar; try a different browser |
| "Camera access was blocked" message | Participant clicked "Block" on the permission prompt, or denied it previously | They can reset the permission: click the camera/lock icon in the address bar → allow camera → reload the page |
| Works on desktop Chrome, breaks on an iPhone | iOS Safari historically has had partial/buggy `MediaRecorder` support, and only supports it from Safari 14.3+ | `pickMimeType()` in `app.js` already checks `MediaRecorder.isTypeSupported()` and falls back through `vp9`→`vp8`→`mp4`; if iOS Safari offers none of these, the page shows the "can't run this" screen rather than a silent failure — tell participants to use a recent Chrome/Edge/Firefox/Safari, ideally on a laptop |
| Recording works, but upload never happens even though the participant says they're online | A captive portal (hotel/airport wifi) can pass the `generate_204` reachability probe's *connection* while still blocking the actual Firebase domains, or vice versa; also check Firebase free-tier (Spark plan) daily quota hasn't been hit | Check Firebase console **Usage** tab for quota; the session is never lost either way — it's sitting in that browser's IndexedDB and will upload automatically next time that device is online, or can be exported with `app.js`'s local-save fallback |
| "CORS error" in browser console when uploading | Usually means the Storage bucket name in `firebase-config.js` doesn't match the real project, or the rules weren't published | Double check `storageBucket` in `firebase-config.js` against the Firebase console's project settings; confirm `storage.rules` shows "Published" (not just saved) in the console |
| Participant closes the tab mid-recording | By design, nothing is saved — the recording is only finalized when they reach the end and submit ratings | If this is a real risk for your population, consider telling participants up front not to close the tab, and treat an incomplete session as a non-event (no partial data is silently kept) |
| Same participant opens the link twice (retake) | Each visit generates/reuses the `?pid=` in the URL; a second full run with the same `pid` will upload again to Storage (same path, new timestamp subfolder isn't created — it will attempt to write the same filename) | Firestore rules block `update` to an existing document, so a genuine duplicate `pid` will fail at the Firestore step and fall back to local save; give each participant a *distinct* `?pid=` link to avoid this entirely |
| Large video won't finish uploading on a slow connection | An 8–9 minute 720p webm is usually tens of MB, which can be slow on poor connections | The upload uses `uploadBytesResumable`, which resumes rather than restarting from zero on a dropped connection within the same page load; if the tab is closed before it finishes, the session falls back to local save and retries on the next visit |
| You see a session in IndexedDB that never uploads even though the device looks online | The device might be on a network that reaches `generate_204` (used for the connectivity probe) but not `firebasestorage.googleapis.com` specifically (e.g. some restrictive school/corporate networks) | This is rare but possible; the only fix is a different network — the data isn't lost, it's safe in that browser until it can reach Firebase |

---

## 8. Participant FAQ

Feel free to copy this (or adapt the wording) into whatever you send participants along with the
link.

**What do I need to do this?**
A laptop, tablet, or phone with a working webcam and a reasonably modern web browser (Chrome,
Edge, Firefox, or Safari, updated within the last year or so). No installation, no account, no
app download.

**What does the study record?**
A short video of your face (around 8–9 minutes) — from a laptop/desktop webcam or a mobile phone propped on a stable surface — while you do a few simple things — sit still,
relax, read a few lines out loud, count backwards, relax again — plus a few quick self-report questions (skin tone, lighting, and which device you used), and some basic technical details (what kind of webcam your device has, what time
of day it is, roughly where your device is located by timezone). It does not record audio
separately from what's in the video, and it does not access anything else on your device.

**Do I need to install anything?**
No. Just open the link in your browser.

**Do I need an internet connection?**
No — you can do the whole thing offline. If you have a connection when you finish, it saves
immediately. If you don't, it saves safely on your own device and uploads automatically the next
time you open the same link while connected. You don't need to do anything differently either way
— the page figures this out on its own.

**Is my video sent anywhere while I'm offline?**
No. Nothing leaves your device until there is an actual internet connection, and even then only to
the study's secure storage — nothing is sent anywhere else.

**What if I make a mistake, or want to stop partway through?**
You can close the browser tab at any time before you finish; nothing partial gets saved or sent in
that case. If you've already submitted and want your data removed afterward, contact
`[TO FILL: researcher email]` with your participant ID (shown on the final screen).

**Who can see my video?**
Only the research team can access it, through the study's private, access-controlled storage. It
is used only for the purposes described in the consent you saw at the start.

**My camera isn't turning on — what do I do?**
Check that you clicked "Allow" when your browser asked for camera permission. If you accidentally
clicked "Block," look for a camera icon in your browser's address bar, click it, and change the
permission to "Allow," then reload the page. If it still doesn't work, try a different browser.

**The page says my browser isn't supported — now what?**
Try the latest version of Chrome, Edge, Firefox, or Safari. This is rare and usually only affects
older or unusual browsers.
