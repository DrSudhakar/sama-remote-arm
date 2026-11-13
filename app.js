// SAMA remote pilot: a single static page, no build step, no install for the participant.
// Flow: consent -> camera check -> instructions -> recording (protocol.js) -> self-rating ->
// save (Firebase if a connection can be reached right now, else IndexedDB on this device, with
// automatic retry next time this exact link is opened on this device while online).
import { PROTOCOL, TOTAL_SECONDS } from "./protocol.js";
import { FIREBASE_CONFIG, STUDY_ID } from "./firebase-config.js";

// Same ten swatches as sama/monk.py MST_HEX -- keep the two in sync if you ever change one.
const MST_HEX = ["#f6ede4", "#f3e7db", "#f7ead0", "#eadaba", "#d7bd96", "#a07e56", "#825c43", "#604134", "#3a312a", "#292420"];
const FIREBASE_SDK = "10.12.2";

const $ = (id) => document.getElementById(id);
function show(id) { document.querySelectorAll(".screen").forEach((s) => { s.hidden = true; }); $(id).hidden = false; }

const S = { pid: null, stream: null, recorder: null, chunks: [], mimeType: null, t0: null, events: [],
            monk: null, fitz: null, light: null, device: null, blob: null, deviceInfo: null, consentTime: null };

// ------------------------------------------------------------------ participant id
function randomPid() {
  if (window.crypto && crypto.randomUUID) return "P-" + crypto.randomUUID().slice(0, 8);
  return "P-" + Math.random().toString(16).slice(2, 10);
}
function newPid() {
  const u = new URLSearchParams(location.search);
  const given = (u.get("pid") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return given || randomPid();
}

// ------------------------------------------------------------------ feature / format detection
function supportedBrowser() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.indexedDB);
}
function pickMimeType() {
  const cands = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  for (const c of cands) if (window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  return "";
}
function safeCall(fn) { try { return fn(); } catch { return null; } }
function connectionInfo() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return c ? { effectiveType: c.effectiveType, downlink: c.downlink, saveData: !!c.saveData } : null;
}

// ------------------------------------------------------------------ consent screen
$("agreeBox").addEventListener("change", (e) => { $("startBtn").disabled = !e.target.checked; });
$("declineLink").addEventListener("click", (e) => { e.preventDefault(); show("screen-decline"); });
$("startBtn").addEventListener("click", async () => {
  S.pid = newPid();
  S.consentTime = new Date().toISOString();
  show("screen-camera");
  await openCamera();
});

// ------------------------------------------------------------------ camera check
async function openCamera() {
  $("cameraError").hidden = true;
  $("retryCameraBtn").hidden = true;
  $("toInstructionsBtn").hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false,
    });
    S.stream = stream;
    $("checkVideo").srcObject = stream;
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? safeCall(() => track.getSettings()) || {} : {};
    const caps = track.getCapabilities ? safeCall(() => track.getCapabilities()) : null;
    S.deviceInfo = {
      label: track.label || null, settings, capabilities: caps,
      user_agent: navigator.userAgent, platform: navigator.platform || null,
      languages: navigator.languages || [navigator.language],
      screen: { width: screen.width, height: screen.height, device_pixel_ratio: window.devicePixelRatio },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      connection: connectionInfo(),
      detected_class: detectDeviceClass(),
    };
    $("toInstructionsBtn").hidden = false;
  } catch (err) {
    $("cameraError").hidden = false;
    $("cameraError").textContent = cameraErrorMessage(err);
    $("retryCameraBtn").hidden = false;
  }
}
// A best-effort guess from the browser, stored next to (never instead of) the participant's own
// answer to "which device did you use?", so a mismatch between the two can be spotted later.
function detectDeviceClass() {
  const uad = navigator.userAgentData;
  const mobileUA = uad && typeof uad.mobile === "boolean" ? uad.mobile
    : /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return { mobile_ua: !!mobileUA, max_touch_points: navigator.maxTouchPoints || 0,
           coarse_pointer: !!(window.matchMedia && matchMedia("(pointer: coarse)").matches) };
}
function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError")
    return "Camera permission was denied. Click the camera/lock icon in your browser's address bar, allow the camera for this site, then try again.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera was found on this device.";
  if (name === "NotReadableError" || name === "TrackStartError")
    return "The camera could not be started — another app or tab may be using it. Close other video apps/tabs and try again.";
  return "Could not open the camera: " + (err && err.message ? err.message : String(err));
}
$("retryCameraBtn").addEventListener("click", openCamera);
$("toInstructionsBtn").addEventListener("click", () => {
  $("totalMin").textContent = Math.round(TOTAL_SECONDS / 60);
  show("screen-instructions");
});

// ------------------------------------------------------------------ recording
$("beginRecBtn").addEventListener("click", startRecording);

