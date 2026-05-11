# CF Tunnel

基于 Cloudflare Workers 的 TCP 隧道服务，借鉴 SSH 隧道的概念（不涉及真实 SSH 协议），支持本地转发、动态转发（SOCKS5 代理）、远程转发三种模式。

## 工作原理

```
-L 本地转发：
  应用 → localhost:8080 → 客户端 → WebSocket → CF Worker → TCP → 远程目标

-D 动态转发（SOCKS5）：
  浏览器 → SOCKS5 localhost:1080 → 客户端 → WebSocket → CF Worker → TCP → 任意目标

-R 远程转发：
  外部用户 → WebSocket → CF Worker（Durable Object）→ WebSocket → 内网客户端 → TCP → 目标服务
```

### 架构

- **服务端**：`_worker.js`，部署为 CF Worker，包含主入口和 Durable Object 类
- **客户端**：`client.mjs`，运行在本地，纯 Node.js 脚本，无第三方依赖（需要 Node.js 22+，使用内置 WebSocket）

### -L / -D 模式

每条连接自包含：客户端通过 WebSocket 发送目标地址，Worker 用 `connect()` 建 TCP 连接，双向转发数据。不需要共享状态。

### -R 模式与 Durable Objects

-R 模式需要"外部用户的连接"和"内网客户端的连接"在同一实例中桥接。普通 Worker 的全局变量在不同 isolate 间不共享，无法可靠实现。

解决方案：使用 CF Durable Objects。每个隧道 ID 对应一个 DO 实例，CF 保证同一 ID 的所有请求路由到同一个实例：

```
内网客户端注册隧道 → WebSocket 长连接保持在 DO 实例中
外部用户连接隧道 → 路由到同一个 DO 实例 → 双向桥接
```

DO 实例在 WebSocket 连接期间保持存活，解决了 isolate 隔离的问题。

## 文件结构

```
cf-tunnel/
├── _worker.js        ← CF Worker 入口 + Durable Object 类（服务端）
├── wrangler.toml     ← Worker 配置（DO binding、migration）
├── client.mjs        ← 本地客户端（Node.js 22+）
└── README.md
```

## 服务端 API

| 路径 | 方法 | 说明 |
|------|------|------|
| `/proxy` | WebSocket | -L / -D 模式，客户端发目标地址，Worker 建 TCP 连接并双向转发 |
| `/tunnel/register?id=<tunnelId>` | WebSocket | -R 模式，内网客户端注册隧道（路由到 DO） |
| `/tunnel/connect/<tunnelId>` | WebSocket | -R 模式，外部用户连接到指定隧道（路由到 DO） |
| `/tunnel/status/<tunnelId>` | GET | 查询指定隧道的在线状态和连接数 |
| `/health` | GET | 健康检查 |

## 客户端使用说明

```bash
node client.mjs <url>
```

URL 格式包含了所有配置信息，`https://` 可省略：

### -L 本地转发

将本地端口转发到远程目标，类似 `ssh -L`。

```bash
node client.mjs https://your-worker.workers.dev/L/<本地端口>/<目标主机>/<目标端口>
```

示例：
```bash
# 访问 localhost:8080 等于访问 httpbin.org:80
node client.mjs https://tunnel.workers.dev/L/8080/httpbin.org/80
curl http://localhost:8080/get

# 访问远程数据库
node client.mjs https://tunnel.workers.dev/L/3306/db.example.com/3306
mysql -h 127.0.0.1 -P 3306 -u root -p
```

### -D 动态转发（SOCKS5 代理）

在本地启动 SOCKS5 代理，通过 CF Worker 访问任意目标。

```bash
node client.mjs https://your-worker.workers.dev/D/<本地端口>
```

示例：
```bash
# 启动 SOCKS5 代理
node client.mjs https://tunnel.workers.dev/D/1080

# curl 通过代理访问
curl --socks5 localhost:1080 http://httpbin.org/get
```

浏览器设置 SOCKS5 代理为 `localhost:1080` 即可通过 CF 出网。

### -R 远程转发（暴露内网服务）

将内网服务通过 CF 暴露到公网，类似 `ssh -R`。需要两步：

**第一步**：内网机器注册隧道（将本地或局域网服务暴露出去）：

```bash
# 暴露本地服务
node client.mjs https://your-worker.workers.dev/R/<本地端口>/<隧道ID>

# 暴露局域网其他主机的服务
node client.mjs https://your-worker.workers.dev/R/<目标主机>/<目标端口>/<隧道ID>
```

**第二步**：外部用户连接隧道（从另一台机器）：

```bash
node client.mjs https://your-worker.workers.dev/C/<本地端口>/<隧道ID>
```

示例（暴露 SSH）：
```bash
# 内网机器 A：暴露本机 SSH
node client.mjs https://tunnel.workers.dev/R/22/myssh

# 内网机器 A：暴露局域网其他机器的 SSH
node client.mjs https://tunnel.workers.dev/R/192.168.1.100/22/myssh

# 外部机器 B：连接到隧道
node client.mjs https://tunnel.workers.dev/C/2222/myssh
ssh -p 2222 user@localhost
```

