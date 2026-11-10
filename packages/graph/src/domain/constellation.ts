/**
 * Constellation aggregate. It is the single source of truth for membership,
 * planes and slots; MEMBER_OF / IN_PLANE / IN_SLOT edges are projections that
 * only the constellation repository may write.
 */
import type {
  Constellation as ConstellationView,
  LifecycleStatus,
  Relation,
  Slot,
} from '@satgraph/contracts';
import { Relation as RelationAggregate } from './relation';

export interface ConstellationMember {
  satelliteId: string;
  name: string;
  status: LifecycleStatus;
  inclinationDeg: number;
  raanDeg: number;
  meanAnomalyDeg: number;
  /** Mean altitude in km; keeps MEO and IGSO members in separate planes. */
  altitudeKm?: number;
  planeIndex: number | null;
  slotIndex: number | null;
}

export interface OrbitalPlane {
  index: number;
  inclinationDeg: number;
  raanDeg: number;
  slots: Slot[];
}

export interface ConstellationProps {
  id: string;
  name: string;
  designPattern: string | null;
  members: ConstellationMember[];
  healthNote: string | null;
}

export interface PlaneGroup {
  raanDeg: number;
  inclinationDeg: number;
  altitudeKm?: number;
  members: ConstellationMember[];
}

const RAAN_TOLERANCE_DEG = 2.5;
const INCLINATION_TOLERANCE_DEG = 1.5;
const ALTITUDE_TOLERANCE_KM = 500;

function angularDistance(a: number, b: number): number {
  const diff = Math.abs(((a - b) % 360 + 360) % 360);
  return diff > 180 ? 360 - diff : diff;
}

function sharesAltitude(
  group: PlaneGroup,
  member: ConstellationMember,
): boolean {
  if (group.altitudeKm === undefined || member.altitudeKm === undefined) {
    return true;
  }
  return Math.abs(group.altitudeKm - member.altitudeKm) <= ALTITUDE_TOLERANCE_KM;
}

/**
 * Groups members into orbital planes by inclination, right ascension of the
 * ascending node and mean altitude. Plane order follows the ascending RAAN.
 */
export function clusterPlanes(
  members: readonly ConstellationMember[],
): PlaneGroup[] {
  const sorted = [...members].sort((a, b) => a.raanDeg - b.raanDeg);
  const planes: PlaneGroup[] = [];
  for (const member of sorted) {
    const existing = planes.find(
      (plane) =>
        angularDistance(plane.raanDeg, member.raanDeg) <= RAAN_TOLERANCE_DEG &&
        angularDistance(plane.inclinationDeg, member.inclinationDeg) <=
          INCLINATION_TOLERANCE_DEG &&
        sharesAltitude(plane, member),
    );
    if (existing) {
      existing.members.push(member);
    } else {
      planes.push({
        raanDeg: member.raanDeg,
        inclinationDeg: member.inclinationDeg,
        altitudeKm: member.altitudeKm,
        members: [member],
      });
    }
  }
  return planes.sort((a, b) => a.raanDeg - b.raanDeg);
}

export class Constellation {
  private readonly props: ConstellationProps;

  constructor(props: ConstellationProps) {
    this.props = { ...props, members: [...props.members] };
  }

  get id(): string {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get members(): readonly ConstellationMember[] {
    return this.props.members;
  }

  /** Assigns plane and slot indices, then projects the aggregate to its view. */
  assignSlots(): ConstellationView {
    const groups = clusterPlanes(this.props.members);
    const planes: OrbitalPlane[] = groups.map((group, planeIndex) => {
      const ordered = [...group.members].sort(
        (a, b) => a.meanAnomalyDeg - b.meanAnomalyDeg,
      );
      return {
        index: planeIndex,
        inclinationDeg: round(group.inclinationDeg),
        raanDeg: round(group.raanDeg),
        slots: ordered.map((member, slotIndex) => ({
          index: slotIndex,
          satelliteId: member.satelliteId,
          name: member.name,
          status: member.status,
        })),
      };
    });
    const activeCount = this.props.members.filter(
      (member) => member.status === 'ACTIVE',
    ).length;
    return {
      id: this.props.id,
      name: this.props.name,
      designPattern: this.props.designPattern,
      planes,
      slotCount: this.props.members.length,
      activeCount,
      inactiveCount: this.props.members.length - activeCount,
      healthNote: this.props.healthNote,
    };
  }

  /** Generates MEMBER_OF / IN_PLANE / IN_SLOT projection edges. */
  relationViews(graphVersion: string): Relation[] {
    const view = this.assignSlots();
    const relations: Relation[] = [];
    for (const plane of view.planes) {
      const planeId = `${this.props.id}:P${plane.index}`;
      for (const slot of plane.slots) {
        const member = this.props.members.find(
          (item) => item.satelliteId === slot.satelliteId,
        );
        if (!member) {
          continue;
        }
        relations.push(
          new RelationAggregate({
            type: 'MEMBER_OF',
            from: { id: member.satelliteId, name: member.name, kind: 'Satellite' },
            to: { id: this.props.id, name: this.props.name, kind: 'Constellation' },
            confidence: 'DECLARED',
            method: 'CuratedConstellation@1',
            evidence: [
              {
                label: `${this.props.name} member list`,
                source: 'curation',
              },
            ],
            validFrom: null,
            validTo: null,
            updatedVersion: graphVersion,
          }).toView(),
        );
        relations.push(
          new RelationAggregate({
            type: 'IN_PLANE',
            from: { id: member.satelliteId, name: member.name, kind: 'Satellite' },
            to: { id: planeId, name: `Plane ${plane.index + 1}`, kind: 'OrbitalPlane' },
            confidence: 'DERIVED',
            method: 'PlaneClusteringRule@1',
            evidence: [
              {
                label: 'Clustered by inclination and RAAN from public elements',
                source: 'celestrak',
              },
            ],
            validFrom: null,
            validTo: null,
            updatedVersion: graphVersion,
          }).toView(),
        );
        relations.push(
          new RelationAggregate({
            type: 'IN_SLOT',
            from: { id: member.satelliteId, name: member.name, kind: 'Satellite' },
            to: {
              id: `${planeId}:S${slot.index}`,
              name: `Plane ${plane.index + 1} Slot ${slot.index + 1}`,
              kind: 'OrbitalPlane',
            },
            confidence: 'DERIVED',
            method: 'SlotAssignmentRule@1',
            evidence: [
              {
                label: 'Ordered by mean anomaly within the plane',
                source: 'celestrak',
              },
            ],
            validFrom: null,
            validTo: null,
            updatedVersion: graphVersion,
          }).toView(),
        );
      }
    }
    return relations;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
