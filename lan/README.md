# 同一间 · 独立局域网听音室

这是仓库内独立的 `lan/` 应用，不是桌面版或旧 `web/` 的移植。没有引用、复制原项目的界面、插件或音频实现；账号、配置和数据也不共用。

**浏览器只负责遥控。声音只从 Linux 服务器连接的 USB 声卡 / 3.5mm 输出。** 所有人操作同一台 mpv、同一个当前播放项和同一个待播队列，不存在每个浏览器各自播放的模式。

## 当前验证状态

- 第一版共享协议、后端、前端及测试已编写，新增内容与原项目隔离。
- **依赖已安装，锁文件已核查；类型检查通过；15 个测试文件通过，156 项测试通过、3 项按平台跳过。** 安装生命周期脚本一直保持禁用。
- 生产构建已通过（shared dts、server dist、web dist）；`npm audit`（含开发依赖）为 0 漏洞，`npm ci --dry-run` 可从锁文件精确复现。仍未启动真实服务、创建部署账号、部署或验证 Linux 声音，不能视为完整交付。
- 实际结果、修复内容、平台跳过项及剩余限制见 [验证记录](docs/verification.md)。固定版本与安装方法见 [依赖清单](docs/dependencies.md)。
- 验证环境为 Windows、Node 24.16.0、npm 11.13.0；运行目标为 Node **24+** / npm **11+**。真实音频仍需 Linux，Windows 仅支持显式开发模拟。

## 第一阶段实际能力

| 能力 | 范围 |
| --- | --- |
| 本地曲目 | 启动时扫描一个明确配置的 `MUSIC_ROOT`；标题来自文件名，不读取完整标签库 |
| 查询 | 按曲名做不区分大小写的字面子串搜索、分页；歌手、专辑、目录时长暂为 `null` |
| 点歌 | 所有已登录用户追加已知曲目；重复曲目是不同队列项；点歌不抢播、不自动启动空闲播放器 |
| 待播队列 | 最多 500 项；点歌接口在该用户已有 50 项待播时拒绝继续添加 |
| 播放控制 | admin / dj：播放、暂停、上一首、下一首、绝对定位、0–100 整数音量、独立静音 |
| 多人同步 | 后端权威完整快照；HTTP 修改 + WebSocket 推送；断线禁用操作、重连不自动重发修改；页面恢复或网络变化后重新校验，不信任可能已半开的连接 |
| 账号 | 非公开注册；首个管理员本机交互创建；管理员随后创建账号、改变角色 |
| 保存 | SQLite 保存账号、会话、目录身份、待播顺序、音量 / 静音设置、中断的当前曲目与位置 |

权限不是前端按钮约束，服务端会重新检查会话和角色。

| 操作 | user（听众） | dj（主持人） | admin（管理员） |
| --- | --- | --- | --- |
| 查曲目、看状态、点歌 | 是 | 是 | 是 |
| 移除自己的待播项 | 是 | 是 | 是 |
| 移除别人的待播项 | 否 | 是 | 是 |
| 控制播放器 / 音量 / 定位 | 否 | 是 | 是 |
| 列出 / 创建账号、改角色 | 否 | 否 | 是 |

当前项和历史项不属于 WAITING，任何角色都不能通过“删除队列项”移除它们。上一首会把被替换的当前项放回队首；若队列已满则整体拒绝。该内部返还不受点歌接口的每人 50 项门槛限制，但仍受全局 500 项限制。自然播完自动进入下一项；坏文件不会被假装成播放成功。

角色真正变化时，该账号的所有会话立即失效；同角色更新不退出。最后一名管理员不能被降级。会话绝对有效期为 12 小时，不滑动续期；同账号至多 10 个会话、每会话至多 3 个实时连接。

**重启不会自动出声，但会记住中断在哪。** 保留待播顺序、设备设置，以及中断的当前曲目和播放位置；该曲目以**暂停**状态恢复，必须先显式点播放，服务不会自动续播。恢复后的首次播放会重新装载文件并定位到保存的位置，不会从头重放。内存中的上一首 / 下一首历史不保留。新的进程有新的实例 ID 和新的播放标识，旧页面的过期操作不能作用于新播放。

没有 NAS 浏览、上传、网易云、收藏、封面服务、歌词、完整元数据库、插件系统、队列排序 / 一键清空、密码重置 / 修改、账号删除或音频下载接口。模拟模式不能代替真实音频验收。

