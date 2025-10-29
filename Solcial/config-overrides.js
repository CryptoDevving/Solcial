// config-overrides.js
const { ProvidePlugin } = require('webpack');

module.exports = function override(config) {
  config.resolve.fallback = {
    ...config.resolve.fallback,
    crypto: require.resolve('crypto-browserify'),
    assert: require.resolve('assert'),
    buffer: require.resolve('buffer'),
  };
  config.plugins = [
    ...config.plugins,
    new ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
    }),
  ];
  return config;
};
