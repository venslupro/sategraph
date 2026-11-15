/**
 * Three-tier confidence model. The distinction is a product requirement:
 * declared relationships come from a source, derived ones from reproducible
 * rules, and modeled ones from public architecture plus geometry.
 */

export const CONFIDENCE_LEVELS = ['DECLARED', 'DERIVED', 'MODELED'] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  DECLARED: 'Declared',
  DERIVED: 'Derived',
  MODELED: 'Modeled',
};

export const CONFIDENCE_DESCRIPTIONS: Record<ConfidenceLevel, string> = {
  DECLARED: 'Explicitly recorded by a data source',
  DERIVED: 'Computed from public data by a reproducible rule',
  MODELED: 'Modeled from public architecture and geometry, not measured',
};

/** Visual treatment mandated by the design: line style per level. */
export const CONFIDENCE_LINE_STYLES: Record<ConfidenceLevel, string> = {
  DECLARED: 'solid',
  DERIVED: 'dashed',
  MODELED: 'dashdot',
};

export function isConfidenceLevel(value: string): value is ConfidenceLevel {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}
