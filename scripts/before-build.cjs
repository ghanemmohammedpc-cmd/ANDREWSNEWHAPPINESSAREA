const { existsSync } = require('node:fs');
const path = require('node:path');
exports.default = async ({ appDir }) => {
  if (!existsSync(path.join(appDir, 'dist', 'desktop', 'main.cjs'))) throw new Error('Build the desktop bundles before packaging.');
  return false;
};