## 架构与目录

- `packages/shared/src/`：Zod 3 严格请求 / 响应协议与权限辅助函数。
- `apps/server/src/`：Fastify 5、Node 自带 `node:sqlite`、异步 scrypt、串行控制协调器、私有 mpv JSON IPC。
- `apps/web/src/`：Vue 3 + TypeScript + Pinia 独立中文遥控界面，不使用浏览器音频 API。
- `docs/protocol.md`：完整线协议、幂等 / 实例 / 修订 / 播放 ID 规则。
- `deploy/`：未部署的 Linux systemd 与生产环境示例。

后端不接受客户端文件路径、媒体 URL 或原始 mpv 命令。会话 Cookie 为 HttpOnly、SameSite=Strict、Path=/api，生产额外 Secure。写请求包含精确 Origin 和会话绑定 CSRF；WebSocket 使用 Cookie 与两个子协议 `lan.v1`、`csrf.<token>`，不把令牌放到 URL。日志和代理也不得记录这些认证头或登录请求正文。

## 开发准备（批准后才执行）

所有 npm 命令都在 **`lan/`** 目录运行，绝不能在仓库根目录安装或运行旧应用。没有自动创建的账号或密码，没有 `root` 应用角色；Linux 服务与 bootstrap 均拒绝 OS root。

### 1. 审核、安装、验证

先审阅依赖清单和有效 npm 配置，确认直接依赖的精确版本、peer / engine 及所有实际来源。`.npmrc` 默认禁止安装生命周期脚本，不使用镜像站。

审核随项目提供的 `package-lock.json` 后，使用锁定安装：

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
```

不要把根目录锁文件复制过来，也不要从 Windows 复制 `node_modules` 作为 Linux 的安装结果。更新依赖时需重新审核版本、来源和完整性字段，不能静默切换镜像或启用安装脚本。

安装后运行以下检查：

```sh
npm run typecheck
npm test
npm run build
```

本次类型检查、测试与构建均已通过，详见 [验证记录](docs/verification.md)。忽略安装脚本不表示构建 / 测试工具不会执行外部代码。如 esbuild 等工具因安装脚本被禁而不可用，应先明确具体需求，不要直接取消全部限制、执行 rebuild 或切换来源。

测试仅注入 fake driver、使用临时文件 / 内存 SQLite 与 HTTP 注入、socket doubles；不会启动 mpv。Linux procfs / symlink 测试有平台条件，不能把 Windows 上跳过的用例当成通过。新增生产静态资源与 `/api` 认证隔离用例在 `apps/server/tests/static-auth.test.ts`，队列、角色撤销与重试用例在 `apps/server/tests/coordinator.test.ts`。没有真实浏览器、代理、WebSocket 网络握手或物理音频通过记录。

### 2. 配置受控目录

审核 `lan/.env.example` 后，手工在 `lan/` 建立本地 `.env`。该文件不提交；所有相对 `MUSIC_ROOT` / `DATA_DIR` 路径都相对于 `lan/`，不是终端当前目录。

| 配置 | 开发示例 / 要求 |
| --- | --- |
| `NODE_ENV` | `development` |
| `HOST` | `127.0.0.1`，仅另允许显式 `::1`，拒绝 `0.0.0.0` / `::` |
| `PORT` | `41840` |
| `PUBLIC_ORIGIN` | `http://localhost:5174`，必须与浏览器地址精确一致，无尾部 `/` |
| `MUSIC_ROOT` | `./music`；必须预先准备、只含受信任的本地音频文件 |
| `DATA_DIR` | `./data`；独立私有目录，不得复用原项目数据 |
| `MPV_PATH` | `/usr/bin/mpv`，绝对可执行路径 |
| `MPV_AUDIO_DEVICE` | `auto` 仅用于未选设备的开发准备；真实验收应选定准确设备 |
| `DEV_SIMULATION` | 默认 `false`，不会静默降级 |

music、data、web 构建输出三个目录必须相互独立；根路径和祖先路径不能含 symlink / junction。Linux 数据目录必须归服务账号所有，程序使用 0700 目录、0600 数据库和私有锁。不要把代码、数据库、音乐目录放在可被不受信任用户改写的位置。

