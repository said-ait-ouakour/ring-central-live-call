/**
 * Fireflies gives us speaker names but not roles, so the role is worked out
 * here from who the CRM says is on the meeting.
 *
 * Matching the client by full name alone missed most meetings: Fireflies shows
 * "judy yhap" for "Bernice Judy Yhap", "William Castle" for the joint client
 * "William Thomas & Jane Margaret Castle", and sometimes the guest's email
 * address instead of a name. So, in order:
 *
 *   1. "Unknown Speaker", "Speaker 2", "unassigned": unknown.
 *   2. A member of staff (by name, by email, or the meeting's adviser by
 *      first name): advisor.
 *   3. The client by name, with titles and joiners ignored and either name
 *      allowed to be the shorter one: client.
 *   4. Anyone else named, on a meeting linked to a client: client. Only when
 *      the staff list was read, or the adviser would be tagged as the client.
 *   5. Anything else: unknown.
 */

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'dame', 'lady', 'lord', 'rev']);
const JOINERS = new Set(['and']);
const PLACEHOLDER_TOKENS = new Set(['unknown', 'speaker', 'unassigned', 'guest', 'unidentified']);

export const STAFF_EMAIL_DOMAINS = ['tabifa.com', 'tab-legal.com', 'tbprivate.co'];

/**
 * @param {string|null|undefined} speaker Fireflies speaker name.
 * @param {object} context
 * @param {string[]} [context.clientNames] The meeting's client names from the CRM lead / contact.
 * @param {{name?: string|null, email?: string|null}[]} [context.staff] Everyone in the CRM users table.
 * @param {string|null} [context.advisorName] The meeting's adviser.
 * @returns {'advisor'|'client'|'unknown'}
 */
export function inferSpeakerRole(speaker, context = {}) {
  const raw = String(speaker || '').trim();
  if (!raw) return 'unknown';

  const clientNames = Array.isArray(context.clientNames) ? context.clientNames.filter(Boolean) : [];
  // Without the staff list an unmatched name could be the adviser, so step 4
  // only runs when the list was read.
  const staffKnown = Array.isArray(context.staff);
  const staff = staffKnown ? context.staff : [];
  const advisorName = context.advisorName || null;
  const otherwise = staffKnown && clientNames.length ? 'client' : 'unknown';

  const email = asEmail(raw);
  if (email) {
    const domain = email.split('@')[1];
    if (STAFF_EMAIL_DOMAINS.includes(domain)) return 'advisor';
    if (staff.some((member) => asEmail(member?.email) === email)) return 'advisor';
    return otherwise;
  }

  const speakerTokens = nameTokens(raw);
  if (speakerTokens.length === 0) return 'unknown';
  if (speakerTokens.every((token) => PLACEHOLDER_TOKENS.has(token) || /^\d+$/.test(token))) return 'unknown';

  const staffNames = [advisorName, ...staff.map((member) => member?.name)].filter(Boolean);
  if (staffNames.some((name) => samePerson(speakerTokens, nameTokens(name)))) return 'advisor';
  if (advisorName && speakerTokens.length === 1 && nameTokens(advisorName)[0] === speakerTokens[0]) return 'advisor';

  if (clientNames.some((name) => samePerson(speakerTokens, nameTokens(name)))) return 'client';
  return otherwise;
}

/**
 * The same person when one name holds every word of the other and the shorter
 * one has at least two words ("Judy Yhap" in "Bernice Judy Yhap"), or the two
 * are identical.
 */
function samePerson(a, b) {
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 2 && shorter.every((token) => longer.includes(token));
}

function asEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

export function nameTokens(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !TITLES.has(token) && !JOINERS.has(token));
}
