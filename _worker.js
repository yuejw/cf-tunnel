/**
 * CF Pages Worker — SSH 隧道服务端（Durable Objects 版）
 *
 * -L / -D 模式：每条连接自包含，不需要共享状态
 * -R 模式：使用 Durable Object 保证所有连接路由到同一实例
 */

import { connect } from 'cloudflare:sockets';

// 协议常量
const CMD_TUNNEL_NEW = 0x10;
const CMD_TUNNEL_DATA = 0x11;
const CMD_TUNNEL_CLOSE = 0x12;
const CMD_PING = 0xFF;
const CMD_PONG = 0xFE;

// ============================================================
// Durable Object: TunnelDO
// 每个 tunnelId 对应一个 DO 实例，所有连接必然路由到同一实例
// ============================================================
export class TunnelDO {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.clientWs = null;        // -R 客户端的 WebSocket
		this.connections = new Map(); // connId → visitorWs
		this.heartbeatTimer = null;
	}

	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/register') {
			return this.handleRegister(request);
		} else if (url.pathname === '/connect') {
			return this.handleConnect(request);
		} else if (url.pathname === '/status') {
			return this.handleStatus();
		}

		return jsonResponse({ error: 'Not found' }, 404);
	}

	// -R 客户端注册隧道
	handleRegister(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return jsonResponse({ error: 'WebSocket required' }, 400);
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();
		server.binaryType = 'arraybuffer';

		// 关闭旧连接
		if (this.clientWs) {
			try { this.clientWs.close(4003, 'Replaced by new connection') } catch {}
			clearInterval(this.heartbeatTimer);
		}

		this.clientWs = server;

		// 心跳
		this.heartbeatTimer = setInterval(() => {
			if (server.readyState === WebSocket.OPEN) {
				try { server.send(new Uint8Array([CMD_PING])) } catch {}
			}
		}, 30000);

		// -R 客户端发来的数据分发
		server.addEventListener('message', (event) => {
			const data = toUint8Array(event.data);
			if (data.length < 2) return;
			const cmd = data[0];
			if (cmd === CMD_PONG) return;

			if (cmd === CMD_TUNNEL_DATA || cmd === CMD_TUNNEL_CLOSE) {
				const connIdLen = data[1];
				if (data.length < 2 + connIdLen) return;
				const connId = new TextDecoder().decode(data.subarray(2, 2 + connIdLen));
				const visitorWs = this.connections.get(connId);
				if (!visitorWs || visitorWs.readyState !== WebSocket.OPEN) return;

				if (cmd === CMD_TUNNEL_DATA) {
					const payload = data.subarray(2 + connIdLen);
					if (payload.length > 0) {
						try { visitorWs.send(payload) } catch {}
					}
				} else {
					try { visitorWs.close() } catch {}
					this.connections.delete(connId);
				}
			}
		});

		const cleanup = () => {
			if (this.clientWs === server) {
				this.clientWs = null;
				clearInterval(this.heartbeatTimer);
			}
		};
		server.addEventListener('close', cleanup);
		server.addEventListener('error', cleanup);

		return new Response(null, { status: 101, webSocket: client });
	}

	// -C 客户端（外部用户）连接隧道
	handleConnect(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return jsonResponse({ error: 'WebSocket required' }, 400);
		}

		if (!this.clientWs || this.clientWs.readyState !== WebSocket.OPEN) {
			return jsonResponse({ error: 'Tunnel offline' }, 404);
		}

		const pair = new WebSocketPair();
		const [client, visitorWs] = [pair[0], pair[1]];
		visitorWs.accept();
		visitorWs.binaryType = 'arraybuffer';

		const connId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		const connIdBytes = new TextEncoder().encode(connId);

		// 通知 -R 客户端：新连接
		const newMsg = new Uint8Array(1 + connIdBytes.length);
		newMsg[0] = CMD_TUNNEL_NEW;
		newMsg.set(connIdBytes, 1);
		try {
			this.clientWs.send(newMsg);
		} catch {
			try { visitorWs.close(4002, 'Failed to notify tunnel client') } catch {}
			return new Response(null, { status: 101, webSocket: client });
		}

		// 桥接：visitor → -R 客户端
		visitorWs.addEventListener('message', (event) => {
			const data = toUint8Array(event.data);
			if (data.length === 1 && data[0] === CMD_PING) {
				try { visitorWs.send(new Uint8Array([CMD_PONG])) } catch {}
				return;
			}
			const frame = new Uint8Array(1 + 1 + connIdBytes.length + data.length);
			frame[0] = CMD_TUNNEL_DATA;
			frame[1] = connIdBytes.length;
			frame.set(connIdBytes, 2);
			frame.set(data, 2 + connIdBytes.length);
			try {
				if (this.clientWs?.readyState === WebSocket.OPEN) {
					this.clientWs.send(frame);
				}
			} catch {}
		});

		this.connections.set(connId, visitorWs);

		visitorWs.addEventListener('close', () => {
			const closeMsg = new Uint8Array(1 + 1 + connIdBytes.length);
			closeMsg[0] = CMD_TUNNEL_CLOSE;
			closeMsg[1] = connIdBytes.length;
			closeMsg.set(connIdBytes, 2);
			try { this.clientWs?.send(closeMsg) } catch {}
			this.connections.delete(connId);
		});
		visitorWs.addEventListener('error', () => {
			this.connections.delete(connId);
		});

		return new Response(null, { status: 101, webSocket: client });
	}

	// 隧道状态查询
	handleStatus() {
		return jsonResponse({
			online: this.clientWs?.readyState === WebSocket.OPEN,
			connections: this.connections.size,
		});
	}
}

