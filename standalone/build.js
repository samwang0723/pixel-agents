const esbuild = require('esbuild');
const path = require('path');

async function main() {
	await esbuild.build({
		entryPoints: [path.join(__dirname, 'server.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		outfile: path.join(__dirname, '..', 'dist', 'standalone', 'server.js'),
		sourcemap: true,
		// Alias 'vscode' to our shim so src/ modules resolve safely
		alias: {
			'vscode': path.join(__dirname, 'vscode-shim.ts'),
		},
		// ws has native addons that shouldn't be bundled
		external: ['bufferutil', 'utf-8-validate'],
		logLevel: 'info',
	});

	console.log('Standalone server built: dist/standalone/server.js');
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
