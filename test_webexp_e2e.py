"""End-to-end test of webexp/ in a real (headless) browser, with a fake camera and a mocked
Firebase backend -- no real Firebase project or network access needed.

Run:  python3 webexp/test_webexp_e2e.py
Needs: pip install playwright && playwright install chromium   (already present in dev containers
that ship Playwright pre-installed; this repo's own dev environment has it).

What it checks, so a change to app.js can't silently break the field behaviour:
  1. consent -> camera -> recording -> rating -> upload, when a connection is genuinely reachable
     and the (mocked) Firebase upload succeeds: lands on the "Thank you" screen, uploads the video
     AND a metadata.json sidecar to the right path, and writes a Firestore-style doc with the
     ratings and the full event log.
  2. the connection looks reachable but the upload call itself fails (e.g. wrong Firebase config,
     a dropped connection mid-upload): falls back to saving in IndexedDB on this device, and does
     NOT lose the recording.
  3. a participant with no connection at all: saves straight to IndexedDB, no failed network calls.
  4. that same device, reopened later while connected (no participant action): the pending session
     uploads itself in the background and is cleared from IndexedDB.
  5. camera permission denied: a clear on-screen message, no crash.
  6. a browser without MediaRecorder/getUserMedia: the "can't run this" screen, not a crash.
  7. the REAL, unmodified files as shipped (not the test's short-protocol stand-in) load without
     a module error and the consent checkbox actually enables the Start button. Checks 1-6 copy
     every file except protocol.js, which they replace with a short test version for speed -- so a
     bug only in the real protocol.js/firebase-config.js (e.g. a missing `export`, caught here
     after shipping once already: see DECISIONS.md) would not show up in 1-6 at all.
"""
from __future__ import annotations

import http.server
import pathlib
import shutil
import socketserver
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PORT = 8911

SHORT_PROTOCOL = """\
// test-only: short durations so the whole protocol finishes in a few seconds
export const PROTOCOL = [
  { name: "motion_check", seconds: 1, title: "Hold still, then nod", prompt: "test" },
  { name: "rest", seconds: 1, title: "Rest quietly", prompt: "test" },
  { name: "consultation", seconds: 1, title: "Read these out loud", prompt: "test", lines: ["q1", "q2"] },
  { name: "arithmetic", seconds: 1, title: "Count backwards", prompt: "test" },
  { name: "recovery", seconds: 1, title: "Rest again", prompt: "test" },
];
export const TOTAL_SECONDS = PROTOCOL.reduce((s, b) => s + b.seconds, 0);
"""

FAKE_APP = "export function initializeApp(cfg) { window.__initCfg = cfg; return {app: true}; }"
FAKE_FIRESTORE = """
export function getFirestore(app) { return {db: true}; }
export function doc(db, col, id) { return {col, id}; }
export function setDoc(ref, data) { window.__setDocCalls = (window.__setDocCalls||[]).concat([{ref, data}]); return Promise.resolve(); }
"""
FAKE_STORAGE_OK = """
export function getStorage(app) { return {storage: true}; }
export function ref(storage, path) { return {path}; }
export function uploadBytesResumable(ref, blob, meta) {
  window.__uploadCalls = (window.__uploadCalls||[]).concat([{path: ref.path, size: blob.size, type: blob.type, meta}]);
  return { on(event, onProgress, onError, onComplete) {
      if (onProgress) onProgress({bytesTransferred: blob.size, totalBytes: blob.size});
      setTimeout(onComplete, 10);
  }};
}
"""
FAKE_STORAGE_FAIL = """
export function getStorage(app) { return {storage: true}; }
export function ref(storage, path) { return {path}; }
export function uploadBytesResumable(ref, blob, meta) {
  return { on(event, onProgress, onError, onComplete) { setTimeout(() => onError(new Error("simulated network failure")), 10); } };
}
"""
SDK = "10.12.2"
BASE = f"https://www.gstatic.com/firebasejs/{SDK}"


