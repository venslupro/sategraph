/**
 * Envelope and query contracts for the public, read-only API.
 */
import { z } from 'zod';

export const apiMetaSchema = z.object({
  graphVersion: z.string(),
  orbitVersion: z.string(),
  generatedAt: z.string(),
  cached: z.boolean(),
  source: z.string().optional(),
});
export type ApiMeta = z.infer<typeof apiMetaSchema>;

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export const searchQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  layer: z.string().max(64).optional(),
  status: z.string().max(32).optional(),
  purpose: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const neighborhoodQuerySchema = z.object({
  id: z.string().min(1),
  depth: z.coerce.number().int().min(1).max(3).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(250),
  confidence: z.string().optional(),
});
export type NeighborhoodQuery = z.infer<typeof neighborhoodQuerySchema>;

export const pathQuerySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  maxDepth: z.coerce.number().int().min(1).max(3).default(3),
});
export type PathQuery = z.infer<typeof pathQuerySchema>;

export const eventsQuerySchema = z.object({
  sinceHours: z.coerce.number().int().min(1).max(24 * 14).default(48),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
