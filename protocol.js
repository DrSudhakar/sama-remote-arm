// The unsupervised remote protocol. Adapted from pilot/PROTOCOL.md for a participant who is alone,
// has no card/chart/oximeter, and cannot be told "mistake, start again" by an operator. One
// continuous recording, one light (whatever the participant has), self-paced blocks. Durations are
// seconds. "prompt" is shown on screen; "speak" blocks ask the participant to read a line aloud
// (keeps the mouth/face moving like a real teleconsultation, without needing a live listener).
export const PROTOCOL = [
  { name: "motion_check", seconds: 30, title: "Hold still, then nod",
    prompt: "Sit still and look at the camera for 20 seconds. Then nod your head gently a few times for the last 10 seconds." },
  { name: "rest", seconds: 120, title: "Rest quietly",
    prompt: "Sit quietly, breathe normally, and look at the screen. No need to talk." },
  { name: "consultation", seconds: 150, title: "Read these out loud",
    prompt: "Imagine a doctor just asked you these questions over a video call. Read each one and answer it out loud, in your own words, one at a time:",
    lines: ["What brings you here today?", "When did it start?", "Any fever, cough or cold in the last week?",
            "Are you taking any medicines?", "How have you been sleeping?", "How is your appetite?",
            "Do you exercise regularly?", "Any headaches recently?", "Anything else you'd like to tell the doctor?"] },
  { name: "arithmetic", seconds: 100, title: "Count backwards",
    prompt: "Count backwards out loud from 1000 in steps of 7 (1000, 993, 986 ...) for as long as this block lasts. If you lose track, just start again from 1000 — that's fine." },
  { name: "recovery", seconds: 120, title: "Rest again",
    prompt: "Sit quietly again, breathe normally, and look at the screen. Almost done." },
];

export const TOTAL_SECONDS = PROTOCOL.reduce((s, b) => s + b.seconds, 0);
