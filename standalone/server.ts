/**
 * Standalone server for Pixel Agents.
 *
 * Serves the built webview as a static site, injects window.__STANDALONE__=true,
 * and provides a WebSocket bridge that mirrors the VS Code extension's message protocol.
 *
 * Usage:
 *   node dist/standalone/server.js [--cwd /path/to/project] [--port 7891] [--tmux-session pixel-agents]
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

// Asset loading (reused via vscode shim)
import {
	loadFurnitureAssets,
	loadFloorTiles,
	loadWallTiles,
	loadCharacterSprites,
	loadDefaultLayout,
} from '../src/assetLoader.js';
import type { LoadedAssets, LoadedFloorTiles, LoadedWallTiles, LoadedCharacterSprites } from '../src/assetLoader.js';

// Layout persistence (pure Node.js)
import { readLayoutFromFile, writeLayoutToFile, watchLayoutFile } from '../src/layoutPersistence.js';

// Agent management
import {
	createContext,
	launchNewAgent,
	removeAgent,
	focusAgent,
	sendExistingAgents,
	restoreAgents,
	startProjectScan,
	disposeAll,
} from './agentManager.js';
import type { StandaloneContext, WebviewShim } from './agentManager.js';

// Settings persistence
import { readSettings, writeSettings } from './settingsPersistence.js';

// tmux launcher
import { isTmuxAvailable } from './tmuxLauncher.js';

// ── CLI argument parsing ────────────────────────────────────

function parseArgs(): { cwd: string; port: number; tmuxSession: string } {
	const args = process.argv.slice(2);
	let cwd = process.cwd();
	let port = 7891;
	let tmuxSession = 'pixel-agents';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--cwd' && args[i + 1]) {
			cwd = path.resolve(args[++i]);
		} else if (args[i] === '--port' && args[i + 1]) {
			port = parseInt(args[++i], 10);
		} else if (args[i] === '--tmux-session' && args[i + 1]) {
			tmuxSession = args[++i];
		}
	}

	return { cwd, port, tmuxSession };
}

// ── MIME types for static file serving ──────────────────────

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ttf': 'font/ttf',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ico': 'image/x-icon',
};

// ── Static file server ──────────────────────────────────────

function serveStatic(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	webviewDir: string,
): void {
	const url = req.url || '/';

	// WebSocket upgrade handled by ws — skip
	if (url === '/ws') return;

	// Determine file path
	let filePath: string;
	if (url === '/' || url === '/index.html') {
		filePath = path.join(webviewDir, 'index.html');
	} else {
		// Security: prevent directory traversal
		const safePath = path.normalize(url).replace(/^(\.\.(\/|\\|$))+/, '');
		filePath = path.join(webviewDir, safePath);
	}

	// Check file exists
	if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not Found');
		return;
	}

	const ext = path.extname(filePath).toLowerCase();
	const contentType = MIME_TYPES[ext] || 'application/octet-stream';

	if (filePath.endsWith('index.html')) {
		// Inject standalone flag into HTML
		let html = fs.readFileSync(filePath, 'utf-8');
		html = html.replace(
			'</head>',
			'<script>window.__STANDALONE__=true</script></head>',
		);
		res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
		res.end(html);
	} else {
		const content = fs.readFileSync(filePath);
		res.writeHead(200, { 'Content-Type': contentType });
		res.end(content);
	}
}

// ── Asset loading ───────────────────────────────────────────

interface PreloadedAssets {
	characters: LoadedCharacterSprites | null;
	floors: LoadedFloorTiles | null;
	walls: LoadedWallTiles | null;
	furniture: LoadedAssets | null;
	defaultLayout: Record<string, unknown> | null;
}

async function preloadAssets(assetsRoot: string): Promise<PreloadedAssets> {
	console.log(`[Standalone] Loading assets from: ${assetsRoot}`);

	const [characters, floors, walls, furniture] = await Promise.all([
		loadCharacterSprites(assetsRoot),
		loadFloorTiles(assetsRoot),
		loadWallTiles(assetsRoot),
		loadFurnitureAssets(assetsRoot),
	]);

	const defaultLayout = loadDefaultLayout(assetsRoot);

	return { characters, floors, walls, furniture, defaultLayout };
}

// ── WebSocket boot sequence ─────────────────────────────────
// Mirrors PixelAgentsViewProvider's webviewReady handler

function sendBootSequence(
	ws: WebSocket,
	assets: PreloadedAssets,
	ctx: StandaloneContext,
): void {
	const send = (msg: unknown) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	};

	// 1. Settings
	const settings = readSettings();
	send({ type: 'settingsLoaded', soundEnabled: settings.soundEnabled });

	// 2. Character sprites
	if (assets.characters) {
		send({ type: 'characterSpritesLoaded', characters: assets.characters.characters });
	}

	// 3. Floor tiles
	if (assets.floors) {
		send({ type: 'floorTilesLoaded', sprites: assets.floors.sprites });
	}

	// 4. Wall tiles
	if (assets.walls) {
		send({ type: 'wallTilesLoaded', sprites: assets.walls.sprites });
	}

	// 5. Furniture assets
	if (assets.furniture) {
		const spritesObj: Record<string, string[][]> = {};
		for (const [id, spriteData] of assets.furniture.sprites) {
			spritesObj[id] = spriteData;
		}
		send({
			type: 'furnitureAssetsLoaded',
			catalog: assets.furniture.catalog,
			sprites: spritesObj,
		});
	}

	// 6. Layout (last — triggers rendering)
	const layout = readLayoutFromFile() || assets.defaultLayout;
	send({ type: 'layoutLoaded', layout });

	// 7. Existing agents
	sendExistingAgents(ctx);
}

// ── WebSocket message handler ───────────────────────────────

function handleInboundMessage(
	msg: string,
	ws: WebSocket,
	ctx: StandaloneContext,
	assets: PreloadedAssets,
	layoutWatcher: { markOwnWrite: () => void },
): void {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(msg) as Record<string, unknown>;
	} catch {
		console.error('[Standalone] Invalid JSON from WebSocket:', msg);
		return;
	}

	switch (parsed.type) {
		case 'webviewReady':
			sendBootSequence(ws, assets, ctx);
			break;

		case 'openClaude':
			launchNewAgent(ctx);
			break;

		case 'focusAgent':
			focusAgent(ctx, parsed.id as number);
			break;

		case 'closeAgent':
			removeAgent(ctx, parsed.id as number);
			break;

		case 'saveLayout':
			layoutWatcher.markOwnWrite();
			writeLayoutToFile(parsed.layout as Record<string, unknown>);
			break;

		case 'saveAgentSeats':
			writeSettings({
				agentSeats: parsed.seats as Record<number, { palette?: number; hueShift?: number; seatId?: string | null }>,
			});
			break;

		case 'setSoundEnabled':
			writeSettings({ soundEnabled: parsed.enabled as boolean });
			break;

		case 'exportLayout': {
			// Send layout data back to browser for download
			const exportLayout = readLayoutFromFile();
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'exportLayoutData', layout: exportLayout }));
			}
			break;
		}

		case 'importLayout': {
			// Browser sends the parsed layout JSON
			const imported = parsed.layout as Record<string, unknown>;
			if (!imported || imported.version !== 1 || !Array.isArray(imported.tiles)) {
				console.log('[Standalone] Invalid import layout data');
				return;
			}
			layoutWatcher.markOwnWrite();
			writeLayoutToFile(imported);
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'layoutLoaded', layout: imported }));
			}
			break;
		}

		case 'openSessionsFolder':
			// No-op in standalone mode
			console.log(`[Standalone] Sessions folder: ${ctx.projectDir}`);
			break;

		default:
			console.log(`[Standalone] Unknown message type: ${parsed.type}`);
	}
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { cwd, port, tmuxSession } = parseArgs();

	// Resolve paths
	// The dist directory is next to standalone/ in the built output
	const distRoot = path.join(__dirname, '..');
	const webviewDir = path.join(distRoot, 'webview');
	const assetsRoot = distRoot; // assets/ is inside dist/

	// Verify webview build exists
	const indexPath = path.join(webviewDir, 'index.html');
	if (!fs.existsSync(indexPath)) {
		console.error(`[Standalone] Webview not found at ${webviewDir}`);
		console.error('  Run "npm run build" first to build the webview.');
		process.exit(1);
	}

	// Preload assets
	const assets = await preloadAssets(assetsRoot);

	// Create agent context
	const ctx = createContext(cwd, tmuxSession);

	// Restore persisted agents
	restoreAgents(ctx);

	// Start project directory scanning for auto-discovery
	startProjectScan(ctx);

	// Watch layout file for external changes
	const layoutWatcher = watchLayoutFile((layout) => {
		// Broadcast layout change to all connected clients
		wss.clients.forEach((client) => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify({ type: 'layoutLoaded', layout }));
			}
		});
	});

	// HTTP server
	const httpServer = http.createServer((req, res) => {
		serveStatic(req, res, webviewDir);
	});

	// WebSocket server
	const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

	wss.on('connection', (ws) => {
		console.log('[Standalone] WebSocket client connected');

		// Create a webview shim for this connection
		const webviewShim: WebviewShim = {
			postMessage(m: unknown): void {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify(m));
				}
			},
		};

		// Set the webview reference for agent context
		// (single-client mode: latest connection wins)
		ctx.webview = webviewShim;

		// Update all existing file watchers to use the new webview shim
		// The timer/watcher callbacks capture the webview reference via ctx
		// Since we update ctx.webview, future messages will route to the new client

		ws.on('message', (data) => {
			handleInboundMessage(data.toString(), ws, ctx, assets, layoutWatcher);
		});

		ws.on('close', () => {
			console.log('[Standalone] WebSocket client disconnected');
			if (ctx.webview === webviewShim) {
				ctx.webview = undefined;
			}
		});
	});

	// Start listening
	httpServer.listen(port, () => {
		const tmuxStatus = isTmuxAvailable() ? 'available' : 'not found (agents will spawn as detached processes)';
		console.log('');
		console.log(`  Pixel Agents Standalone Server`);
		console.log(`  ───────────────────────────────`);
		console.log(`  URL:           http://localhost:${port}`);
		console.log(`  Project:       ${cwd}`);
		console.log(`  JSONL dir:     ${ctx.projectDir}`);
		console.log(`  tmux:          ${tmuxStatus}`);
		console.log(`  tmux session:  ${tmuxSession}`);
		console.log('');
	});

	// Graceful shutdown
	process.on('SIGINT', () => {
		console.log('\n[Standalone] Shutting down...');
		layoutWatcher.dispose();
		disposeAll(ctx);
		wss.close();
		httpServer.close();
		process.exit(0);
	});

	process.on('SIGTERM', () => {
		layoutWatcher.dispose();
		disposeAll(ctx);
		wss.close();
		httpServer.close();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error('[Standalone] Fatal error:', err);
	process.exit(1);
});
