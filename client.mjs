#!/usr/bin/env node
/**
 * CF Tunnel 客户端
 *
 * 用法（URL 里包含所有信息）：
 *   node client.mjs https://server/L/<localPort>/<targetHost>/<targetPort>
 *   node client.mjs https://server/R/<localPort>/<tunnelId>
 *   node client.mjs https://server/C/<localPort>/<tunnelId>
 *   node client.mjs https://server/D/<localPort>
 */

import * as net from 'node:net';

// 协议常量
const CMD_PING = 0xFF;
const CMD_PONG = 0xFE;
const CMD_TUNNEL_NEW = 0x10;
const CMD_TUNNEL_DATA = 0x11;
const CMD_TUNNEL_CLOSE = 0x12;

// ============================================================
// 解析 URL 参数
// ============================================================
function parseArgs() {
	const args = process.argv.slice(2);
	if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
		printUsage();
		process.exit(0);
	}

	let urlStr = args[0];
	if (!/^https?:\/\//.test(urlStr)) urlStr = 'https://' + urlStr;

	const url = new URL(urlStr);
	const server = url.origin;
	const parts = url.pathname.split('/').filter(Boolean);
	const mode = (parts[0] || '').toUpperCase();

	if (!['L', 'R', 'C', 'D'].includes(mode)) {
		console.error(`URL 路径必须以 /L /R /C /D 开头`);
		process.exit(1);
	}

	const config = { server, mode };

	if (mode === 'L') {
		if (parts.length !== 4) { console.error('格式: https://server/L/<localPort>/<targetHost>/<targetPort>'); process.exit(1); }
		config.localPort = { localPort: +parts[1], targetHost: parts[2], targetPort: +parts[3] };
	} else if (mode === 'R') {
		if (parts.length < 3 || parts.length > 4) { console.error('格式: https://server/R/<localPort>/<tunnelId> 或 https://server/R/<localHost>/<localPort>/<tunnelId>'); process.exit(1); }
		if (parts.length === 4) {
			config.remoteForward = { localHost: parts[1], localPort: +parts[2], tunnelId: parts[3] };
		} else {
			config.remoteForward = { localHost: '127.0.0.1', localPort: +parts[1], tunnelId: parts[2] };
		}
	} else if (mode === 'C') {
		if (parts.length !== 3) { console.error('格式: https://server/C/<localPort>/<tunnelId>'); process.exit(1); }
		config.connectTunnel = { localPort: +parts[1], tunnelId: parts[2] };
	} else if (mode === 'D') {
		if (parts.length !== 2) { console.error('格式: https://server/D/<localPort>'); process.exit(1); }
		config.dynamicPort = +parts[1];
	}

	return config;
}

function printUsage() {
	console.log(`Usage: node client.mjs <url>

  https://server/L/<localPort>/<targetHost>/<targetPort>  本地转发
  https://server/R/<localPort>/<tunnelId>                 远程转发（暴露本地服务）
  https://server/R/<localHost>/<localPort>/<tunnelId>    远程转发（暴露局域网服务）
  https://server/C/<localPort>/<tunnelId>                 连接远程隧道
  https://server/D/<localPort>                            SOCKS5 代理

Examples:
  node client.mjs https://tunnel.pages.dev/L/8080/httpbin.org/80
  node client.mjs https://tunnel.pages.dev/R/22/myssh
  node client.mjs https://tunnel.pages.dev/R/192.168.1.100/22/myssh
  node client.mjs https://tunnel.pages.dev/C/2222/myssh
  node client.mjs https://tunnel.pages.dev/D/1080`);
}

// ============================================================
// 工具函数
// ============================================================
async function toBuffer(data) {
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
	return Buffer.from(data);
}

