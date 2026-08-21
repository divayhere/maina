import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { RECORD_BAR_BUTTON_SIZE, TAB_BAR_BASE_HEIGHT, useMainaLayout } from './layout';
import { useAppTheme } from './theme';
import { space } from './tokens';
import { AppText } from './components';

export function TopBar({
  title,
  back,
  onMenu,
  right,
}: {
  title: string;
  back?: boolean;
  onMenu?: () => void;
  right?: React.ReactNode;
}) {
  const { theme } = useAppTheme();
  const { insets } = useMainaLayout();

  return (
    <View
      style={[
        styles.topBar,
        {
          paddingTop: insets.top,
          backgroundColor: 'rgba(255,255,255,0.96)',
          borderBottomColor: theme.border,
        },
      ]}
    >
      <View style={styles.topBarInner}>
        {back ? (
          <IconCircle
            icon="chevron-back"
            label="Back"
            onPress={() => router.back()}
          />
        ) : (
          <IconCircle icon="menu-outline" label="Open menu" onPress={onMenu} />
        )}
        <AppText variant="heading" numberOfLines={1} style={{ flex: 1 }}>
          {title}
        </AppText>
        <View style={{ minWidth: 40, alignItems: 'flex-end' }}>{right ?? null}</View>
      </View>
    </View>
  );
}

export function DrawerMenu() {
  const { theme } = useAppTheme();
  const { insets } = useMainaLayout();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const items = useMemo(
    () => [
      { label: 'Settings', icon: 'settings-outline' as const, href: '/settings' },
      { label: 'Privacy & storage', icon: 'shield-checkmark-outline' as const, href: '/settings' },
      { label: 'Help', icon: 'help-circle-outline' as const, href: '/help' },
    ],
    [],
  );

  return (
    <>
      <TopBar title={resolveTitle(pathname)} onMenu={() => setOpen(true)} />
      <Modal animationType="fade" transparent visible={open} onRequestClose={() => setOpen(false)}>
        <Pressable style={[styles.scrim, { backgroundColor: theme.overlay }]} onPress={() => setOpen(false)}>
          <Pressable
            style={[
              styles.drawer,
              {
                paddingTop: insets.top + space.xl,
                backgroundColor: theme.surface,
                borderRightColor: theme.border,
              },
            ]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.drawerHeader}>
              <View style={{ gap: 2 }}>
                <AppText variant="heading">Maina</AppText>
                <AppText variant="meta" muted>
                  Your meetings, written up for you.
                </AppText>
              </View>
              <IconCircle icon="close" label="Close menu" onPress={() => setOpen(false)} />
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 8, paddingTop: space.xl }}>
              {items.map((item) => (
                <Pressable
                  key={item.label}
                  onPress={() => {
                    setOpen(false);
                    router.push(item.href as never);
                  }}
                  style={({ pressed }) => [
                    styles.drawerItem,
                    { backgroundColor: pressed ? theme.mutedSoft : 'transparent' },
                  ]}
                >
                  <Ionicons name={item.icon} size={20} color={theme.textSoft} />
                  <AppText variant="bodyStrong">{item.label}</AppText>
                </Pressable>
              ))}
              <Pressable
                onPress={() => {
                  setOpen(false);
                  void Linking.openURL('mailto:hello@maina.app?subject=Maina%20feedback');
                }}
                style={({ pressed }) => [
                  styles.drawerItem,
                  { backgroundColor: pressed ? theme.mutedSoft : 'transparent' },
                ]}
              >
                <Ionicons name="mail-outline" size={20} color={theme.textSoft} />
                <AppText variant="bodyStrong">Send feedback</AppText>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function MainaTabBar({ state, navigation }: any) {
  const { theme } = useAppTheme();
  const { insets } = useMainaLayout();
  const activeRoute = state.routes[state.index]?.name;

  const visibleItems = [
    { key: 'index', label: 'Home', icon: 'home-outline' as const },
    { key: 'todos', label: 'To-dos', icon: 'checkmark-circle-outline' as const },
    { key: 'settings', label: 'Settings', icon: 'settings-outline' as const },
  ];

  const goToTab = (routeName: string) => {
    const route = state.routes.find((item: { key: string; name: string; params?: object }) => item.name === routeName);
    if (!route) return;
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });
    if (!event.defaultPrevented) {
      navigation.navigate(route.name, route.params);
    }
  };

  return (
    <View
      style={[
        styles.tabBar,
        {
          height: TAB_BAR_BASE_HEIGHT + insets.bottom,
          paddingBottom: Math.max(space.sm, insets.bottom),
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
        },
      ]}
    >
      <View style={styles.tabBarRow}>
        {visibleItems.map((item) => {
          const isActive = activeRoute === item.key;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={item.label}
              onPress={() => goToTab(item.key)}
              style={({ pressed }) => [
                styles.tabItem,
                { opacity: pressed ? 0.96 : 1 },
              ]}
            >
              <Ionicons name={item.icon} size={26} color={isActive ? theme.primary : theme.textSoft} />
              <AppText variant="tab" color={isActive ? theme.primary : theme.textSoft}>
                {item.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Record a meeting"
        onPress={() => router.push('/record')}
        style={({ pressed }) => [
          styles.recordTabButton,
          {
            width: RECORD_BAR_BUTTON_SIZE,
            height: RECORD_BAR_BUTTON_SIZE,
            borderRadius: RECORD_BAR_BUTTON_SIZE / 2,
            backgroundColor: theme.primary,
            shadowColor: theme.primary,
            right: 20,
            bottom: Math.max(insets.bottom + 22, 26),
            transform: [{ scale: pressed ? 0.97 : 1 }],
          },
        ]}
      >
        <View
          style={{
            width: RECORD_BAR_BUTTON_SIZE,
            height: RECORD_BAR_BUTTON_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: RECORD_BAR_BUTTON_SIZE / 2,
            borderWidth: 4,
            borderColor: '#FFFFFF',
          }}
        >
          <Ionicons name="mic-outline" size={28} color="#FFFFFF" />
        </View>
      </Pressable>
    </View>
  );
}

function IconCircle({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: pressed ? theme.mutedSoft : 'transparent' },
      ]}
    >
      <Ionicons name={icon} size={26} color={theme.text} />
    </Pressable>
  );
}

function resolveTitle(pathname: string): string {
  if (pathname.startsWith('/todos')) return 'To-dos';
  if (pathname.startsWith('/settings')) return 'Settings';
  return greetingTitle();
}

function greetingTitle(): string {
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `${greeting}, Divay`;
}

const styles = StyleSheet.create({
  topBar: {
    borderBottomWidth: 1,
  },
  topBarInner: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: {
    flex: 1,
  },
  drawer: {
    width: '80%',
    maxWidth: 304,
    flex: 1,
    borderRightWidth: 1,
  },
  drawerHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  drawerItem: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  tabBar: {
    borderTopWidth: 1,
  },
  tabBarRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
  },
  tabItem: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingBottom: 6,
  },
  recordTabButton: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
});
