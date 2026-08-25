const { withMainActivity } = require('expo/config-plugins');

/**
 * Generic Bluetooth shutter remotes appear to Android as HID keyboards and
 * normally emit a volume/camera key. React Native does not receive those keys
 * reliably, so install one small Activity-level bridge during prebuild.
 */
module.exports = function withMainaHardwareTrigger(config) {
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt') {
      throw new Error('Maina hardware trigger requires a Kotlin MainActivity');
    }

    let source = mod.modResults.contents;
    const importLine = 'import com.divay.maina.recorder.MainaHardwareTrigger';
    if (!source.includes(importLine)) {
      const packageLine = source.match(/^package[^\n]*\n/m)?.[0];
      if (!packageLine) throw new Error('Could not locate MainActivity package declaration');
      source = source.replace(packageLine, `${packageLine}\n${importLine}\nimport android.view.KeyEvent\n`);
    }

    if (!source.includes('MainaHardwareTrigger.handle')) {
      const classEnd = source.lastIndexOf('\n}');
      if (classEnd < 0) throw new Error('Could not locate MainActivity class closing brace');
      const override = `

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (MainaHardwareTrigger.handle(this, event)) return true
    return super.dispatchKeyEvent(event)
  }`;
      source = `${source.slice(0, classEnd)}${override}${source.slice(classEnd)}`;
    }

    mod.modResults.contents = source;
    return mod;
  });
};
