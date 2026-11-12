/** Events served from the seed snapshot. */
import type { DomainEventView } from '@sategraph/contracts';
import type { GraphSnapshot } from '@sategraph/publishing';
import type { EventReader } from '../ports';

export class SnapshotEventReader implements EventReader {
  constructor(private readonly snapshot: GraphSnapshot) {}

  async list(sinceHours: number, limit: number): Promise<DomainEventView[]> {
    // The seed snapshot is a fixed window; its generated time is the reference
    // so demonstrations keep showing the same recent activity.
    const reference = new Date(this.snapshot.generatedAt).getTime();
    const since = reference - sinceHours * 3600 * 1000;
    return this.snapshot.events
      .filter((event) => new Date(event.occurredAt).getTime() >= since)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async recentForAggregate(
    aggregateId: string,
    limit: number,
  ): Promise<DomainEventView[]> {
    return this.snapshot.events
      .filter((event) => event.aggregateId === aggregateId)
      .slice(0, limit);
  }
}
