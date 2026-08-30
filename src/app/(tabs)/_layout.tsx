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
    </Tabs>
  );
}