// ============================================================
// 主入口：路由分发
// ============================================================
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		// -L / -D 模式：直接代理，不需要 DO
		if (path === '/proxy') {
			return handleProxy(request);
		}

		// -R：注册隧道 → 路由到 DO
		if (path === '/tunnel/register') {
			const tunnelId = url.searchParams.get('id');
			if (!tunnelId || !/^[\w-]+$/.test(tunnelId)) {
				return jsonResponse({ error: 'Invalid tunnel id' }, 400);
			}
			const id = env.TUNNEL_DO.idFromName(tunnelId);
			const stub = env.TUNNEL_DO.get(id);
			const doUrl = new URL(request.url);
			doUrl.pathname = '/register';
			return stub.fetch(new Request(doUrl, request));
		}

		// -C：连接隧道 → 路由到 DO
		if (path.startsWith('/tunnel/connect/')) {
			const tunnelId = path.slice('/tunnel/connect/'.length);
			const id = env.TUNNEL_DO.idFromName(tunnelId);
			const stub = env.TUNNEL_DO.get(id);
			const doUrl = new URL(request.url);
			doUrl.pathname = '/connect';
			return stub.fetch(new Request(doUrl, request));
		}

		// 隧道状态
		if (path.startsWith('/tunnel/status/')) {
			const tunnelId = path.slice('/tunnel/status/'.length);
			const id = env.TUNNEL_DO.idFromName(tunnelId);
			const stub = env.TUNNEL_DO.get(id);
			const doUrl = new URL(request.url);
			doUrl.pathname = '/status';
			return stub.fetch(new Request(doUrl, request));
		}

		if (path === '/health') {
			return jsonResponse({ status: 'ok' });
		}

		return jsonResponse({ error: 'Not found' }, 404);
	},
};

// ============================================================
// -L / -D 模式：代理转发
// ============================================================
function handleProxy(request) {
	if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return jsonResponse({ error: 'WebSocket required' }, 400);
	}

	const pair = new WebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	server.accept();
	server.binaryType = 'arraybuffer';

	let remoteSocket = null;
	let remoteWriter = null;
	let isFirstMessage = true;
	let connected = false;
	const pendingData = [];

	const cleanup = () => {
		try { server.close() } catch {}
		if (remoteWriter) { try { remoteWriter.releaseLock() } catch {} remoteWriter = null; }
		if (remoteSocket) { try { remoteSocket.close() } catch {} remoteSocket = null; }
		connected = false;
	};

	const writeToRemote = async (data) => {
		if (!remoteSocket || !remoteSocket.writable) return;
		try {
			if (!remoteWriter) remoteWriter = remoteSocket.writable.getWriter();
			await remoteWriter.write(data);
		} catch {
			cleanup();
		}
	};

	const connectAndRelay = async (targetData) => {
		const addrStr = new TextDecoder().decode(targetData);
		const separator = addrStr.lastIndexOf(':');
		if (separator === -1) throw new Error('Invalid address format');
		const hostname = addrStr.slice(0, separator);
		const port = parseInt(addrStr.slice(separator + 1), 10);
		if (!hostname || isNaN(port)) throw new Error('Invalid host or port');

		remoteSocket = connect({ hostname, port });
		await remoteSocket.opened;

		const reader = remoteSocket.readable.getReader();
		const pump = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (server.readyState === WebSocket.OPEN) server.send(value);
				}
			} catch {} finally { cleanup(); }
		};
		pump();

		connected = true;
		for (const chunk of pendingData) {
			await writeToRemote(chunk);
		}
		pendingData.length = 0;
	};

	server.addEventListener('message', (event) => {
		const data = toUint8Array(event.data);

		if (data.length === 1 && data[0] === CMD_PING) {
			try { server.send(new Uint8Array([CMD_PONG])) } catch {}
			return;
		}

		if (isFirstMessage) {
			isFirstMessage = false;
			connectAndRelay(data).catch(err => {
				try { server.close(4000, err.message) } catch {}
			});
			return;
		}

		if (!connected) {
			pendingData.push(data);
		} else {
			writeToRemote(data).catch(() => {});
		}
	});

	server.addEventListener('close', () => cleanup());
	server.addEventListener('error', () => cleanup());

	return new Response(null, { status: 101, webSocket: client });
}

// ============================================================
// 工具函数
// ============================================================
function toUint8Array(data) {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return new Uint8Array(data);
}

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
}

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeaders() },
	});
}
