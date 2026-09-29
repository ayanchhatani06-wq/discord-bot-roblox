/**
 * Parses a bulk order like "12 models, 4 vfx, 2 animations" into per-department
 * task counts, so one client order becomes the right number of separate tasks
 * routed to the right teams.
 */

const MAX_TASKS_PER_ITEM = 100;

function normalise(word) {
  const lower = String(word).trim().toLowerCase().replace(/[^a-z]/g, '');
  // Crude singularisation is enough here: "models" -> "model", "vfx" unchanged.
  return lower.endsWith('s') && !lower.endsWith('ss') ? lower.slice(0, -1) : lower;
}

/**
 * Matches a written word against a department's key and name. Departments are
 * configurable, so matching is derived from them rather than a fixed list.
 */
function matchDepartment(word, departments) {
  const target = normalise(word);
  if (!target) return null;

  for (const department of departments) {
    const candidates = [normalise(department.key), normalise(department.name)];
    if (candidates.includes(target)) return department;
  }

  // Fall back to a prefix match so "anim" finds "animation" and "model" finds
  // "modelling" without hardcoding those spellings.
  for (const department of departments) {
    const candidates = [normalise(department.key), normalise(department.name)];
    if (candidates.some((candidate) => candidate.startsWith(target) || target.startsWith(candidate))) {
      return department;
    }
  }

  return null;
}

function parseBulkSpec(text, departments) {
  const items = [];
  const errors = [];
  const raw = String(text ?? '').trim();

  if (!raw) return { items, errors: ['Nothing to parse.'] };

  for (const chunk of raw.split(/[,;]+|\band\b/i)) {
    const part = chunk.trim();
    if (!part) continue;

    const match = part.match(/^(\d+)\s*(?:x\s*)?(.+)$/i);
    if (!match) {
      errors.push(`Could not read "${part}". Use a count then a department, e.g. "12 models".`);
      continue;
    }

    const count = Number(match[1]);
    const label = match[2].trim();

    if (!Number.isInteger(count) || count < 1) {
      errors.push(`"${part}" needs a count of at least 1.`);
      continue;
    }
    if (count > MAX_TASKS_PER_ITEM) {
      errors.push(`"${part}" asks for ${count} tasks; the limit per entry is ${MAX_TASKS_PER_ITEM}.`);
      continue;
    }

    const department = matchDepartment(label, departments);
    if (!department) {
      errors.push(`No department matches "${label}".`);
      continue;
    }

    const existing = items.find((item) => item.department.id === department.id);
    if (existing) existing.count += count;
    else items.push({ department, count, label });
  }

  return { items, errors, total: items.reduce((sum, item) => sum + item.count, 0) };
}

/**
 * Titles are numbered within their department so "Model 3/12" is meaningful on
 * its own in a DM or a queue.
 */
function taskTitlesFor({ label, count }) {
  const singular = String(label).trim().replace(/s$/i, '');
  const base = singular.charAt(0).toUpperCase() + singular.slice(1);
  return Array.from({ length: count }, (_, index) => `${base} ${index + 1}/${count}`);
}

module.exports = { MAX_TASKS_PER_ITEM, normalise, matchDepartment, parseBulkSpec, taskTitlesFor };
