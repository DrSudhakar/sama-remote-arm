// Paste your own Firebase project's config here (Firebase console -> Project settings -> General
// -> Your apps -> SDK setup and configuration -> "Config"). These values are NOT secret: they only
// say which project to talk to. What actually protects participant data is the security rules
// (firestore.rules, storage.rules) you publish from the console -- see REMOTE_PILOT_GUIDE.md.
export const FIREBASE_CONFIG = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT",
  storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID",
};

// A short code shown to participants and stamped on every file. Change it per study if you reuse
// this page for something else later.
export const STUDY_ID = "SAMA-REMOTE-2026";
