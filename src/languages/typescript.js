export default {
  id: 74,
  name: 'TypeScript (5.0.3)',
  is_archived: false,
  source_file: 'ts-main.ts',
  compile_cmd: 'tsc ts-main.ts --outDir . --esModuleInterop true',
  run_cmd: 'node ts-main.js',
  image: 'codebox/typescript:5',
};
