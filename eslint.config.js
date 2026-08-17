const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/**', 'android/**', 'ios/**'],
    rules: {
      // Loading persisted/native state in an effect is the normal RN pattern;
      // this compiler-oriented rule reports those async loaders as cascades.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);
