# VutronMusic Web

VutronMusic 的局域网 Web 版：浏览器打开即用，界面与桌面版同源（复用 `src/renderer`），
服务器持有权威播放状态并出声，多个浏览器同步播放并由被授权账号共同控制。

## 与桌面版的区别

| 维度 | 桌面版 | Web 版 |
| --- | --- | --- |
| 界面 | Electron 窗口 | 复用同一套 Vue 渲染层，浏览器打开 |
| 数据与插件 | Electron IPC + 主进程 Worker | HTTP + WebSocket（`src/renderer/web` 为 IPC→HTTP 适配层） |
| 播放发声 | 本机音频 | 服务器端 mpv/ffplay 出声，浏览器同步出声 |
| 账号 | 无（单机） | 多账号，收藏/歌单/设置按用户隔离；播放会话共享 |
| 音源 | 本地 / 在线平台 / 自建流媒体 | 同左；在线以网易云为主，本地由服务器目录扫描 |

## 架构

```
浏览器（Vue 渲染层 + web shim）
  │  fetch /api/*            WebSocket /ws（播放状态推送）
  ▼
Fastify 服务端（web/server）
  ├── auth/admin       站点账号、角色、会话（scrypt + Cookie/Bearer）
  ├── playback         权威播放状态机 + mpv/ffplay 输出驱动
  ├── media            本地文件 Range 流 / 上游代理（令牌化，不含凭据与绝对路径）
  ├── plugins          插件宿主（Node Worker，复用 src/public/plugin/*.js，Zod 校验）
  ├── library          服务器本地音乐扫描、浏览、封面、歌词
  ├── netease          网易云 API 代理（内置插件 baseUrl 指向它）
  └── me               个人收藏 / 歌单 / 设置
```

## 运行

前置：Node ≥ 22.6，服务器上存在音频输出设备（`mpv` 或 `ffplay`），可选 `ffmpeg`。

```bash
# 依赖（仅服务端；前端复用仓库根 node_modules）
cd web && npm install

# 配置（可选，见 .env.example）
cp .env.example .env

# 开发：服务端 + 前端 dev server（41832，代理 /api、/ws 到 41831）
cd web && npm run dev:server
cd web && npm run dev:client

# 生产：构建前端后由服务端托管
cd web && npm run build:client
cd web && npm start
```

首次启动会创建初始管理员：`VW_ADMIN_USER`（默认 `admin`）；
口令取 `VW_ADMIN_PASSWORD`，为空时随机生成并写入 `<VW_DATA_DIR>/INITIAL_ADMIN.txt`。
首次登录必须修改口令，修改成功后该文件会被删除。

局域网访问：`http://<服务器IP>:<VW_PORT>`（默认 41831，监听 `0.0.0.0`）。

## 账号与权限

- 角色：`admin` / `user`。管理端可创建、禁用、删除账号与重置口令，`GET /api/admin/users`。
- 播放控制：`admin` 或 `users.can_control = 1` 的账号可操作服务器播放会话（`POST /api/playback/command`）。
  未授权账号可浏览、搜索、管理自己的收藏与歌单，但不能切歌。
- 个人数据（收藏、歌单、设置）按 `user_id` 严格隔离，越权访问返回 404。
- 音乐平台凭据（网易云 Cookie、Jellyfin 账号等）保存在插件实例自己的 `plugin_state` 中，
  既不下发给浏览器，也不会出现在媒体 URL 里。

## 播放与同步

- 服务器是唯一权威：`playback_state` 保存队列与位置锚点 `{positionMs, updatedAt, playing}`。
- 状态变更通过 `/ws` 广播 `playback:state`（含 `seq` 与 `reason`），播放中每 10s 一次心跳用于再同步。
- **曲目推进只由服务器决定**：浏览器播完只上报（`vwWeb.onLocalTrackEnded`），绝不自行切下一首；
  否则浏览器与服务器各自推进一步，会表现为跳曲、顺序错乱与队列里堆副本。
