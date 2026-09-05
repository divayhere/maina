import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const shellSource = readFileSync(resolve(process.cwd(), 'src/design/shell.tsx'), 'utf8');
const navigationSource = readFileSync(resolve(process.cwd(), 'src/services/mkc-memory-navigation.ts'), 'utf8');

describe('DrawerMenu accessibility contract', () => {
  it('keeps drawer containers out of the iOS accessibility tree so exact child buttons remain actionable', () => {
    expect(shellSource).toMatch(
      /<Pressable\s+accessible=\{false\}\s+style=\{\[styles\.scrim,[\s\S]*?onPress=\{\(\) => setOpen\(false\)\}/,
    );
    expect(shellSource).toMatch(
      /<Pressable\s+accessible=\{false\}\s+accessibilityViewIsModal\s+style=\{\[[\s\S]*?styles\.drawer,[\s\S]*?onPress=\{\(event\) => event\.stopPropagation\(\)\}/,
    );
  });

  it('exposes every mapped destination as its exact label button without changing its navigation target', () => {
    expect(shellSource).toMatch(
      /\{items\.map\(\(item\) => \(\s*<Pressable\s+key=\{item\.label\}\s+accessibilityRole="button"\s+accessibilityLabel=\{item\.label\}\s+onPress=\{\(\) => \{\s+setOpen\(false\);\s+router\.navigate\(item\.href as never\);/s,
    );
    expect(navigationSource).toContain("{ key: 'settings', label: 'Settings', icon: 'settings-outline', href: '/settings' }");
  });

  it('exposes feedback as the exact labeled button while preserving its mail action', () => {
    expect(shellSource).toMatch(
      /<Pressable\s+accessibilityRole="button"\s+accessibilityLabel="Send feedback"\s+onPress=\{\(\) => \{\s+setOpen\(false\);\s+void Linking\.openURL\('mailto:hello@maina\.app\?subject=Maina%20feedback'\);/s,
    );
  });
});
