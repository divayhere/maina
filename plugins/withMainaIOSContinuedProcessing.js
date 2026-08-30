const { withAppDelegate } = require('expo/config-plugins');

/**
 * BGTask launch handlers must exist before React Native starts. A pending iOS
 * continued-processing request may relaunch Maina before any Expo module or JS
 * code is initialized, so install the registration at the native AppDelegate
 * boundary during every deterministic prebuild.
 */
module.exports = function withMainaIOSContinuedProcessing(config) {
  return withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== 'swift') {
      throw new Error('Maina continued processing requires a Swift AppDelegate');
    }

    let source = mod.modResults.contents;
    // Expo's generated provider uses an explicit internal import. Xcode 26
    // rejects importing the same module here with an ambiguous access level.
    const importLine = 'internal import MainaRecorder';
    if (!source.includes(importLine)) {
      const anchor = 'internal import Expo\n';
      if (!source.includes(anchor)) throw new Error('Could not locate the Expo AppDelegate import');
      source = source.replace(anchor, `${anchor}${importLine}\n`);
    }

    const registrations = [
      '    MainaIOSContinuedProcessing.registerLaunchHandler()\n',
      '    MainaIOSPipelineWake.registerLaunchHandler()\n',
    ];
    if (registrations.some((registration) => !source.includes(registration.trim()))) {
      const launchMarker = 'didFinishLaunchingWithOptions';
      const launchIndex = source.indexOf(launchMarker);
      const bodyMarker = '  ) -> Bool {\n';
      const bodyIndex = source.indexOf(bodyMarker, launchIndex);
      if (launchIndex < 0 || bodyIndex < 0) {
        throw new Error('Could not locate AppDelegate didFinishLaunchingWithOptions body');
      }
      const insertion = bodyIndex + bodyMarker.length;
      const missing = registrations.filter((registration) => !source.includes(registration.trim())).join('');
      source = `${source.slice(0, insertion)}${missing}${source.slice(insertion)}`;
    }

    mod.modResults.contents = source;
    return mod;
  });
};
