/**
 * Satellite aggregate root. Identity, lifecycle and provenance live here; no
 * framework or I/O types are allowed in this layer.
 */
import type {
  LifecycleStatus,
  OrbitSummary,
  ProvenanceEntry,
} from '@sategraph/contracts';
import { toIsoUtc, type NoradId } from '@sategraph/shared-kernel';

export interface LocalizedName {
  value: string;
  language: string;
  source: string;
}

export interface SatelliteProfile {
  purpose: string | null;
  country: string | null;
  operator: string | null;
  manufacturer: string | null;
  bus: string | null;
  massKg: number | null;
  powerWatts: number | null;
  launchDate: string | null;
  constellationId: string | null;
  layerId: string | null;
}

export interface SatelliteProps {
  objectId: NoradId;
  cosparId: string | null;
  jcatId: string | null;
  wikidataId: string | null;
  names: LocalizedName[];
  status: LifecycleStatus;
  profile: SatelliteProfile;
  orbitSummary: OrbitSummary | null;
  provenance: ProvenanceEntry[];
  updatedVersion: string;
}

export interface SatelliteStatusChanged {
  type: 'SatelliteStatusChanged';
  aggregateId: NoradId;
  from: LifecycleStatus;
  to: LifecycleStatus;
  occurredAt: string;
  graphVersion: string;
}

const ALLOWED_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  CATALOGED: ['ACTIVE', 'INACTIVE', 'DECAYED'],
  ACTIVE: ['INACTIVE', 'DECAYED'],
  INACTIVE: ['DECAYED', 'ACTIVE'],
  DECAYED: [],
};

export class Satellite {
  private props: SatelliteProps;

  constructor(props: SatelliteProps) {
    this.props = { ...props, names: [...props.names] };
  }

  get objectId(): NoradId {
    return this.props.objectId;
  }

  get status(): LifecycleStatus {
    return this.props.status;
  }

  get orbitSummary(): OrbitSummary | null {
    return this.props.orbitSummary;
  }

  get names(): readonly LocalizedName[] {
    return this.props.names;
  }

  get profile(): SatelliteProfile {
    return this.props.profile;
  }

  /** Display name prefers the English label, then any curated label. */
  displayName(preferredLanguage = 'en'): string {
    const preferred = this.props.names.find(
      (name) => name.language === preferredLanguage,
    );
    return preferred?.value ?? this.props.names[0]?.value ?? this.props.objectId;
  }

  toProps(): SatelliteProps {
    return { ...this.props, names: [...this.props.names] };
  }

  /** Applies a lifecycle transition, returning the emitted domain event. */
  changeStatus(
    next: LifecycleStatus,
    occurredAt: Date,
    graphVersion: string,
  ): SatelliteStatusChanged {
    const current = this.props.status;
    if (current === next) {
      return {
        type: 'SatelliteStatusChanged',
        aggregateId: this.props.objectId,
        from: current,
        to: next,
        occurredAt: toIsoUtc(occurredAt),
        graphVersion,
      };
    }
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new Error(
        `Illegal satellite transition ${current} -> ${next} for ${this.props.objectId}`,
      );
    }
    this.props = {
      ...this.props,
      status: next,
      updatedVersion: graphVersion,
    };
    return {
      type: 'SatelliteStatusChanged',
      aggregateId: this.props.objectId,
      from: current,
      to: next,
      occurredAt: toIsoUtc(occurredAt),
      graphVersion,
    };
  }

  /** True when the satellite should be rendered on the globe. */
  isRenderable(): boolean {
    return this.props.status === 'ACTIVE' && this.props.orbitSummary !== null;
  }

  /**
   * Orbit summaries are only written back when the class changes or the
   * apsis altitude moves by more than five kilometres.
   */
  needsOrbitSummaryWrite(next: OrbitSummary): boolean {
    const previous = this.props.orbitSummary;
    if (!previous) {
      return true;
    }
    if (previous.orbitClass !== next.orbitClass) {
      return true;
    }
    return (
      Math.abs(previous.perigeeKm - next.perigeeKm) > 5 ||
      Math.abs(previous.apogeeKm - next.apogeeKm) > 5
    );
  }
}
