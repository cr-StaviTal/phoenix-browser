const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    'background/service-worker': './src/background/service-worker.ts',
    'popup/popup': './src/popup/popup.ts',
    'options/options': './src/options/options.ts',
    'content-scripts/dlp-content': './src/content-scripts/dlp-content.ts',
    'content-scripts/form-content': './src/content-scripts/form-content.ts',
    'content-scripts/governance-content': './src/content-scripts/governance-content.ts',
    'content-scripts/rule-content': './src/content-scripts/rule-content.ts',
    'content-scripts/clipboard-bridge-content': './src/content-scripts/clipboard-bridge-content.ts',
    'blocked/blocked': './src/blocked/blocked.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/rules.json', to: 'rules.json' },
        { from: 'src/injected', to: 'injected' },
        { from: 'src/popup', to: 'popup', globOptions: { ignore: ['**/*.ts'] } },
        { from: 'src/options', to: 'options', globOptions: { ignore: ['**/*.ts'] } },
        { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
        { from: 'src/blocked', to: 'blocked', globOptions: { ignore: ['**/*.ts'] } },
      ],
    }),
  ],
};
