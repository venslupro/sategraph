/**
 * Agent mode published language: chat requests, streamed process events and
 * view commands that drive the visualisation context.
 */
import { z } from 'zod';

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const viewContextSchema = z.object({
  selectedId: z.string().nullable().default(null),
  layerIds: z.array(z.string()).default([]),
  linkIds: z.array(z.string()).default([]),
  time: z.string().nullable().default(null),
});
export type ViewContext = z.infer<typeof viewContextSchema>;

export const agentChatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(20),
  context: viewContextSchema.default({}),
  turnstileToken: z.string().optional(),
  shareId: z.string().optional(),
});
export type AgentChatRequest = z.infer<typeof agentChatRequestSchema>;

export const focusSatellitesCommandSchema = z.object({
  type: z.literal('focus_satellites'),
  satelliteIds: z.array(z.string()).min(1),
  reason: z.string().optional(),
});

export const highlightLinksCommandSchema = z.object({
  type: z.literal('highlight_links'),
  linkIds: z.array(z.string()).default([]),
  relationType: z.string().optional(),
  confidence: z.enum(['DECLARED', 'DERIVED', 'MODELED']).optional(),
  reason: z.string().optional(),
});

export const setLayerCommandSchema = z.object({
  type: z.literal('set_layer'),
  layerId: z.string(),
  visible: z.boolean(),
});

export const setFilterCommandSchema = z.object({
  type: z.literal('set_filter'),
  layerIds: z.array(z.string()).optional(),
  relationTypes: z.array(z.string()).optional(),
  confidence: z.array(z.string()).optional(),
});

export const setTimeCommandSchema = z.object({
  type: z.literal('set_time'),
  isoTime: z.string(),
  speed: z.number().positive().optional(),
});

export const flyToCommandSchema = z.object({
  type: z.literal('fly_to'),
  satelliteId: z.string(),
});

export const openDetailCommandSchema = z.object({
  type: z.literal('open_detail'),
  satelliteId: z.string(),
});

export const openGraphCommandSchema = z.object({
  type: z.literal('open_graph'),
  satelliteId: z.string(),
  depth: z.number().int().min(1).max(3).default(1),
});

export const showTableCommandSchema = z.object({
  type: z.literal('show_table'),
  title: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
});

export const showChartCommandSchema = z.object({
  type: z.literal('show_chart'),
  title: z.string(),
  subtitle: z.string().optional(),
  unit: z.string().default(''),
  series: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
    }),
  ),
});

export const viewCommandSchema = z.discriminatedUnion('type', [
  focusSatellitesCommandSchema,
  highlightLinksCommandSchema,
  setLayerCommandSchema,
  setFilterCommandSchema,
  setTimeCommandSchema,
  flyToCommandSchema,
  openDetailCommandSchema,
  openGraphCommandSchema,
  showTableCommandSchema,
  showChartCommandSchema,
]);
export type ViewCommand = z.infer<typeof viewCommandSchema>;

export const citationSchema = z.object({
  label: z.string(),
  source: z.string(),
  url: z.string().url().optional(),
  confidence: z.enum(['DECLARED', 'DERIVED', 'MODELED']).optional(),
});
export type Citation = z.infer<typeof citationSchema>;

export const toolResultSummarySchema = z.object({
  tool: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  rowCount: z.number().int().nonnegative().optional(),
  source: z.string().optional(),
});
export type ToolResultSummary = z.infer<typeof toolResultSummarySchema>;

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), message: z.string(), step: z.number() }),
  z.object({
    type: z.literal('tool_call'),
    step: z.number(),
    tool: z.string(),
    arguments: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    step: z.number(),
    result: toolResultSummarySchema,
  }),
  z.object({
    type: z.literal('answer_delta'),
    text: z.string(),
  }),
  z.object({ type: z.literal('view_command'), command: viewCommandSchema }),
  z.object({ type: z.literal('citation'), citation: citationSchema }),
  z.object({
    type: z.literal('done'),
    verified: z.boolean(),
    unverifiedClaims: z.array(z.string()),
    steps: z.number(),
    shareId: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentShareSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  events: z.array(agentEventSchema),
  createdAt: z.string(),
});
export type AgentShare = z.infer<typeof agentShareSchema>;