def route_firebase(page, storage_body):
    page.route("https://www.gstatic.com/generate_204", lambda r: r.fulfill(status=204, body=""))
    page.route(f"{BASE}/firebase-app.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE_APP))
    page.route(f"{BASE}/firebase-firestore.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE_FIRESTORE))
    page.route(f"{BASE}/firebase-storage.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=storage_body))


def pending_pids(page):
    return page.evaluate("""
      () => new Promise((resolve) => {
        const req = indexedDB.open('sama_remote_pending', 1);
        req.onsuccess = () => {
          const db = req.result; const tx = db.transaction('sessions', 'readonly'); const items = [];
          const c = tx.objectStore('sessions').openCursor();
          c.onsuccess = () => { const cur = c.result; if (cur) { items.push(cur.value.pid); cur.continue(); } else resolve(items); };
        };
      })""")


def run_flow(page, url, label):
    page.goto(url)
    page.check("#agreeBox")
    page.click("#startBtn")
    page.wait_for_selector("#toInstructionsBtn:not([hidden])", timeout=10000)
    assert page.is_hidden("#cameraError"), f"[{label}] camera error shown unexpectedly"
    page.click("#toInstructionsBtn")
    page.wait_for_selector("#screen-instructions:not([hidden])")
    page.click("#beginRecBtn")
    page.wait_for_selector("#screen-rating:not([hidden])", timeout=15000)
    page.click(".swatch:nth-child(3)")
    page.check('input[name="fitzQ1"][value="sometimes_burns"]')
    page.check('input[name="lightQ"][value="room_light"]')
    page.check('input[name="deviceQ"][value="mobile_stable"]')
    assert not page.is_disabled("#submitRatingBtn"), f"[{label}] submit should be enabled"
    page.click("#submitRatingBtn")
    page.wait_for_selector("#screen-done:not([hidden])", timeout=15000)
    return page.inner_text("#doneTitle"), page.inner_text("#pidShown")


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="webexp_e2e_"))
    for f in ("index.html", "style.css", "app.js", "firebase-config.js"):
        shutil.copy(HERE / f, tmp / f)
    (tmp / "protocol.js").write_text(SHORT_PROTOCOL)

    real_tmp = pathlib.Path(tempfile.mkdtemp(prefix="webexp_e2e_real_"))
    for f in ("index.html", "style.css", "app.js", "protocol.js", "firebase-config.js"):
        shutil.copy(HERE / f, real_tmp / f)

    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(tmp), **kw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}/index.html"
    REAL_PORT = PORT + 1
    httpd_real = socketserver.TCPServer(("127.0.0.1", REAL_PORT), lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(real_tmp), **kw))
    threading.Thread(target=httpd_real.serve_forever, daemon=True).start()
    real_url = f"http://127.0.0.1:{REAL_PORT}/index.html"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])

            # Check 7 first: the real shipped files, completely unmodified, must load without a
            # module error (e.g. a missing `export`) and the consent flow must actually work --
            # this is what a participant's browser runs, not what checks 1-6 run.
            ctx = browser.new_context()
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.goto(real_url)
            page.check("#agreeBox")
            page.wait_for_timeout(50)
            assert not page.is_disabled("#startBtn"), \
                f"Start button never enabled after checking consent on the REAL shipped files -- " \
                f"console errors: {errors}"
            assert not errors, f"console error(s) loading the real shipped webexp/ files: {errors}"
            print("[7/7] real shipped files load cleanly, consent checkbox enables Start: OK")
            ctx.close()

            ctx = browser.new_context(permissions=["camera"])
            page = ctx.new_page()
            route_firebase(page, FAKE_STORAGE_OK)
            title, pid = run_flow(page, url, "ONLINE-SUCCESS")
            assert "Thank you" in title, title
            uploads, setdocs = page.evaluate("window.__uploadCalls"), page.evaluate("window.__setDocCalls")
            assert len(uploads) == 2, uploads
            assert uploads[0]["path"] == f"sessions/SAMA-REMOTE-2026/{pid}/webcam.webm", uploads[0]
            assert uploads[1]["path"] == f"sessions/SAMA-REMOTE-2026/{pid}/metadata.json", uploads[1]
            assert setdocs[0]["data"]["ratings"]["monk"] == 3
            assert setdocs[0]["data"]["ratings"]["capture_device"] == "mobile_stable", setdocs[0]["data"]["ratings"]
            assert "mobile_ua" in setdocs[0]["data"]["device"]["detected_class"], setdocs[0]["data"]["device"]
            assert len(setdocs[0]["data"]["events"]) >= 10
            print("[1/7] online + upload succeeds: OK")
            ctx.close()

            ctx = browser.new_context(permissions=["camera"])
            page = ctx.new_page()
            route_firebase(page, FAKE_STORAGE_FAIL)
            title, pid = run_flow(page, url, "UPLOAD-FAILS")
            assert "Saved on this device" in title, title
            assert pid in pending_pids(page)
            print("[2/7] connection reachable but upload call fails -> local fallback: OK")

            page.unroute(f"{BASE}/firebase-storage.js")
            route_firebase(page, FAKE_STORAGE_OK)
            page.goto(url)
            page.wait_for_function("window.__setDocCalls && window.__setDocCalls.length > 0", timeout=10000)
            page.wait_for_timeout(200)
            assert pid not in pending_pids(page), "background retry did not clear the pending session"
            print("[3/7] reopened later while online -> auto-uploads with no participant action: OK")
            ctx.close()

            ctx = browser.new_context(permissions=["camera"])
            page = ctx.new_page()
            page.goto(url)
            ctx.set_offline(True)
            page.check("#agreeBox"); page.click("#startBtn")
            page.wait_for_selector("#toInstructionsBtn:not([hidden])", timeout=10000)
            page.click("#toInstructionsBtn")
            page.click("#beginRecBtn")
            page.wait_for_selector("#screen-rating:not([hidden])", timeout=15000)
            page.click(".swatch:nth-child(3)")
            page.check('input[name="fitzQ1"][value="sometimes_burns"]')
            page.check('input[name="lightQ"][value="room_light"]')
            page.check('input[name="deviceQ"][value="mobile_stable"]')
            page.click("#submitRatingBtn")
            page.wait_for_selector("#screen-done:not([hidden])", timeout=15000)
            assert "Saved on this device" in page.inner_text("#doneTitle")
            print("[4/7] no network at all: saves locally, no crash: OK")
            ctx.close()

            ctx = browser.new_context()
            page = ctx.new_page()
            page.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), {name: 'NotAllowedError'}));")
            page.goto(url)
            page.check("#agreeBox"); page.click("#startBtn")
            page.wait_for_selector("#cameraError:not([hidden])", timeout=10000)
            msg = page.inner_text("#cameraError").lower()
            assert "camera" in msg or "permission" in msg, msg
            print("[5/7] camera permission denied: clear message, no crash: OK")
            ctx.close()

            ctx = browser.new_context()
            page = ctx.new_page()
            page.add_init_script("delete window.MediaRecorder;")
            page.goto(url)
            page.wait_for_selector("#screen-unsupported:not([hidden])", timeout=5000)
            print("[6/7] unsupported browser: shows the fallback screen, no crash: OK")
            ctx.close()

            browser.close()
    finally:
        httpd.shutdown()
        httpd_real.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(real_tmp, ignore_errors=True)
    print("ALL WEBEXP E2E CHECKS PASSED")


if __name__ == "__main__":
    sys.exit(main())
