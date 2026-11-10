/**
 * Relation aggregate. A relation always carries a confidence level, the rule
 * that produced it (id@version) and evidence, so the UI can explain every edge.
 */
import type {
  Confidence,
  Relation as RelationView,
  RelationEndpoint,
  RelationType,
} from '@satgraph/contracts';
import { relationKey } from '@satgraph/shared-kernel';

export interface Evidence {
  label: string;
  source: string;
  url?: string;
}

export interface RelationProps {
  type: RelationType;
  from: RelationEndpoint;
  to: RelationEndpoint;
  confidence: Confidence;
  method: string;
  evidence: Evidence[];
  validFrom: string | null;
  validTo: string | null;
  updatedVersion: string;
}

export class Relation {
  private readonly props: RelationProps;
  readonly id: string;

  constructor(props: RelationProps) {
    if (props.from.id === props.to.id) {
      throw new Error(`Relation ${props.type} cannot be a self loop`);
    }
    if (props.confidence !== 'DECLARED' && !props.method.includes('@')) {
      throw new Error(
        `Relation ${props.type} of level ${props.confidence} requires a versioned method`,
      );
    }
    if (
      (props.confidence === 'MODELED' || props.confidence === 'DERIVED') &&
      props.evidence.length === 0
    ) {
      throw new Error(
        `Relation ${props.type} of level ${props.confidence} requires evidence`,
      );
    }
    this.props = { ...props, evidence: [...props.evidence] };
    this.id = relationKey(props.type, props.from.id, props.to.id);
  }

  get type(): RelationType {
    return this.props.type;
  }

  get confidence(): Confidence {
    return this.props.confidence;
  }

  get from(): RelationEndpoint {
    return this.props.from;
  }

  get to(): RelationEndpoint {
    return this.props.to;
  }

  toView(): RelationView {
    return {
      id: this.id,
      type: this.props.type,
      from: this.props.from,
      to: this.props.to,
      confidence: this.props.confidence,
      method: this.props.method,
      evidence: this.props.evidence.map((item) => ({ ...item })),
      validFrom: this.props.validFrom,
      validTo: this.props.validTo,
      updatedVersion: this.props.updatedVersion,
    };
  }
}
