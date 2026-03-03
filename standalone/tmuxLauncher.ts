/**
 * tmux pane management for standalone mode.
 * Creates, focuses, and kills tmux panes running Claude Code.
 */

import { execSync, spawn } from 'child_process';
import * as crypto from 'crypto';

export interface TmuxPane {
	paneId: string;
	sessionId: string; // Claude --session-id UUID
}

let tmuxAvailable: boolean | null = null;

export function isTmuxAvailable(): boolean {
	if (tmuxAvailable !== null) return tmuxAvailable;
	try {
		execSync('tmux -V', { stdio: 'ignore' });
		tmuxAvailable = true;
	} catch {
		tmuxAvailable = false;
	}
	return tmuxAvailable;
}

export function ensureTmuxSession(sessionName: string): void {
	try {
		execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
	} catch {
		execSync(`tmux new-session -d -s ${sessionName}`, { stdio: 'ignore' });
		console.log(`[Standalone] Created tmux session: ${sessionName}`);
	}
}

export function createAgentPane(
	sessionName: string,
	projectCwd: string,
): TmuxPane {
	const sessionId = crypto.randomUUID();

	if (isTmuxAvailable()) {
		ensureTmuxSession(sessionName);

		// Create a new window in the session and capture the pane ID
		const paneId = execSync(
			`tmux new-window -t "${sessionName}" -c "${projectCwd}" -P -F "#{pane_id}"`,
			{ encoding: 'utf-8' },
		).trim();

		// Send the claude command to the new pane
		execSync(
			`tmux send-keys -t "${paneId}" "claude --session-id ${sessionId}" Enter`,
		);

		console.log(`[Standalone] Created tmux pane ${paneId} with session ${sessionId}`);
		return { paneId, sessionId };
	}

	// Fallback: spawn detached process
	console.log('[Standalone] tmux not available, spawning detached claude process');
	const child = spawn('claude', ['--session-id', sessionId], {
		cwd: projectCwd,
		detached: true,
		stdio: 'ignore',
	});
	child.unref();

	return { paneId: `pid:${child.pid}`, sessionId };
}

export function focusAgentPane(paneId: string): void {
	if (!isTmuxAvailable() || paneId.startsWith('pid:')) return;
	try {
		execSync(`tmux select-window -t "${paneId}"`, { stdio: 'ignore' });
		execSync(`tmux select-pane -t "${paneId}"`, { stdio: 'ignore' });
	} catch {
		// Pane may have been closed
	}
}

export function killAgentPane(paneId: string): void {
	if (paneId.startsWith('pid:')) {
		const pid = parseInt(paneId.slice(4), 10);
		try { process.kill(pid); } catch { /* already dead */ }
		return;
	}
	if (!isTmuxAvailable()) return;
	try {
		execSync(`tmux kill-pane -t "${paneId}"`, { stdio: 'ignore' });
	} catch {
		// Pane may already be gone
	}
}

export function isTmuxPaneAlive(paneId: string): boolean {
	if (paneId.startsWith('pid:')) {
		const pid = parseInt(paneId.slice(4), 10);
		try { process.kill(pid, 0); return true; } catch { return false; }
	}
	if (!isTmuxAvailable()) return false;
	try {
		const output = execSync('tmux list-panes -a -F "#{pane_id}"', { encoding: 'utf-8' });
		return output.split('\n').some(line => line.trim() === paneId);
	} catch {
		return false;
	}
}
