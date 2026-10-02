import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const configSchema = z.object({
  provider: z.enum(['openrouter', 'groq']).default('openrouter'),
  plannerModel: z.string().min(1),
  laya: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(['observe', 'route']).default('observe'),
    baseUrl: z.string().url().default('http://127.0.0.1:8001'),
    timeoutMs: z.number().int().positive().default(5000),
    minConfidence: z.number().min(0).max(1).default(0.95),
    maxInputChars: z.number().int().positive().max(50000).default(6000),
    generalModel: z.string().optional(),
    codeModel: z.string().optional(),
    reviewModel: z.string().optional(),
  }).strict().default({}),
  models: z.array(z.object({
    id: z.string().min(1), specialties: z.array(z.string().min(1)).min(1),
    minIntervalMs: z.number().int().min(0).max(300000).default(0),
    fallbacks: z.array(z.string()).default([]),
  }).strict()).min(1),
  limits: z.object({
    maxAgents: z.number().int().min(1).max(6).default(6),
    maxToolRounds: z.number().int().positive().default(12),
    modelTimeoutMs: z.number().int().positive().default(120_000),
    requestTimeoutMs: z.number().int().positive().default(300_000),
    idleTtlMs: z.number().int().positive().default(86_400_000),
    maxOutputTokens: z.number().int().positive().default(4096),
    plannerOutputTokens: z.number().int().positive().default(4096),
    maxModelCalls: z.number().int().positive().default(20),
    rateLimitRetries: z.number().int().min(0).max(2).default(0),
    maxRunTokens: z.number().int().positive().default(200000),
    bodyLimitBytes: z.number().int().positive().default(2_097_152),
  }).strict().default({}),
}).strict().superRefine((config, ctx) => {
  const ids = new Set(config.models.map(m => m.id));
  if (ids.size !== config.models.length) ctx.addIssue({ code: 'custom', message: 'Duplicate model IDs.' });
  if (!ids.has(config.plannerModel)) ctx.addIssue({ code: 'custom', message: 'plannerModel must be in models.' });
  if (config.laya.enabled) {
    for (const id of [config.laya.generalModel, config.laya.codeModel, config.laya.reviewModel]) {
      if (!id || !ids.has(id)) ctx.addIssue({ code: 'custom', message: 'Laya route models must be declared in models.' });
    }
  }
  for (const model of config.models) {
    if (model.fallbacks.some(id => !ids.has(id) || id === model.id)) ctx.addIssue({ code: 'custom', message: `Invalid fallback for ${model.id}.` });
  }
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(path: string): Config { return configSchema.parse(parse(readFileSync(path, 'utf8'))); }