// ============================================================
// -L 模式：本地端口转发
// ============================================================
function startLocalForward(config) {
	const { localPort, targetHost, targetPort } = config.localPort;

	const server = net.createServer((socket) => {
		const wsUrl = `${config.server}/proxy`.replace('http', 'ws');
		console.log(`[L] New connection -> ${targetHost}:${targetPort}`);

		const ws = new WebSocket(wsUrl);
		let connected = false;
		let pendingData = [];

		ws.addEventListener('open', () => {
			// 发送目标地址（二进制格式）
			ws.send(new TextEncoder().encode(targetHost + ':' + targetPort));
			connected = true;
			// 把缓冲的早期数据发出去
			for (const chunk of pendingData) {
				if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
			}
			pendingData = [];
		});

		ws.addEventListener('message', async (event) => {
			const data = await toBuffer(event.data);
			if (data.length === 1 && data[0] === CMD_PONG) return;
			socket.write(data);
		});

		ws.addEventListener('close', (event) => {
			console.log(`[L] WebSocket closed: ${event.code} ${event.reason}`);
			socket.destroy();
		});

		ws.addEventListener('error', (err) => {
			console.error(`[L] WebSocket error: ${err.message}`);
			socket.destroy();
		});

		// 本地 TCP 数据 → WebSocket
		socket.on('data', (chunk) => {
			if (connected && ws.readyState === WebSocket.OPEN) {
				ws.send(chunk);
			} else {
				// WebSocket 还没准备好，先缓冲
				pendingData.push(chunk);
			}
		});

		socket.on('close', () => {
			if (ws.readyState === WebSocket.OPEN) ws.close();
		});

		socket.on('error', (err) => {
			console.error(`[L] Socket error: ${err.message}`);
			if (ws.readyState === WebSocket.OPEN) ws.close();
		});
	});

	server.listen(localPort, () => {
		console.log(`[L] Listening on localhost:${localPort} -> ${targetHost}:${targetPort}`);
		console.log(`[L] Server: ${config.server}`);
	});
}

// ============================================================
// -D 模式：SOCKS5 动态代理
// ============================================================
function startDynamicForward(config) {
	const port = config.dynamicPort;

	const server = net.createServer((socket) => {
		let state = 'handshake';
		let targetHost = '';
		let targetPort = 0;
		let ws = null;

		const cleanup = () => {
			if (ws && ws.readyState === WebSocket.OPEN) ws.close();
			socket.destroy();
		};

		socket.on('data', (chunk) => {
			if (state === 'handshake') {
				if (chunk[0] !== 0x05) { cleanup(); return; }
				socket.write(Buffer.from([0x05, 0x00]));
				state = 'connect';
			} else if (state === 'connect') {
				if (chunk[0] !== 0x05 || chunk[1] !== 0x01) {
					socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					cleanup();
					return;
				}

				const atype = chunk[3];
				let addrStart = 4;
				if (atype === 0x01) {
					targetHost = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
					addrStart = 8;
				} else if (atype === 0x03) {
					const domainLen = chunk[4];
					targetHost = chunk.subarray(5, 5 + domainLen).toString();
					addrStart = 5 + domainLen;
				} else if (atype === 0x04) {
					const parts = [];
					for (let i = 0; i < 16; i += 2) parts.push(chunk.readUInt16BE(4 + i).toString(16));
					targetHost = parts.join(':');
					addrStart = 20;
				} else {
					socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					cleanup();
					return;
				}

				targetPort = chunk.readUInt16BE(addrStart);

				const wsUrl = `${config.server}/proxy`.replace('http', 'ws');
				ws = new WebSocket(wsUrl);

				ws.addEventListener('open', () => {
					ws.send(new TextEncoder().encode(targetHost + ':' + targetPort));
					const reply = Buffer.alloc(10);
					reply[0] = 0x05; reply[1] = 0x00; reply[2] = 0x00; reply[3] = 0x01;
					socket.write(reply);
					state = 'relay';
					console.log(`[D] Connected: ${targetHost}:${targetPort}`);
				});

				ws.addEventListener('message', async (event) => {
					const data = await toBuffer(event.data);
					if (data.length === 1 && data[0] === CMD_PONG) return;
					socket.write(data);
				});

				ws.addEventListener('close', () => {
					if (state === 'connect') {
						socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					}
					cleanup();
				});

				ws.addEventListener('error', () => {
					socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					cleanup();
				});

				state = 'connecting';
			} else if (state === 'relay') {
				if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
			}
		});

		socket.on('close', cleanup);
		socket.on('error', cleanup);
	});

	server.listen(port, () => {
		console.log(`[D] SOCKS5 proxy listening on localhost:${port}`);
		console.log(`[D] Server: ${config.server}`);
	});
}

