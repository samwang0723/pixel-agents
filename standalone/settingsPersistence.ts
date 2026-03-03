/**
 * Settings persistence for standalone mode.
 * Replaces VS Code's globalState/workspaceState with JSON files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'standalone-settings.json');
const AGENTS_FILE = path.join(SETTINGS_DIR, 'standalone-agents.json');

interface Settings {
	soundEnabled: boolean;
	agentSeats: Record<number, { palette?: number; hueShift?: number; seatId?: string | null }>;
}

export interface PersistedStandaloneAgent {
	id: number;
	tmuxPaneId: string;
	jsonlFile: string;
	projectDir: string;
}

function ensureDir(): void {
	if (!fs.existsSync(SETTINGS_DIR)) {
		fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	}
}

export function readSettings(): Settings {
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as Settings;
		}
	} catch { /* ignore corrupt file */ }
	return { soundEnabled: true, agentSeats: {} };
}

export function writeSettings(updates: Partial<Settings>): void {
	ensureDir();
	const current = readSettings();
	const merged = { ...current, ...updates };
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

export function readPersistedAgents(): PersistedStandaloneAgent[] {
	try {
		if (fs.existsSync(AGENTS_FILE)) {
			return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8')) as PersistedStandaloneAgent[];
		}
	} catch { /* ignore */ }
	return [];
}

export function writePersistedAgents(agents: PersistedStandaloneAgent[]): void {
	ensureDir();
	fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf-8');
}
