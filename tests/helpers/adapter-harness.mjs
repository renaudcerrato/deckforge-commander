import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Compile only the requested adapters, never plugin startup or SDK modules.
export async function loadAdapterCode(names) {
  return new Map(await Promise.all(names.map(async name => {
    const source = await readFile(new URL(`../../src/actions/${name}.ts`, import.meta.url), 'utf8');
    return [`./${name}`, ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
    } }).outputText];
  })));
}

// Each harness owns its module instances and supplies every external boundary.
// There is deliberately no real require or inherited-process fallback.
export function createAdapterLoader(codes, { process: syntheticProcess, resolve }) {
  const modules = new Map();
  function isolatedRequire(name) {
    if (!codes.has(name)) return resolve(name);
    if (!modules.has(name)) {
      const exports = {};
      modules.set(name, exports);
      new Function('require', 'exports', 'process', codes.get(name))(isolatedRequire, exports, syntheticProcess);
    }
    return modules.get(name);
  }
  return isolatedRequire;
}
