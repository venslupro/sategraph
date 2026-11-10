/**
 * Cypher projections generated from the orbit formula specification. These
 * expressions let Neo4j compute the same summary as the browser; contract
 * tests compare both implementations on the seed elements.
 */
import { EARTH_RADIUS_KM, EARTH_SIDEREAL_DAY_MIN } from '@satgraph/shared-kernel';
import { EARTH_MU, REVOLUTIONS_PER_DAY, SECONDS_PER_DAY } from './summary';

export interface CypherExpressions {
  semiMajorAxisKm: string;
  perigeeKm: string;
  apogeeKm: string;
  periodMin: string;
  orbitClass: string;
}

/**
 * Builds the summary expressions for a node alias that exposes OMM fields as
 * numeric properties (`meanMotion`, `eccentricity`, `inclination`, ...).
 */
export function orbitSummaryCypher(alias = 's'): CypherExpressions {
  const meanMotion = `toFloat(${alias}.meanMotion)`;
  const eccentricity = `toFloat(${alias}.eccentricity)`;
  const inclination = `toFloat(${alias}.inclination)`;
  const semiMajorAxisKm = `(${EARTH_MU} / pow((${meanMotion} * 2 * pi() / ${SECONDS_PER_DAY}), 2)) ^ (1.0 / 3.0)`;
  const perigeeKm = `${semiMajorAxisKm} * (1 - ${eccentricity}) - ${EARTH_RADIUS_KM}`;
  const apogeeKm = `${semiMajorAxisKm} * (1 + ${eccentricity}) - ${EARTH_RADIUS_KM}`;
  const periodMin = `${REVOLUTIONS_PER_DAY} / ${meanMotion}`;

  const orbitClass = `CASE
    WHEN ${eccentricity} > 0.25 OR ((${perigeeKm} + ${apogeeKm}) / 2 > 35000 AND ${eccentricity} > 0.05) THEN 'HEO'
    WHEN abs(${periodMin} - ${EARTH_SIDEREAL_DAY_MIN}) < 15 AND ${eccentricity} < 0.02
      THEN CASE WHEN ${inclination} < 2 THEN 'GEO' ELSE 'IGSO' END
    WHEN (${perigeeKm} + ${apogeeKm}) / 2 < 2000
      THEN CASE WHEN ${inclination} > 94 AND ${inclination} < 102 THEN 'SSO' ELSE 'LEO' END
    ELSE 'MEO' END`;

  return {
    semiMajorAxisKm,
    perigeeKm,
    apogeeKm,
    periodMin,
    orbitClass,
  };
}

/** Cypher fragment that writes the summary onto a Satellite node. */
export function orbitSummarySetClause(alias = 's'): string {
  const expr = orbitSummaryCypher(alias);
  return `SET ${alias}.semiMajorAxisKm = ${expr.semiMajorAxisKm},
    ${alias}.perigeeKm = ${expr.perigeeKm},
    ${alias}.apogeeKm = ${expr.apogeeKm},
    ${alias}.periodMin = ${expr.periodMin},
    ${alias}.orbitClass = ${expr.orbitClass}`;
}
