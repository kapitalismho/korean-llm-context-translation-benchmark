import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initializeContextAuthoringScaffold,
} from '../src/context-authoring.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authoringRoot = path.join(projectRoot, 'data', 'datasets', 'gemba-mqm-context-v1.authoring');
const force = process.argv.slice(2).includes('--force');

initializeContextAuthoringScaffold(authoringRoot, force);