function logEvent(type, extra) {
  S.events.push(Object.assign({ t: +((performance.now() - S.t0) / 1000).toFixed(3), wall: new Date().toISOString(), type }, extra || {}));
}
function beforeUnloadWarn(e) { e.preventDefault(); e.returnValue = ""; }
document.addEventListener("visibilitychange", () => {
  if (S.recorder && S.recorder.state === "recording") logEvent("visibility_" + document.visibilityState);
});

function startRecording() {
  show("screen-recording");
  $("recVideo").srcObject = S.stream;
  S.mimeType = pickMimeType();
  S.chunks = [];
  S.events = [];
  S.recorder = new MediaRecorder(S.stream, S.mimeType ? { mimeType: S.mimeType } : undefined);
  S.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) S.chunks.push(e.data); };
  S.t0 = performance.now();
  window.addEventListener("beforeunload", beforeUnloadWarn);
  S.recorder.start(1000);
  logEvent("recording_start");
  runBlock(0);
}

function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

function runBlock(i) {
  if (i >= PROTOCOL.length) return finishRecording();
  const b = PROTOCOL[i];
  logEvent("block_start", { block: b.name });
  $("blockTitle").textContent = b.title;
  $("blockPrompt").textContent = b.prompt;
  const linesEl = $("blockLines");
  linesEl.innerHTML = "";
  if (b.lines) b.lines.forEach((l) => { const li = document.createElement("li"); li.textContent = l; linesEl.appendChild(li); });
  const perLine = b.lines ? b.seconds / b.lines.length : null;
  let remaining = b.seconds;
  const tick = () => {
    $("blockTimer").textContent = fmtTime(remaining);
    if (b.lines) {
      const idx = Math.min(b.lines.length - 1, Math.floor((b.seconds - remaining) / perLine));
      [...linesEl.children].forEach((li, k) => li.classList.toggle("active", k === idx));
    }
    if (remaining <= 0) {
      clearInterval(timer);
      logEvent("block_end", { block: b.name });
      runBlock(i + 1);
      return;
    }
    remaining -= 1;
  };
  tick();
  const timer = setInterval(tick, 1000);
}

function finishRecording() {
  window.removeEventListener("beforeunload", beforeUnloadWarn);
  logEvent("recording_stop");
  S.recorder.onstop = () => {
    S.blob = new Blob(S.chunks, { type: S.mimeType || "video/webm" });
    S.stream.getTracks().forEach((t) => t.stop());
    buildMonkSwatches();
    show("screen-rating");
  };
  S.recorder.stop();
}

// ------------------------------------------------------------------ rating screen
function buildMonkSwatches() {
  const el = $("monkSwatches");
  el.innerHTML = "";
  MST_HEX.forEach((hex, i) => {
    const d = document.createElement("div");
    d.className = "swatch"; d.style.background = hex; d.title = "Monk " + (i + 1);
    d.addEventListener("click", () => {
      [...el.children].forEach((c) => c.classList.remove("selected"));
      d.classList.add("selected"); S.monk = i + 1; checkRatingComplete();
    });
    el.appendChild(d);
  });
}
document.querySelectorAll('input[name="fitzQ1"]').forEach((r) => r.addEventListener("change", () => { S.fitz = r.value; checkRatingComplete(); }));
document.querySelectorAll('input[name="lightQ"]').forEach((r) => r.addEventListener("change", () => { S.light = r.value; checkRatingComplete(); }));
document.querySelectorAll('input[name="deviceQ"]').forEach((r) => r.addEventListener("change", () => { S.device = r.value; checkRatingComplete(); }));
function checkRatingComplete() { $("submitRatingBtn").disabled = !(S.monk && S.fitz && S.light && S.device); }
$("submitRatingBtn").addEventListener("click", () => { show("screen-saving"); saveSession(); });

// ------------------------------------------------------------------ connectivity probe
function quickConnectivityProbe(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!navigator.onLine) return resolve(false); // definitely offline; skip the round trip
    const ctrl = new AbortController();
    const to = setTimeout(() => { ctrl.abort(); resolve(false); }, timeoutMs);
    fetch("https://www.gstatic.com/generate_204", { mode: "no-cors", cache: "no-store", signal: ctrl.signal })
      .then(() => { clearTimeout(to); resolve(true); })
      .catch(() => { clearTimeout(to); resolve(false); });
  });
}

