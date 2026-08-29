import { Tabs } from 'expo-router';

import { MainaTabBar } from '@/design/shell';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <MainaTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
        }}
      />
      <Tabs.Screen
        name="todos"
        options={{
          title: 'To-dos',
        }}
      />
      <Tabs.Screen name="settings" options={{ href: null }} />
      <Tabs.Screen name="notifications" options={{ href: null }} />
      <Tabs.Screen name="meeting" options={{ href: null }} />
      <Tabs.Screen name="diagnostics" options={{ href: null }} />
      <Tabs.Screen name="help" options={{ href: null }} />
      <Tabs.Screen name="memory" options={{ href: null }} />
    </Tabs>
  );
}
