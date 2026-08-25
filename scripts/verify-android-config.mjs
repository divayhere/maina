import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');

if (!fs.existsSync(gradlePath)) {
  throw new Error('Generated Android project is missing. Run scripts/prebuild-android.sh first.');
}

const gradle = fs.readFileSync(gradlePath, 'utf8');
for (const [needle, label] of [
  [`applicationId '${config.android.package}'`, 'Android package'],
  [`versionCode ${config.android.versionCode}`, 'Android versionCode'],
  [`versionName "${config.version}"`, 'Android versionName'],
]) {
  if (!gradle.includes(needle)) {
    throw new Error(`${label} drift: expected ${needle} in ${gradlePath}`);
  }
}

console.log(`Android config matches app.json: ${config.android.package} ${config.version} (${config.android.versionCode})`);
