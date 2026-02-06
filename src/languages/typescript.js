export default {
  id: 74,
  name: 'TypeScript (5.0.3)',
  is_archived: false,
  source_file: 'ts-main.ts',
  compile_cmd: 'echo \'{"compilerOptions":{"outDir":".","esModuleInterop":true,"skipLibCheck":true,"types":[]},"files":["ts-main.ts"]}\' > tsconfig.json && tsc -p tsconfig.json',
  run_cmd: 'node ts-main.js',
  image: 'codebox/typescript:5',
  // tsc needs ~400MB to load the type system; container must allow this during compilation
  min_memory: 512000,
};
