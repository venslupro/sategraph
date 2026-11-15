/**
 * Number-level grounding check. Every figure in the answer must appear in a
 * tool result; otherwise it is reported to the user as unverified.
 */
export interface GroundingReport {
  verified: boolean;
  unverifiedClaims: string[];
}

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;

function isIgnorable(token: string): boolean {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    return true;
  }
  if (value >= 1900 && value <= 2100 && Number.isInteger(value)) {
    return true;
  }
  return Math.abs(value) <= 2 && Number.isInteger(value);
}

function normalizeEvidence(evidence: string): string {
  return evidence.toLowerCase().replace(/\s+/g, ' ');
}

export function checkGrounding(
  answer: string,
  evidence: readonly string[],
): GroundingReport {
  const haystack = normalizeEvidence(evidence.join(' \n '));
  const sentences = answer.split(/(?<=[.!?])\s+/);
  const unverified: string[] = [];
  for (const sentence of sentences) {
    const numbers = sentence.match(NUMBER_PATTERN) ?? [];
    for (const number of numbers) {
      if (isIgnorable(number)) {
        continue;
      }
      if (!haystack.includes(number.toLowerCase())) {
        unverified.push(sentence.trim());
        break;
      }
    }
  }
  return {
    verified: unverified.length === 0,
    unverifiedClaims: [...new Set(unverified)].slice(0, 4),
  };
}
