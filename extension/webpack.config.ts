import path from 'path';
import { fileURLToPath } from 'url';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { Configuration } from 'webpack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config: Configuration = {
  entry: {
    'background/service-worker': './src/background/service-worker.ts',
    'popup/popup': './src/popup/popup.ts',
    'options/options': './src/options/options.ts',
    'content-scripts/dlp-content': './src/content-scripts/dlp-content.ts',
    'content-scripts/form-content': './src/content-scripts/form-content.ts',
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
        { from: 'src/popup', to: 'popup', globOptions: { ignore: ['**/*.ts'] } },
        { from: 'src/options', to: 'options', globOptions: { ignore: ['**/*.ts'] } },
        { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
      ],
    }),
  ],
};

export default config;
