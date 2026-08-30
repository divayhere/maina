import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const appRoot = resolve(process.cwd(), 'src/app');
const tabRoot = join(appRoot, '(tabs)');

const secondaryRoutes = [
  'notifications',
  'settings',
  'help',
  'diagnostics',
  'memory',
];

function listFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function publicRouteFor(file) {
  if (!file.endsWith('.tsx') || file.endsWith('/_layout.tsx')) return null;
  const segments = relative(appRoot, file)
    .replace(/\.tsx$/, '')
    .split('/')
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
}

function stateAt(primaryTab) {
  return { primaryTab, rootStack: ['(tabs)'] };
}

function stateFromDirectLink(route) {
  return { primaryTab: '/', rootStack: ['(tabs)', route] };
}

function navigateSingleton(state, route) {
  const existingIndex = state.rootStack.indexOf(route);
  return {
    ...state,
    rootStack: existingIndex >= 0
      ? state.rootStack.slice(0, existingIndex + 1)
      : [...state.rootStack, route],
  };
}

function push(state, route) {
  return { ...state, rootStack: [...state.rootStack, route] };
}

function back(state) {
  if (state.rootStack.length === 1) return state;
  return { ...state, rootStack: state.rootStack.slice(0, -1) };
}

describe('Expo Router route ownership', () => {
  it('keeps only Home and To-dos in the Tabs navigator', () => {
    expect(readdirSync(tabRoot).sort()).toEqual(['_layout.tsx', 'index.tsx', 'todos.tsx']);

    const layout = readFileSync(join(tabRoot, '_layout.tsx'), 'utf8');
    expect([...layout.matchAll(/<Tabs\.Screen\s+name="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(['index', 'todos']);
    expect(layout).not.toContain('backBehavior="history"');
  });

  it('owns every secondary destination in the outer native Stack', () => {
    const rootLayout = readFileSync(join(appRoot, '_layout.tsx'), 'utf8');
    expect(rootLayout).toContain("initialRouteName: '(tabs)'");

    for (const route of secondaryRoutes) {
      const routePath = route === 'memory'
        ? join(appRoot, route, 'index.tsx')
        : join(appRoot, `${route}.tsx`);
      expect(statSync(routePath).isFile()).toBe(true);
      expect(rootLayout).toContain(`<Stack.Screen name="${route}" />`);
    }
  });

  it('generates one reachable owner for every public route', () => {
    const routes = listFiles(appRoot)
      .map(publicRouteFor)
      .filter((route) => route !== null);
    const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);

    expect(duplicates).toEqual([]);
    expect(routes.sort()).toEqual([
      '/',
      '/diagnostics',
      '/help',
      '/meeting/[id]',
      '/meeting/[id]/recover',
      '/memory',
      '/notifications',
      '/record',
      '/settings',
      '/todos',
    ]);
  });

  it('uses singleton navigation for secondary roots and pushes their child screens', () => {
    const shell = readFileSync(resolve(process.cwd(), 'src/design/shell.tsx'), 'utf8');
    const notifications = readFileSync(join(appRoot, 'notifications.tsx'), 'utf8');
    const settings = readFileSync(join(appRoot, 'settings.tsx'), 'utf8');

    expect(shell).toContain("router.navigate('/notifications')");
    expect(shell).toContain('router.navigate(item.href as never)');
    expect(notifications).toContain('router.push(item.href as never)');
    expect(settings).toContain("router.push('/help')");
    expect(settings).toContain("router.push('/diagnostics')");
    expect([shell, notifications, settings].join('\n')).not.toMatch(/BackHandler|[?&]origin=/);
  });
});

describe('native Stack history policy', () => {
  it.each(['/', '/todos'])('returns Notifications to its meaningful %s origin', (origin) => {
    const opened = navigateSingleton(stateAt(origin), 'notifications');
    expect(back(opened)).toEqual(stateAt(origin));
  });

  it('unwinds Notifications -> Meeting -> Notifications -> primary origin', () => {
    const origin = stateAt('/todos');
    const notifications = navigateSingleton(origin, 'notifications');
    const meeting = push(notifications, 'meeting/example');

    expect(back(meeting)).toEqual(notifications);
    expect(back(back(meeting))).toEqual(origin);
  });

  it('anchors a direct secondary link above Home', () => {
    expect(back(stateFromDirectLink('notifications'))).toEqual(stateAt('/'));
  });

  it('does not duplicate repeated singleton destinations', () => {
    const once = navigateSingleton(stateAt('/todos'), 'notifications');
    const twice = navigateSingleton(once, 'notifications');

    expect(twice).toEqual(once);
    expect(twice.rootStack.filter((route) => route === 'notifications')).toHaveLength(1);
  });

  it('keeps Settings children and Memory in the same outer ownership model', () => {
    const origin = stateAt('/todos');
    const settings = navigateSingleton(origin, 'settings');

    expect(back(push(settings, 'help'))).toEqual(settings);
    expect(back(push(settings, 'diagnostics'))).toEqual(settings);
    expect(back(settings)).toEqual(origin);
    expect(back(navigateSingleton(origin, 'memory'))).toEqual(origin);
  });
});
