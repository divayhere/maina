import { readFileSync } from 'node:fs';
import { validateDataSnapshot } from './lib/renewal-core.mjs';

const before = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const after = JSON.parse(readFileSync(process.argv[3], 'utf8'));
validateDataSnapshot(before, after);
console.log('Post-install data counts and durable assets are preserved.');
