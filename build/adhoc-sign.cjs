// Same approach as GooseFluence: without a paid Apple Developer ID the app cannot be properly
// signed, but Apple Silicon Macs refuse to run code with no signature at all ("app is damaged").
// An ad-hoc signature is enough for macOS to offer "Open Anyway" instead. Runs after packaging
// and before the DMG is made; only the final universal app matters.
const { execFileSync } = require('child_process');
const path = require('path');

const ARCH_UNIVERSAL = 4; // builder-util's Arch.universal

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (context.arch !== ARCH_UNIVERSAL) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing  app=${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
