import { configSchema } from '../src/config.js';
import { configuration } from './helpers.js';
import { LayaRouter } from '../src/laya.js';
import type { Config } from '../src/config.js';
import type { Specialty } from '../src/types.js';

export function v2config(): Config {
  const old = configuration({ maxModelCalls: 8, maxRunTokens: 60000 });
  return configSchema.parse({ ...old, version: 2, providers: { free: { type: 'groq', freeAccount: true } },
    models: old.models.map(m => ({ ...m, provider: 'free', remoteId: m.id, specialties: m.id === 'planner' ? ['planning'] : m.id === 'worker' ? ['general', 'coding', 'debugging', 'architecture'] : ['general', 'coding', 'review', 'debugging', 'architecture'] })),
    laya: { enabled: true, mode: 'route', generalModel: 'worker', codeModel: 'worker', reviewModel: 'backup', maxInputChars: 50000 }, collaboration: { maxQuotaWaitMs: 0 },
  });
}
export function localDecisions(config: Config, initial: Specialty = 'coding', override?: (purpose: string, body: any) => any) {
  return new LayaRouter(config.laya, () => {}, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); let state; try { state = JSON.parse(body.state); } catch { state = { purpose: 'initial', question: body.state }; }
    const answers = Object.fromEntries(Object.keys(body.questions).map(key => [key, { choice: key === 'specialty' ? state.purpose === 'initial' ? initial : 'review' : key === 'delivery' ? initial === 'general' ? 'direct' : 'collaborate' : key === 'disposition' ? 'contribution' : 'keep', answer_confidence: 0.99 }]));
    return Response.json(override?.(state.purpose, body) ?? { answers, usage: { truncated: false }, routing: { model: 'multilingual' } });
  });
}
