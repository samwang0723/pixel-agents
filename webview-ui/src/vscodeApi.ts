/**
 * Dual-mode API bridge: VS Code extension host OR standalone WebSocket server.
 *
 * In VS Code: acquireVsCodeApi() is available → use it directly.
 * In standalone: window.__STANDALONE__ is injected by the server → use WebSocket.
 *
 * The webview's existing window.addEventListener('message', handler) works unchanged
 * in both modes because the WebSocket bridge dispatches synthetic MessageEvents.
 */

declare global {
	interface Window {
		__STANDALONE__?: boolean
		__STANDALONE_PORT__?: number
	}
}

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

interface VsCodeApi {
	postMessage(msg: unknown): void
}

function createWebSocketBridge(): VsCodeApi {
	let ws: WebSocket | null = null
	const pending: unknown[] = []
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	function connect(): void {
		const port = window.__STANDALONE_PORT__ || window.location.port || '7891'
		const host = window.location.hostname || 'localhost'
		ws = new WebSocket(`ws://${host}:${port}/ws`)

		ws.onopen = () => {
			console.log('[Pixel Agents] WebSocket connected')
			// Flush any messages queued while disconnected
			for (const msg of pending) {
				ws!.send(JSON.stringify(msg))
			}
			pending.length = 0
		}

		ws.onmessage = (e) => {
			try {
				const data = JSON.parse(e.data as string)
				// Dispatch as a synthetic MessageEvent so the existing
				// window.addEventListener('message', handler) in useExtensionMessages
				// works without any changes
				window.dispatchEvent(new MessageEvent('message', { data }))
			} catch (err) {
				console.error('[Pixel Agents] Failed to parse WebSocket message:', err)
			}
		}

		ws.onclose = () => {
			console.log('[Pixel Agents] WebSocket disconnected, reconnecting in 2s...')
			ws = null
			if (!reconnectTimer) {
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null
					connect()
				}, 2000)
			}
		}

		ws.onerror = () => {
			// onclose will fire after onerror, triggering reconnect
		}
	}

	connect()

	return {
		postMessage(msg: unknown): void {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(msg))
			} else {
				pending.push(msg)
			}
		},
	}
}

// Detect environment: VS Code injects acquireVsCodeApi, standalone injects __STANDALONE__
function createApi(): VsCodeApi {
	if (window.__STANDALONE__) {
		return createWebSocketBridge()
	}
	// In VS Code webview — acquireVsCodeApi is always available
	return acquireVsCodeApi()
}

export const vscode = createApi()