示例（暴露 Web 服务）：
```bash
# 暴露本机 Web 服务
node client.mjs https://tunnel.workers.dev/R/3000/myweb

# 暴露局域网 NAS 的 Web 管理界面
node client.mjs https://tunnel.workers.dev/R/192.168.1.50/5000/nas
```

> **注意**：-R 模式的隧道 ID 只能包含字母、数字、下划线和短横线。

## 部署说明

### 前提

- Cloudflare 账号（免费计划即可，Durable Objects 使用 SQLite 模式无需付费）
- Node.js 22+
- 安装 wrangler：`npm install -g wrangler`

### 步骤

**1. 登录 CF**

```bash
wrangler login
```

**2. 部署**

```bash
cd cf-tunnel
wrangler deploy
```

首次部署会自动创建 Worker 和 Durable Object namespace。部署完成后得到一个 `https://cf-tunnel.<your-account>.workers.dev` 的域名。

**3. 验证**

```bash
curl https://cf-tunnel.xxx.workers.dev/health
# 返回：{"status":"ok"}
```

### 更新部署

修改代码后重新执行：

```bash
cd cf-tunnel
wrangler deploy
```

### 自定义域名

在 CF Dashboard → Workers & Pages → cf-tunnel → Settings → Domains & Routes 中绑定自己的域名。

### wrangler.toml 说明

```toml
name = "cf-tunnel"                    # Worker 名称
main = "_worker.js"                   # 入口文件
compatibility_date = "2024-12-01"     # CF 运行时版本

[[durable_objects.bindings]]
name = "TUNNEL_DO"                    # 环境变量中的绑定名
class_name = "TunnelDO"               # _worker.js 中导出的 DO 类名

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TunnelDO"]     # 使用 SQLite 模式（免费计划可用）
```

## 本地开发

使用 `wrangler dev` 在本地启动开发服务器，修改代码后自动重载。

### 启动

```bash
cd cf-tunnel
npx wrangler dev --port 9876
```

启动后本地服务地址为 `http://localhost:9876`。

### 本地测试

```bash
# 健康检查
curl http://localhost:9876/health

# -L 模式测试
node client.mjs http://localhost:9876/L/8080/httpbin.org/80
curl http://localhost:8080/get
```

> **注意**：wrangler 本地模式的 `connect()` 有网络限制，连接外部地址可能报 "Network connection lost"。正式测试建议部署到 CF 后进行。

### 关闭

按 `Ctrl+C` 停止 wrangler 进程。如果进程残留未退出：

```bash
# 查看残留进程
ps aux | grep -E 'wrangler|workerd'

# 清理所有 wrangler/workerd 进程
pkill -f wrangler; pkill -f workerd
```

> `workerd` 是 wrangler 底层使用的 Worker 运行时，每个 wrangler 实例会启动多个 workerd 子进程。正常退出时会自动清理，直接关闭终端可能残留。

## 协议细节

### 通信帧格式

WebSocket 使用二进制帧通信，协议常量：

| 常量 | 值 | 说明 |
|------|-----|------|
| CMD_TUNNEL_NEW | 0x10 | DO → 内网客户端：有新的外部连接 |
| CMD_TUNNEL_DATA | 0x11 | 隧道数据帧 |
| CMD_TUNNEL_CLOSE | 0x12 | 关闭隧道连接 |
| CMD_PING | 0xFF | 心跳 |
| CMD_PONG | 0xFE | 心跳回复 |

### /proxy 流程（-L / -D 模式）

```
1. 客户端连接 WebSocket
2. 客户端发送第一条消息：目标地址（"host:port" 的 UTF-8 编码）
3. Worker 解析地址，用 connect() 建 TCP 连接
4. 连接建立后，后续消息直接转发到 TCP socket
5. TCP 返回的数据通过 WebSocket 发回客户端
```

### /tunnel 流程（-R 模式）

```
1. 内网客户端连接 /tunnel/register?id=xxx
   → 主 Worker 路由到 tunnelId 对应的 DO 实例
   → DO 存储 WebSocket，开始心跳（每 30 秒）
2. 外部用户连接 /tunnel/connect/xxx
   → 主 Worker 路由到同一个 DO 实例
   → DO 分配 connId，发送 CMD_TUNNEL_NEW + connId 给内网客户端
3. 内网客户端收到后建本地 TCP 连接
4. 双向数据通过 CMD_TUNNEL_DATA 帧转发：
   [CMD_TUNNEL_DATA][connId长度 1字节][connId][payload]
5. 关闭时发送 CMD_TUNNEL_CLOSE 帧
```

### 心跳机制

- DO 每 30 秒向注册的隧道客户端发送 CMD_PING
- -L/-D 模式的客户端可主动发送 CMD_PING，Worker 回复 CMD_PONG

## 局限性

1. **无鉴权**：目前没有用户认证，任何人都可以使用你的 Worker。如有需要可通过 URL token 或 HTTP header 实现。
2. **无加密**：数据通过 WebSocket 传输，依赖 CF 的 TLS 加密（wss://），隧道本身不做额外加密。
3. **不支持 UDP**：CF Workers 的 `connect()` 只支持 TCP。
4. **DO 单实例限制**：-R 模式的隧道状态存在 Durable Object 中，DO 实例在无连接时会休眠，但 WebSocket 长连接会保持 DO 存活。
