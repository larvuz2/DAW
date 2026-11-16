// One animation-frame loop for everything that follows the audio thread on screen (live dots on knobs, source
// meters): a control registers a function, the loop runs while anything is registered, and nothing re-renders React.
const subscribers = new Set();
let frame = 0;

function tick() {
  frame = 0;
  for (const fn of subscribers) fn();
  if (subscribers.size) frame = requestAnimationFrame(tick);
}

/** Call fn on every animation frame; returns the function that stops it. */
export function onFrame(fn) {
  subscribers.add(fn);
  if (!frame) frame = requestAnimationFrame(tick);
  return () => { subscribers.delete(fn); };
}
