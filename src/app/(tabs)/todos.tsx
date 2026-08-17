import { View } from 'react-native';

import { AppText, EmptyState } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';

export default function TodosScreen() {
  const { theme } = useAppTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.xxl }}>
        <AppText variant="display">To-Dos</AppText>
      </View>
      <EmptyState
        emoji="✅"
        title="Your to-dos will gather here"
        subtitle="This stays empty until summary generation is configured. Maina will never upload a transcript automatically."
      />
    </View>
  );
}
