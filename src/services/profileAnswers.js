/**
 * "No" as an answer to a profile question.
 *
 * A freelancer with no fixed hours, an artist with nothing they can show yet,
 * somebody without a Roblox account — each has answered the question, and the
 * roster should stop asking. The words below are the ways people actually say
 * it in a form box.
 *
 * Declines are recorded by question key in `staff.profile_declined` rather than
 * written into the field, so data other code reads — hours above all — never
 * holds a word where it expects a value. See migration 019.
 */

const DECLINE = /^(no|nope|none|nothing|n\/?a|na|nil|null|-+|—|x|not yet|dont have|don't have|i don'?t have|no thanks)\.?!?$/i;

/** True when the text is somebody saying "I don't have one". */
function isDecline(value) {
  return DECLINE.test(String(value ?? '').trim());
}

function declinedSet(staff) {
  return new Set(String(staff?.profile_declined || '').split(',').map((key) => key.trim()).filter(Boolean));
}

/** The column value with `key` added or removed, sorted so it is stable. */
function withDecline(staff, key, declined) {
  const set = declinedSet(staff);
  if (declined) set.add(key); else set.delete(key);
  return set.size > 0 ? [...set].sort().join(',') : null;
}

/**
 * Turns one form box into what to store.
 *
 * Blank clears both the value and any earlier "no", because an empty box is
 * somebody taking the answer back, not repeating it.
 */
function readAnswer(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, declined: false };
  if (isDecline(text)) return { value: null, declined: true };
  return { value: text, declined: false };
}

module.exports = { DECLINE, isDecline, declinedSet, withDecline, readAnswer };
