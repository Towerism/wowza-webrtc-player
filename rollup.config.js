import fs from 'fs';
import path from 'path';

import babel from 'rollup-plugin-babel';
import { terser } from 'rollup-plugin-terser';
import resolve from 'rollup-plugin-node-resolve';
import builtins from 'rollup-plugin-node-builtins';
import { sizeSnapshot } from 'rollup-plugin-size-snapshot';

const { version, license, name } = require('./package.json');
const licenseData = fs.readFileSync(path.join(process.cwd(), 'LICENSE.md'), {
  encoding: 'utf-8',
});

const bannerPlugin = {
  banner: `/**
 * @license ${name} ${version}
 * ${licenseData.split('\n', 1)}
 * License: ${license}
 */`,
};

const plugins = [
  builtins(),
  resolve({
    extensions: ['.ts'],
  }),
  babel({
    extensions: ['ts'],
    exclude: 'node_modules/**',
  }),
  bannerPlugin,
  sizeSnapshot(),
];

if (process.env.NODE_ENV !== 'development') {
  plugins.push(
    terser({
      toplevel: true,
      compress: {
        unsafe: true,
      },
      output: { comments: /@license/ },
    })
  );
}

const exportFormat = (format) => ({
  input: 'src/webrtc-wowza-player.ts',
  output: {
    name: 'wowza-webrtc-player',
    format,
    file: `dist/${format}/wowza-webrtc-player.js`,
    sourcemap: 'inline',
  },
  plugins: plugins.filter((v) => v),
});

export default ['umd', 'cjs', 'esm'].map(exportFormat);
