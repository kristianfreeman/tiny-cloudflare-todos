const raycastConfig = require("@raycast/eslint-config");

module.exports = [
  ...raycastConfig.flat(),
  {
    ignores: ["node_modules", "dist", ".ray-build"]
  }
];
