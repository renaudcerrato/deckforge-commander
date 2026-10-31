import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";
import { readFile } from "node:fs/promises";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "git.renaudcerrato.deckforge.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		}
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-windows-native-assets",
			async generateBundle() {
				const root = url.fileURLToPath(new URL("./", import.meta.url));
				const native = await readFile(path.join(root, ".task/native/win32-x64/transport.node"));
				this.addWatchFile(path.join(root, ".task/native/win32-x64"));
				this.emitFile({ type: "asset", fileName: "native/win32-x64/transport.node", source: native });
			}
		},
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		}
	]
};

/** @type {import('rollup').RollupOptions} */
const inspectorConfig = {
	input: "src/inspector/run.mjs",
	output: {
		file: `${sdPlugin}/ui/run.js`,
		format: "iife",
		name: "StreamCanvasInspector",
		sourcemap: isWatching,
	},
	plugins: [
		nodeResolve({ browser: true, preferBuiltins: false }),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-inspector-html",
			async generateBundle() {
				const template = url.fileURLToPath(new URL("./src/inspector/run.html", import.meta.url));
				this.addWatchFile(template);
				const source = await readFile(template);
				this.emitFile({ type: "asset", fileName: "run.html", source });
			}
		},
	],
};

export default [config, inspectorConfig];
