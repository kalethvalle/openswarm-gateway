export interface BenchmarkResult { mode: string; status: 'complete' | 'blocked' | 'failed'; passed: boolean; calls: number; tokens: number; durationMs: number }
export function summarizeBenchmark(results: BenchmarkResult[]) {
  return Object.fromEntries([...new Set(results.map(r => r.mode))].map(mode => {
    const rows = results.filter(r => r.mode === mode);
    const complete = rows.filter(r => r.status === 'complete');
    return [mode, { attempted: rows.length, completed: complete.length, passed: complete.filter(r => r.passed).length, blocked: rows.filter(r => r.status === 'blocked').length, failed: rows.filter(r => r.status === 'failed').length,
      calls: rows.reduce((n, r) => n + r.calls, 0), accountedTokens: rows.reduce((n, r) => n + r.tokens, 0), durationMs: rows.reduce((n, r) => n + r.durationMs, 0) }];
  }));
}
export function extractModule(content: string): string {
  const fenced = /^\s*```(?:javascript|js|mjs)?\s*\n([\s\S]*?)\n```\s*$/.exec(content);
  return fenced?.[1] ?? content.trim();
}