// ============================================================
// -R 模式：远程转发（注册隧道）
// ============================================================
function startRemoteForward(config) {
	const { localHost, localPort, tunnelId } = config.remoteForward;
	const wsUrl = `${config.server}/tunnel/register?id=${tunnelId}`.replace('http', 'ws');

	console.log(`[R] Connecting to ${config.server} as tunnel "${tunnelId}" ...`);

	const ws = new WebSocket(wsUrl);
	const connections = new Map();

	ws.addEventListener('open', () => {
		console.log(`[R] Tunnel "${tunnelId}" registered`);
		console.log(`[R] External access: ${config.server}/tunnel/connect/${tunnelId}`);
		console.log(`[R] Forwarding to ${localHost}:${localPort}`);
	});

	ws.addEventListener('message', async (event) => {
		const data = await toBuffer(event.data);
		if (data.length < 1) return;
		const cmd = data[0];

		if (cmd === CMD_PONG) return;

		if (cmd === CMD_TUNNEL_NEW) {
			const connId = data.subarray(1).toString();
			console.log(`[R] New connection: ${connId}`);

			const localSocket = net.createConnection({ host: localHost, port: localPort }, () => {
				console.log(`[R] Local connected for ${connId}`);
			});
			connections.set(connId, localSocket);

			localSocket.on('data', (chunk) => {
				const idBuf = Buffer.from(connId);
				const frame = Buffer.alloc(1 + 1 + idBuf.length + chunk.length);
				frame[0] = CMD_TUNNEL_DATA;
				frame[1] = idBuf.length;
				idBuf.copy(frame, 2);
				chunk.copy(frame, 2 + idBuf.length);
				if (ws.readyState === WebSocket.OPEN) ws.send(frame);
			});

			localSocket.on('close', () => {
				const idBuf = Buffer.from(connId);
				const frame = Buffer.alloc(1 + 1 + idBuf.length);
				frame[0] = CMD_TUNNEL_CLOSE;
				frame[1] = idBuf.length;
				idBuf.copy(frame, 2);
				if (ws.readyState === WebSocket.OPEN) ws.send(frame);
				connections.delete(connId);
			});

			localSocket.on('error', (err) => {
				console.error(`[R] Local error (${connId}): ${err.message}`);
				localSocket.destroy();
			});
			return;
		}

		if (cmd === CMD_TUNNEL_DATA) {
			const idLen = data[1];
			const connId = data.subarray(2, 2 + idLen).toString();
			const payload = data.subarray(2 + idLen);
			const sock = connections.get(connId);
			if (sock && !sock.destroyed) sock.write(payload);
			return;
		}

		if (cmd === CMD_TUNNEL_CLOSE) {
			const idLen = data[1];
			const connId = data.subarray(2, 2 + idLen).toString();
			const sock = connections.get(connId);
			if (sock) { sock.destroy(); connections.delete(connId); }
			return;
		}
	});

	ws.addEventListener('close', (event) => {
		console.log(`[R] Disconnected: ${event.code}`);
		for (const [, sock] of connections) sock.destroy();
		connections.clear();
		console.log(`[R] Reconnecting in 3s...`);
		setTimeout(() => startRemoteForward(config), 3000);
	});

	ws.addEventListener('error', (err) => {
		console.error(`[R] Error: ${err.message}`);
	});
}

// ============================================================
// -C 模式：连接远程隧道
// ============================================================
function startConnectTunnel(config) {
	const { localPort, tunnelId } = config.connectTunnel;

	const server = net.createServer((socket) => {
		const wsUrl = `${config.server}/tunnel/connect/${tunnelId}`.replace('http', 'ws');
		console.log(`[C] New connection -> tunnel "${tunnelId}"`);

		const ws = new WebSocket(wsUrl);
		let connected = false;
		const pendingData = [];

		ws.addEventListener('open', () => {
			console.log(`[C] Connected to tunnel "${tunnelId}"`);
			connected = true;
			for (const chunk of pendingData) {
				if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
			}
			pendingData.length = 0;
		});

		ws.addEventListener('message', async (event) => {
			const data = await toBuffer(event.data);
			if (data.length === 1 && data[0] === CMD_PONG) return;
			socket.write(data);
		});

		ws.addEventListener('close', (event) => {
			console.log(`[C] Closed: ${event.code} ${event.reason}`);
			socket.destroy();
		});

		ws.addEventListener('error', (err) => {
			console.error(`[C] Error: ${err.message}`);
			socket.destroy();
		});

		socket.on('data', (chunk) => {
			if (connected && ws.readyState === WebSocket.OPEN) {
				ws.send(chunk);
			} else {
				pendingData.push(chunk);
			}
		});

		socket.on('close', () => {
			if (ws.readyState === WebSocket.OPEN) ws.close();
		});

		socket.on('error', (err) => {
			console.error(`[C] Socket error: ${err.message}`);
			if (ws.readyState === WebSocket.OPEN) ws.close();
		});
	});

	server.listen(localPort, () => {
		console.log(`[C] Listening on localhost:${localPort} -> tunnel "${tunnelId}"`);
		console.log(`[C] Server: ${config.server}`);
	});
}

// ============================================================
// 主入口
// ============================================================
const config = parseArgs();

console.log(`CF Tunnel Client`);
console.log(`===============`);

switch (config.mode) {
	case 'L': startLocalForward(config); break;
	case 'D': startDynamicForward(config); break;
	case 'R': startRemoteForward(config); break;
	case 'C': startConnectTunnel(config); break;
}
