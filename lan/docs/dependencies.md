# 依赖与构建说明

## 当前验证状态

外部依赖来自 [npm 官方仓库](https://registry.npmjs.org/)。直接依赖版本元数据已查询；锁文件由 npm 实际生成，已核查外部包的下载来源和 integrity 字段。安装时没有运行生命周期脚本。

类型检查、自动测试和生产构建均已通过；运行时依赖审计已处置（`npm audit --omit=dev` 为 0 漏洞），开发工具链仍有少量公告待处理。完整执行结果和已知限制见 [验证记录](verification.md)。版本固定、来源正确或测试通过，都不代表不存在依赖漏洞。

环境要求：Node.js **24+**，npm **11+**；本次使用 24.16.0 / 11.13.0。SQLite 使用 Node 自带的 `node:sqlite`，不需要安装原生 SQLite npm 插件。Linux mpv 是单独的系统依赖，没有任何 npm 脚本会安装 mpv、创建 OS 用户或配置声卡。

## 固定版本

所有直接外部依赖均使用精确版本，不使用 `latest`、`^` 或 `~`。`@lan/shared@0.1.0` 是本地私有 workspace，不从公共 registry 下载。

| 包 | 版本 | 用途 |
| --- | --- | --- |
| fastify | 5.12.5 | HTTP 服务 |
| @fastify/cookie | 11.0.2 | 会话 Cookie |
| @fastify/static | 10.1.5 | 生产前端静态资源 |
| @fastify/websocket | 11.2.0 | 实时事件 |
| ws | 8.22.0 | WebSocket 与测试替身类型 |
| zod | 3.25.76 | 共享协议和请求 / 响应校验 |
| vue | 3.5.22 | 网页遥控界面 |
| pinia | 3.0.3 | 前端状态 |
| vite | 7.3.1 | 前端开发和打包 |
| @vitejs/plugin-vue | 6.0.1 | Vue 单文件组件编译 |
| @types/node | 24.10.1 | Node 24 类型 |
| @types/ws | 8.18.1 | WebSocket 类型 |
| typescript | 5.9.3 | 类型检查 |
| tsx | 4.20.5 | 服务端开发加载器 |
| tsup | 8.5.0 | 服务端 / 共享包打包 |
| vitest | 4.0.18 | 单元和集成测试 |
| vue-tsc | 3.2.4 | Vue 类型检查 |

后端使用自身的有界 `RateLimiter`，不依赖最初建议但未采用的 `@fastify/rate-limit`。

根级 `overrides` 将工具链中的 Vite 统一为 7.3.1，避免 Vitest 的传递依赖和网页 workspace 分别安装不同 Vite，造成插件类型不兼容。没有关闭严格类型检查来掩盖该问题。现有代码使用 Zod 3 API，不应直接替换成 Zod 4。

`@fastify/static` 从 8.3.0 升到 10.1.5：插件自身的兼容表写明 `>=8.x` 对应 Fastify `^5.x`，所以仍属 Fastify 5 线。v10 把 `setHeaders` 的回调参数从原始 ServerResponse 改成 Fastify Reply（`fn(reply, path, stat)`），`apps/server/src/app.ts` 已改用 `reply.header(...)`，并由 `static-auth.test.ts` 断言该响应头确实生效——这是跨大版本升级中唯一需要改代码的地方。

## 来源与锁文件

- `.npmrc` 指定官方 registry、精确保存版本、严格检查运行时、禁用安装脚本和自动 audit / funding 请求。
- 安装前检查用户、环境及 scoped npm 配置，不要因为官方源失败就自动切换镜像或 Git 来源。
- 当前锁文件包含 289 个外部包记录，均为 HTTPS 官方 registry 来源且有 integrity；其中包含跨平台可选包，不等于当前平台实际安装包数。（升级 `@fastify/static` 后传递依赖减少，记录数由 301 降为 289。）
- 修改依赖后应重新核查 lockfile，不手写锁文件、不复制原桌面项目的锁文件，不复制 Windows 的 node_modules 到 Linux。
- 当前安装器报告 source-map beta 与 glob 的弃用/安全提示。运行时依赖审计已处置：`npm audit --omit=dev` 现为 0 漏洞——此前命中的 3 个 high 已按上表版本升级（fastify 5.12.5、@fastify/static 10.1.5、ws 8.22.0），锁文件随之重新生成并核查来源与 integrity。开发工具链（vite / vitest / esbuild）仍有少量公告，均不进入运行时产物，尚未处置；没有运行 `npm audit fix --force` 或静默改动固定版本。

## 可重复安装与检查

只在 `lan/` 中执行，不能在原项目根目录安装：

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npm run typecheck
npm test
npm run build
```

本次三类检查（类型、测试、构建）均已成功。`ignore-scripts` 禁用的是安装生命周期脚本，显式运行测试和构建仍会执行依赖代码。若将来某个工具需要额外安装脚本，先审核该特定步骤，不能直接启用所有 hooks。

测试默认使用临时状态和模拟驱动，不启动 mpv，也不访问用户的真实账号或音乐目录。平台跳过项在验证记录中单列，不当成通过。

## 命令和产物

| 命令 | 作用 / 位置 |
| --- | --- |
| npm run dev:server | 读取可选 lan/.env，以 tsx / Node watch 运行 apps/server/src/index.ts |
| npm run dev:web | Vite 监听 localhost:5174，代理同源 /api HTTP 和 WebSocket |
| npm run typecheck | 检查 server、web / Vite 配置与 shared，不输出构建产物 |
| npm test | 使用根级 Vitest 配置执行三个 workspace 的 tests |
| npm run build | 构建 shared、server、web |
| npm start | 启动 apps/server/dist/index.js，不自动切换 NODE_ENV |
| npm run admin -- bootstrap --username room-admin | 运行已构建的本机交互式管理员初始化工具 |

构建产物：

- `packages/shared/dist/`：共享包 ESM 和类型声明。
- `apps/server/dist/index.js`、`apps/server/dist/admin.js`：后端和管理入口。
- `apps/web/dist/`：生产浏览器资源。

开发时共享包 exports 指向 TS 源码；服务端 tsup 用 `noExternal: ['@lan/shared']` 打入共享实现。Fastify、Zod 等仍是外部运行时依赖，因此服务器 bundle 不是独立单文件发行物。

保留 lan/ 的目录结构；服务端按自身文件位置确定工作区，MUSIC_ROOT / DATA_DIR 相对该工作区解析。不要把 dist 单独移走，或指向旧项目的配置和数据库。

## 尚未执行的运行与部署步骤

真实管理员创建、开发服务器、生产服务、HTTPS 代理、systemd 和音频试听尚未执行。上述工具示例不是已创建账号、已运行服务或已授权系统操作的证明。

[使用说明](../README.md) 包含具体配置与 Linux 验证清单。[systemd 示例](../deploy/lan-music.service) 仅为源文件，要求预先准备非 root 服务账号、固定目录、Node 24、mpv、文件权限及音频设备；不会自行安装依赖或生成账号。

Windows 只能显式启用开发模拟，生产配置禁止模拟。当前不包含 Playwright、浏览器二进制、Electron、在线音乐 SDK 或任意第三方插件加载器。
