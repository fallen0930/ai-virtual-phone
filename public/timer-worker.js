// timer-worker.js
// Background-safe timer using Web Worker.
// Supports both interval and timeout.
// Main thread sends:
//   { type: "start-interval", id, ms }
//   { type: "start-timeout",  id, ms }
//   { type: "stop", id }
//   { type: "stop-all" }
// Worker sends back { type: "tick", id } on each fire.

const timers = new Map();

self.onmessage = (e) => {
  const { type, id, ms } = e.data;
  if (type === "start-interval") {
    if (timers.has(id)) clearInterval(timers.get(id));
    timers.set(id, setInterval(() => self.postMessage({ type: "tick", id }), ms));
  } else if (type === "start-timeout") {
    if (timers.has(id)) clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      self.postMessage({ type: "tick", id });
    }, ms));
  } else if (type === "stop") {
    if (timers.has(id)) {
      clearTimeout(timers.get(id)); // works for both interval and timeout
      timers.delete(id);
    }
  } else if (type === "stop-all") {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }
};
