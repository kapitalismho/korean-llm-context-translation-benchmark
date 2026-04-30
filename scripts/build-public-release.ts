import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPublicReleaseTree } from '../src/public-release-tree.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

let outDir: string | undefined;
const argv = process.argv.slice(2);

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];

  switch (arg) {
    case '--out-dir':
      outDir = path.resolve(projectRoot, readValue(argv, index, arg));
      index += 1;
      break;
    default:
      throw new Error(`Unknown option: ${arg}`);
  }
}

const result = buildPublicReleaseTree({ projectRoot, outDir });

console.log(`Public release tree: ${result.outDir}`);
console.log(`Files copied: ${result.filesCopied}`);