固定音频扩展名允许列表：`.flac`、`.mp3`、`.m4a`、`.aac`、`.ogg`、`.opus`、`.wav`、`.aif`、`.aiff`，不区分大小写。跳过符号链接、非普通文件和播放列表；最多 10000 个音频文件、50000 个扫描目录项，根目录以下最多深入 12 层。超出总量限制启动失败；更深层目录不扫描。扩展名不是音频有效性的证明，播放仍可能报错。

目录只在服务启动时扫描，没有“刷新目录”HTTP 接口。更新曲目应停服后维护，再启动扫描；不要在播放中改写同一个 inode。载入时还会检查文件身份并通过 `/proc/<server-pid>/fd/<fd>` 固定已打开文件。替换文件会在重新扫描时获得新的曲目 ID，旧队列项不能悄悄转播替换内容；管理员应移除过时待播项。

### 3. 创建首个管理员

先成功构建，准备好环境配置，并确保该 `DATA_DIR` 没有服务运行。以未来服务使用的**同一个非 root OS 账号**在真实交互终端执行。

```sh
npm run admin -- bootstrap --username room-admin
```

`room-admin` 是你在命令中选择的账号名示例，不会自动创建。用户名为 3–32 位 ASCII 小写字母 / 数字 / 点 / 下划线 / 短横线，首位为字母或数字。密码需要 12–128 个 JavaScript 字符串码元，两次输入、不回显、不裁剪；不能通过参数、环境变量或重定向传密码。

bootstrap 只允许空账号表；已有账号时不能覆盖或当作重置密码使用。没有找回密码接口，需保管管理员凭据；不要为了“修复登录”删除真实数据库。之后用浏览器中的管理员账号创建 dj / user。

### 4. 启动开发进程

**Linux 真播放器**：保持 `DEV_SIMULATION=false`，先确认 mpv、procfs 和音频设备权限。

**Windows / 无 mpv 的开发机**：只能主动设置 `NODE_ENV=development` 与 `DEV_SIMULATION=true`。仅此组合允许模拟；生产或 test 环境配置模拟会被拒绝。模拟仍扫描真实受控文件并保存自己的队列 / 数据，但不解码、不出声、不推断时长，也不模拟自然 EOF；界面持续显示“不实际发声”。不要使用生产数据做模拟。

在 `lan/` 的两个独立终端中分别运行以下命令（需运行批准）。

```sh
npm run dev:server
```

```sh
npm run dev:web
```

打开 `http://localhost:5174`。Vite 只监听本机，端口占用时直接失败而不是自动换端口；它把 `/api` HTTP 与 WebSocket 转发到 `127.0.0.1:41840`，保留原 Host / Origin。不得通过直接访问 `127.0.0.1:41840` 绕开此规则。修改后端端口 / IPv6 绑定时，必须同步审核 `apps/web/vite.config.ts` 中的 proxy target。

注意：`npm run dev:web -- --port 5199` 不生效——npm 会把 `--port` 当成自己的配置吞掉（并打印 `Unknown cli config`），Vite 仍监听 5174。要换端口请直接改 `apps/web/vite.config.ts`，或绕过 npm 调用 `npx vite --port 5199`。

浏览器访问 `127.0.0.1:5174` 与 `localhost:5174` 不是同一 origin；不能混用地址后再关闭 Origin 检查。开发服务器没有对其他 LAN 设备开放的配置。生产静态页面也不会在开发模式下由后端提供。

## Linux 原生生产运行（示例未部署）

### 构建产物与启动方式

生产仍是原生 Node + mpv，不需要 Docker 或 Electron。构建输出为：

- `apps/server/dist/index.js`：后端 ESM 入口。
- `apps/server/dist/admin.js`：本机管理入口。
- `apps/web/dist/index.html` 与 assets：独立浏览器界面。
- `packages/shared/dist/`：共享包的构建产物；服务端已把共享代码打入 bundle。

共享包的开发 exports 指向 TS 源码；服务端 tsup 通过 `noExternal: ['@lan/shared']` 打包它。**不要用普通 Node 直接运行服务端 TS 源码，也不要把 dist/index.js 当成无需依赖的单文件。** Fastify、Zod、ws 和插件仍需要审核过的 npm runtime dependencies。保留 `lan/` 目录结构与已安装依赖；不要单独移动 dist 文件，否则数据 / web 路径定位会改变。

