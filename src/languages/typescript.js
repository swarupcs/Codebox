export default {
  id: 74,
  name: 'TypeScript (5.0.3)',
  is_archived: false,
  source_file: 'ts-main.ts',
  compile_cmd: 'tsc ts-main.ts --outDir . --esModuleInterop true',
  run_cmd: 'node ts-main.js',
  image: 'codebox/typescript:5',
  // tsc needs ~400MB to load the type system; container must allow this during compilation
  min_memory: 512000,
};