- 浏览器端 `serverMirror` 把服务器状态应用到本地播放器，并按漂移做校正：
  偏差 > 2s 直接 seek，> 0.12s 用 ±2% 播放速率微调，其余保持 1.0。
- 浏览器发起的操作按语义翻译成服务器命令，避免队列膨胀：
  - 落在服务器队列的下一首/上一首 → 发 `next` / `previous`（服务器自会推进）；
  - 任意跳转 → 用当前列表 + 下标发 `queue-set`（原子替换队列）；
  - 服务器还没有队列时才用 `play-now`。
- 事件监听使用同步触发（`flush: 'sync'`）+ `applying` 标志隔离「服务器驱动」与「本地发起」，避免命令回环。
- 播放/暂停上报有 250ms 去抖：换曲时本地播放态会瞬时抖动，避免在服务器上产生多余的 pause→play。
- 进度上报只在「跳变幅度与服务器期望位置同样偏离」时才当作拖动进度条，避免事件循环卡顿被误判成 seek。
- 媒体地址为 `/api/media/<token>`：16 字节随机、默认 12 小时过期、只发给已登录客户端，
  等价于一次性预签名地址，服务器输出进程与 `<audio>` 都能直接抓取。

排查播放同步时，可在浏览器控制台执行 `localStorage.setItem('vw-mirror-debug','1')` 后刷新，
镜像会输出收到的状态、判定明细与发出的命令；`localStorage.removeItem('vw-mirror-debug')` 关闭。

## 音源

- **网易云（library）**：内置 `netease.js` 由服务端 Worker 执行，其 `baseUrl` 启动时被指向
  `<origin>/netease`（仅在未配置或仍指向桌面版默认值时改写）。代理路由见 `web/server/netease`。
- **本地音乐（local）**：目录由服务器配置（`VW_MUSIC_DIRS` 或 `PUT /api/library/roots`），
  启动时写入 local 插件的 `scanDir`；扫描入库到 `local_tracks`，供插件与浏览接口共用。
- **Jellyfin / Navidrome / Emby（stream）**：插件在服务端 Worker 运行，账号在界面中配置，
  媒体经媒体令牌代理，凭据不下发。

## 目录与配置

| 路径 | 说明 |
| --- | --- |
| `web/server` | 服务端（Fastify） |
| `web/shared/contract.ts` | 前后端共享契约（状态、动作、API 路径） |
| `web/dist/client` | 前端构建产物 |
| `web/data` | 运行时数据（SQLite、缓存、初始口令文件），已在 `.gitignore` 中 |
| `src/renderer/web` | 浏览器 shim：`mainApi`、登录闸门、实时通道、播放镜像 |
| `web/vite.config.ts` | 前端构建配置（root 指向 `src/renderer`，产物落到 `web/dist/client`） |

环境变量见 `.env.example`。

## 已知边界

- 界面按 `window.env.isWeb` 裁剪桌面专属项：设置页只保留「通用」「音乐设置」两组，
  托盘/桌面歌词窗口/全局快捷键/解灰/杂项/更新等入口整组隐藏；播放栏去掉桌面歌词按钮；
  导航菜单去掉 GitHub 与打开日志（保留登录/登出）；登录页去掉系统目录选择（保留手动输入路径）；
  背景设置的本地文件浏览、歌词设置的系统字体下拉同样隐藏。桌面版（`isWeb` 为 undefined）DOM 与行为不变。
- 循环/随机模式不镜像到浏览器：桌面版 `repeatMode` 与服务器 `'list' | 'one' | 'shuffle'` 语义不完全对应。
- CUE 分轨曲目的位置以分轨相对秒计，暂不与服务器绝对位置对齐。
- 桌面专属通道在 Web 版返回默认值（`console.debug` 记录），对应入口已隐藏，不影响其余功能。
- 网易云解灰使用默认来源列表，Web 版暂无对应设置界面与代理配置。
- 需要公网直接访问时应置于 HTTPS 反向代理之后；变调等 AudioWorklet 功能要求安全上下文。
