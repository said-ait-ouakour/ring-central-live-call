/**
 * Fireflies gives us speaker names but does not provide adviser/client roles.
 * Use the already-resolved CRM client identity to classify only high-confidence
 * matches; leave everything else as unknown rather than guessing.
 */
export function inferClientSpeakerRole(speaker, clientNames = []) {
  if (!speaker || !Array.isArray(clientNames) || clientNames.length === 0) return 'unknown';

  const speakerTokens = nameTokens(speaker);
  if (speakerTokens.length === 0) return 'unknown';

  for (const clientName of clientNames) {
    const clientTokens = nameTokens(clientName);
    if (clientTokens.length === 0) continue;

    const exact = clientTokens.join(' ') === speakerTokens.join(' ');
    const containsFullName = clientTokens.every((token) => speakerTokens.includes(token));
    if (exact || (clientTokens.length >= 2 && containsFullName)) return 'client';
  }

  return 'unknown';
}

function nameTokens(value) {
  return String(value)
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