将配置明确设为 `NODE_ENV=production`、`DEV_SIMULATION=false`、HTTPS `PUBLIC_ORIGIN`，并准备选定的 mpv 设备。`npm start` 不会替你设置 production。审核后的 `.env` 配置下，从 `lan/` 的交互启动为：

```sh
npm start
```

它只启动已构建后端，不执行 tsx / Vite dev server；后端只公开 `apps/web/dist` 的静态资源。缺少真实输出目录或普通 `index.html` 会拒绝启动。`/api` 整个命名空间预留给 JSON API，未知路径不会回退到 SPA 或同名构建文件。源码、音乐和数据库均不得由其他代理 location 暴露。

### HTTPS 反向代理

后端始终只在 loopback 监听。要让 LAN 设备访问，运营者需**另行批准并配置**只对可信内网开放的 HTTPS 代理、DNS / 主机名、防火墙和客户端信任的 TLS 证书；此仓库没有安装、开放或部署代理。示例域名 `music.example.test` 只是待替换值。

代理必须：

1. 使用唯一的 `PUBLIC_ORIGIN`（如 `https://music.example.test`，有自定义端口时必须包含端口）。禁止公网转发、UPnP 暴露、任意 Host 或通配 CORS。
2. 转发到 `http://127.0.0.1:41840`，保留公开 Host **及端口**、原始 Origin，支持 HTTP/1.1 Upgrade / Connection 的 WebSocket 升级；升级后的读取超时应大于 60 秒。
3. 不缓存 `/api`，不删改 CSRF / Cookie，不记录 Cookie、Set-Cookie、X-CSRF-Token、Sec-WebSocket-Protocol 或密码正文。
4. 不把其他文件目录挂到静态路由。后端 `trustProxy=false`，不能依赖伪造的 X-Forwarded-* 改 Host 或识别登录者。

例如使用 nginx 时，Host 应保留 `$http_host` 而非丢失非默认端口；Origin 应保留 `$http_origin`。具体 TLS、监听网卡、升级映射和日志配置需由运营者审核，不能直接把开发端口改成全网卡监听来替代。

使用 Caddy 时不要写 `header_up Host {http.request.host}`：它会丢掉非默认端口，使后端按 Host 校验返回 403 `ORIGIN_REJECTED`（连 `GET /` 都 403，看起来像整站故障）；应使用 `{http.request.hostport}`，或干脆不写（Caddy 默认保留原始 Host）。排障提示：WebSocket 握手必须走 HTTP/1.1；用 `curl` 排障时若默认协商到 HTTP/2 再发升级头会得到 404，浏览器不受此影响。

当前登录限流按真实 TCP 对端 IP，代理后多个用户会合并为 loopback 的每分钟 10 次登录额度；一般请求按已认证会话 120 次 / 分钟，修改 30 次 / 分钟。不要简单开启任意 `trustProxy` 来绕开登录额度。

### systemd 示例

文件为 [服务单元](deploy/lan-music.service) 与 [生产环境](deploy/lan-music.env.example)。它们未部署，假设运营者已审核并准备：

- 真实规范路径 `/opt/lan-music/lan`（不通过 `current` 等符号链接启动），对应平台上安装 / 构建好的应用。
- 专用非 root OS 用户和组 `lan-music`；程序目录只读，不允许该账号改写源码 / 依赖。
- 私有数据目录 `/var/lib/lan-music`，属主为该账号；音乐目录 `/srv/lan-music/music` 对它可读、对不可信用户不可写。首次 bootstrap 前数据目录也必须已准备好。
- `/usr/bin/node` 确实是 Node 24+；`/usr/bin/mpv` 的版本和支持选项已经单独核验。未提供任何 OS 软件安装脚本。
- `/etc/lan-music/lan.env` 来自审核并修改后的 env 示例，对服务账号可读；没有密码或自动生成账号。
- 示例走 **ALSA / audio 组** 访问本地设备，并假定发行版存在 `audio` 组。需核对实际 `/dev/snd` 权限、设备名称和独占占用情况，不能原样假定每台 Linux 都相同。

服务单元不使用 npm、不自动安装 / 构建 / bootstrap。它保留 `/dev/snd` 可见、限制文件系统写入并使用私有临时目录。桌面会话 PipeWire / PulseAudio 的 socket / XDG_RUNTIME_DIR 与此系统服务不同；若选择它们，需要单独设计用户级服务和权限，不能冒用另一个桌面用户的运行目录。容器、隐藏 procfs、跨 UID 限制可能使固定文件描述符不可用，应在部署前验证。