// ------------------------------------------------------------------ Firebase upload
async function uploadToFirebase(pid, blob, mimeType, meta, onProgress) {
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-app.js`);
  const { getFirestore, doc, setDoc } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-firestore.js`);
  const { getStorage, ref, uploadBytesResumable } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-storage.js`);
  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const storage = getStorage(app);
  const ext = (mimeType || "").includes("mp4") ? "mp4" : "webm";
  const path = `sessions/${STUDY_ID}/${pid}/webcam.${ext}`;
  await new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), blob, { contentType: mimeType || "video/webm" });
    task.on("state_changed", (snap) => { if (onProgress) onProgress(snap.bytesTransferred / snap.totalBytes); }, reject, resolve);
  });
  const stamped = Object.assign({}, meta, { video_path: path, uploaded_at: new Date().toISOString() });
  // Also store the metadata as a plain .json file right next to the video, in Storage (not only in
  // Firestore): this lets a non-engineer download both files for a participant straight from the
  // Firebase console's Storage tab (a File-Explorer-style "download" button), with no code and no
  // separate Firestore export step. See webexp/REMOTE_PILOT_GUIDE.md "Collecting what came in".
  const metaPath = `sessions/${STUDY_ID}/${pid}/metadata.json`;
  const metaBlob = new Blob([JSON.stringify(stamped, null, 1)], { type: "application/json" });
  await new Promise((resolve, reject) => {
    uploadBytesResumable(ref(storage, metaPath), metaBlob, { contentType: "application/json" }).on("state_changed", () => {}, reject, resolve);
  });
  await setDoc(doc(db, "sessions", pid), stamped);
}

// ------------------------------------------------------------------ IndexedDB fallback (offline)
const DB_NAME = "sama_remote_pending", STORE = "sessions";
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "pid" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveLocally(pid, blob, meta) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ pid, meta, blob, saved_at: Date.now() });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function deleteLocal(pid) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(pid);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } catch { /* best-effort: a failed delete just means it's retried again next time, harmless */ }
}
async function allPending() {
  let db; try { db = await openDb(); } catch { return []; }
  return new Promise((resolve) => {
    const items = [];
    const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { items.push(c.value); c.continue(); } else resolve(items); };
    req.onerror = () => resolve(items);
  });
}

// Opportunistic background retry: runs once on page load and again whenever the browser fires
// 'online'. Only acts on sessions that were already saved to this browser's IndexedDB on an
// earlier, offline visit to this same page on this same device -- it cannot reach into a closed
// browser or a different device, so a participant who never reopens the link must send their
// downloaded file another way (see REMOTE_PILOT_GUIDE.md).
async function retryPendingUploads() {
  if (S.recorder && S.recorder.state === "recording") return; // never interrupt an active session
  const items = await allPending();
  if (!items.length) return;
  if (!(await quickConnectivityProbe(4000))) return;
  for (const item of items) {
    try {
      await uploadToFirebase(item.pid, item.blob, item.meta.recording.mime_type, item.meta);
      await deleteLocal(item.pid);
      console.log("[sama] background-uploaded a previously offline session:", item.pid);
    } catch (e) {
      console.warn("[sama] background retry failed for", item.pid, e);
    }
  }
}

// ------------------------------------------------------------------ save (called after rating)
async function saveSession() {
  const meta = {
    participant_id: S.pid, study_id: STUDY_ID, app_version: "webexp-1.0",
    consent_time: S.consentTime, recorded_at: new Date().toISOString(), device: S.deviceInfo,
    recording: { mime_type: S.mimeType, protocol_duration_s: TOTAL_SECONDS, size_bytes: S.blob.size },
    events: S.events, ratings: { monk: S.monk, fitzpatrick: S.fitz, lighting_self_report: S.light, capture_device: S.device },
  };
  $("progressBar").style.width = "5%";
  $("savingMsg").textContent = "Checking your connection…";
  const online = await quickConnectivityProbe();
  if (online) {
    try {
      await uploadToFirebase(S.pid, S.blob, S.mimeType, meta, (frac) => {
        $("savingMsg").textContent = "Uploading your recording…";
        $("progressBar").style.width = Math.round(100 * frac) + "%";
      });
      $("progressBar").style.width = "100%";
      return doneScreen("uploaded");
    } catch (err) {
      console.warn("[sama] upload failed, saving on this device instead:", err);
    }
  }
  $("savingMsg").textContent = "No connection — saving on this device…";
  await saveLocally(S.pid, S.blob, meta);
  doneScreen("local");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function doneScreen(kind) {
  $("pidShown").textContent = S.pid;
  if (kind === "uploaded") {
    $("doneTitle").textContent = "Thank you!";
    $("doneMsg").textContent = "Your recording uploaded successfully. You're all done — you can close this tab now.";
    $("downloadRow").hidden = true;
  } else {
    $("doneTitle").textContent = "Saved on this device";
    $("doneMsg").textContent = "No internet connection was found just now, so your recording was saved only on this device. "
      + "It will finish uploading by itself the next time you open this exact link on this device while online — you don't "
      + "need to do anything else. If you'd rather send it yourself, you can download it below.";
    $("downloadRow").hidden = false;
    $("downloadBtn").onclick = () => {
      downloadBlob(S.blob, S.pid + ".webm");
      const metaBlob = new Blob([JSON.stringify({ participant_id: S.pid, note: "see console/Firestore schema in REMOTE_PILOT_GUIDE.md" }, null, 1)], { type: "application/json" });
      setTimeout(() => downloadBlob(metaBlob, S.pid + "_details.json"), 300);
    };
  }
  show("screen-done");
}

// ------------------------------------------------------------------ entry point
if (!supportedBrowser()) {
  show("screen-unsupported");
} else {
  retryPendingUploads();
  window.addEventListener("online", retryPendingUploads);
}
