const path = require('path');

module.exports = {
  entry: './src/worker.ts',
  target: 'webworker',
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.m?js$/,
        include: path.resolve(__dirname, 'node_modules/libzkbob-rs-wasm-web-mt'),
        resolve: {
          fullySpecified: false,
        },
      },
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
  output: {
    path: path.join(process.cwd(), 'lib'),
    filename: '[name].js',
  },
};