在真实终端以正确用户 bootstrap 的候选命令如下；仍需单独批准，密码只在该终端隐藏输入。

```sh
sudo -u lan-music /usr/bin/node --env-file=/etc/lan-music/lan.env /opt/lan-music/lan/apps/server/dist/admin.js bootstrap --username room-admin
```

运营者审核并把单元安装到系统后，候选管理命令为：

```sh
sudo systemctl daemon-reload
sudo systemctl start lan-music.service
sudo systemctl status lan-music.service
journalctl -u lan-music.service
sudo systemctl stop lan-music.service
```

这些系统级操作均未执行；本例也不自动 enable 开机启动。正常停止由 Node 关闭自己的 mpv 子进程、IPC 和 SQLite，再释放锁。强杀 / 断电可能留下 `service.lock` 和仍在出声的 mpv：下一次启动会在确认锁记录的属主**确已消失**后接管该锁，并按 uid 与私有 socket 目录回收残留 mpv（只处理指向 `lan-mpv-*` 私有目录、且属于服务账号的进程）。属主仍存活、记录不可读，或 PID 被重用（会表现为存活）时一律 fail closed。示例已改为 `Restart=on-failure`，受监督的服务因此可在崩溃后自行恢复，而不会无限重试一个持锁状态。

备份与升级均应先停服。备份整个私有数据目录，而不是运行中只复制 `lan.sqlite` 忽略 WAL；备份包含密码摘要和会话，同样需要私有权限。不要把备份放到 webDist。恢复后等待队列不会自动出声。

## 真实声音验收清单（全部未做）

先批准执行范围，使用已审核的 Linux、Node、mpv 和一小组受控测试音频，降低外部功放 / 扬声器音量。以下 mpv 检查命令也会执行外部程序，目前没有运行。

```sh
/usr/bin/mpv --version
/usr/bin/mpv --no-config --audio-device=help
```

1. 核对 mpv 的设备列表及本程序所用选项，选择准确 `MPV_AUDIO_DEVICE`，避免 `auto` 跟随默认声卡变化。可在**应用停服期间**另行批准一段已知文件的 mpv 单独试听，以区分 OS 音频故障与应用问题；不要同时运行两个播放器竞争设备。
2. 以实际服务用户启动真模式，确认没有“模拟模式”横幅。用两台不同浏览器 / 设备登录，检查同一快照、队列顺序与身份；浏览器网络不应出现媒体流 / 音频下载请求，也不应从客户端发声。
3. user 点歌后保持空闲；由 admin / dj 开始，听到服务器实际 USB / 3.5mm 输出。确认暂停、继续、0–100 音量和静音确实作用于该设备。初始音量为 35，后续沿用保存值；首次试听仍要先调低外部设备音量。
4. 真实 mpv 提供时长后，拖动定位滑块确认松开才提交、物理输出位置跟随；跨曲目拖动不应错误定位下一首。目录列表未知时长不是故障。
5. 两首真实短音频自然结束应只推进一项；同时点击下一首与自然 EOF 不得双跳。上一首、空队列下一首、坏文件、删除 / 替换文件需呈现明确状态，不可静默使用模拟驱动。
6. 验证 user 只能移除自己的待播项，dj 不能创建用户；角色变更使该账号所有旧页面退出，旧 Cookie / 请求不可继续控制；最后管理员不能降级。
7. 断网后按钮禁用，重连只读新状态、不重发旧点歌 / 下一首。停止并重启服务，确认待播保留、当前项以暂停状态保留且位置不变、不回队列、必须显式点播放才会出声；点播放后应从保存的位置继续，而不是从头开始。
8. 受控地停止本服务拥有的 mpv，或在停服后移除选定设备再重启，检查显式错误及无 fallback；不要杀其他人的播放器。最后检查正常停服无遗留音频进程 / IPC、数据仍可恢复。

源代码静态检查和 fake 测试即便日后通过，也不证明代理、浏览器兼容性或 USB / 3.5mm 声音已通过。请分别记录 Node / mpv / Linux 版本、设备名称、命令结果、平台跳过测试及实际听音结果，再决定是否投入使用。
