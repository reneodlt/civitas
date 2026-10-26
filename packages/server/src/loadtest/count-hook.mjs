// ESM loader hook for the load test (Node 20.2 has no module.register, so run.ts passes this with --loader).
// It appends wrappers to pathfinding.ts that count calls and time spent per search function. Exported function
// declarations are mutable bindings, so reassigning them here also changes what every importer calls.
//
// It also leaves `globalThis.__pfHook` for the search probe (searchprof.ts, docs/search-perf.md): the unwrapped
// functions and a setter per binding, so the probe can put its own wrappers in place of the counters. With
// SEARCH_HOOK_EXPANDED=1 each search also adds the nodes it expands to `globalThis.__pfExpanded`.
const WRAP = ['findPath', 'findBest', 'findRoute'];
const BIND = ['findPath', 'findBest', 'findRoute', 'pathBetween', 'pathStillValid'];
export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!/\/server\/src\/pathfinding\.ts$/.test(url.split('?')[0])) return r;
  let src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  if (process.env.SEARCH_HOOK_EXPANDED === '1') {
    const n = src.split('expanded++;').length - 1;
    if (n !== 4) throw new Error(`count-hook: expected 4 'expanded++;' in pathfinding.ts, found ${n}`);
    src = 'globalThis.__pfExpanded = 0;\n' + src.replaceAll('expanded++;', 'expanded++; globalThis.__pfExpanded++;');
  }
  src += `\n;globalThis.__pfHook = { orig: { ${BIND.join(', ')} }, set: { ${BIND.map((n) => `${n}: (f) => { ${n} = f; }`).join(', ')} } };\n`;
  src += '\n;globalThis.__pfCalls = globalThis.__pfCalls || {}; globalThis.__pfMs = globalThis.__pfMs || {};\n';
  for (const n of WRAP) {
    src += `globalThis.__pfCalls.${n} = 0; globalThis.__pfMs.${n} = 0;\n` +
      `{ const o = ${n}; ${n} = function (...a) { globalThis.__pfCalls.${n}++; const t = performance.now();` +
      ` try { return o.apply(this, a); } finally { globalThis.__pfMs.${n} += performance.now() - t; } }; }\n`;
  }
  return { ...r, source: src };
}
