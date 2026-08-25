import { Component, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { log } from '@/services/logger';
import { captureException } from '@/services/sentry';
import { lightTheme } from './tokens';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  message?: string;
}

/** Net #3: a JS render error shows a calm recovery card instead of a white crash. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    log.error('boundary', error.message, { stack: info.componentStack });
    captureException(error, { componentStack: info.componentStack });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: lightTheme.bg }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: lightTheme.text, marginBottom: 8 }}>
          Something hiccupped
        </Text>
        <Text style={{ fontSize: 15, color: lightTheme.muted, textAlign: 'center', marginBottom: 20 }}>
          Maina caught an error and kept your data safe. Tap to try again.
        </Text>
        <Pressable
          onPress={() => this.setState({ hasError: false })}
          style={{ backgroundColor: lightTheme.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
