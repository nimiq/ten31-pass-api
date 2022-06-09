import typescript from '@rollup/plugin-typescript';
import type { RollupOptions } from 'rollup';

const OPTIONS: RollupOptions = {
    input: 'src/index.ts',
    output: [{
        file: 'dist/index.es.js',
        format: 'es',
        interop: false,
        sourcemap: true,
    }, {
        file: 'dist/index.js',
        format: 'umd',
        name: 'Ten31PassApi',
        interop: false,
        sourcemap: true,
    }],
    plugins: [
        typescript({
            // needs to be passed as file path to enable declaration file emission as a side effect, until
            // https://github.com/rollup/plugins/pull/1201 is merged.
            tsconfig: './tsconfig.json',
            include: ['src/**/*'],
        }),
    ],
};

export default OPTIONS;
