const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// `maina-knowledge-cloud/` is an ignored local handoff/cache directory which
// contains full nested repositories (including their own node_modules). It is
// not application source. Keeping it out of Metro makes Android bundles
// deterministic and prevents the crawler from treating duplicate packages as
// part of Maina.
const ignoredHandoffDirectory = path
  .resolve(__dirname, 'maina-knowledge-cloud')
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

config.resolver.blockList = [
  ...(config.resolver.blockList ?? []),
  new RegExp(`^${ignoredHandoffDirectory}[/\\\\].*$`),
];

module.exports = config;
