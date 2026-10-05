# 验证记录

记录更新：2026-10-05。此文件记录实际执行结果，不代表完整项目验收或未来操作授权。

## 已执行

环境：Windows 11，Node.js 24.16.0，npm 11.13.0。所有安装和检查仅针对 `lan/`，没有启动原桌面项目。

| 检查 | 结果 |
| --- | --- |
| 直接依赖元数据 | 固定版本可在 npm 官方仓库查到，下载地址及完整性字段存在；不是漏洞安全证明 |
| 锁文件 | 由 npm 实际生成；当前 301 个外部包记录的 resolved 均为 HTTPS 的 registry.npmjs.org，均有 integrity；包含其他平台的可选依赖 |
| 安装 | `npm ci --ignore-scripts --no-audit --no-fund` 成功，未启用安装生命周期脚本 |
| 类型检查 | `npm run typecheck` 成功：server、web/Vite 配置、shared 均通过 |
| 生产构建 | `npm run build` 成功：shared dts、server dist（index.js / admin.js）、web dist |
| 自动测试 | `npm test` 成功：15 个测试文件通过，138 项通过，2 项按平台跳过，共 140 项 |

以上测试使用内存 / 临时 SQLite、临时文件、HTTP 注入、模拟播放器及 WebSocket 替身，不产生真实声音，也不创建实际部署账号。

## Linux 实测（运营者执行）

环境：Fedora 41、内核 6.14、Node 24.21、mpv 0.39、非 root 服务账号（在 `audio` 组）。本轮由运营者在真实 Linux 主机上执行，仓库未随附可重复脚本；结论基于修复前的提交。

已验证：

- **真实出声**：通过硬件信宿的 monitor 录制 + `volumedetect` 定量比对——音量 100 时到达 sink 的电平与源文件一致（-35.1 dB），暂停 / 静音降到数字底噪（-91 dB），音量 25 的衰减与 mpv 三次方曲线一致；`ps` 中 mpv 的 `--audio-device` / `--input-ipc-server` 参数符合预期。
- **控制**：播放 / 暂停 / 继续 / 定位 / 音量 / 静音 / 下一首 / 上一首均与直连 IPC 读到的 mpv 属性一致；队列自然播完自动进下一首。
- **代理与 HTTPS**：Caddy 正确转发时 WebSocket 升级返回 101；未转发升级头的 nginx 配置下页面与登录正常、但实时通道不可用（与文档预期一致）。
- **bootstrap**：真实 PTY 下首个管理员创建成功；账号表非空时二次 bootstrap 被拒。
- **多用户**：同账号两个会话互不踢下线，跨会话点歌经 WebSocket 立即同步。

未在本轮验证：USB 声卡（该机无 USB 声卡，仅板载模拟输出）、会话 12 小时绝对过期、长时间连续运行与并发压力。

本轮发现的问题见下节（均已修复，但尚未在 Linux 上复验修复后的版本）。

## 本次发现并修复

1. **客户端请求饱和会误停播放器和实时同步。** 外部请求和内部生命周期任务现使用独立、有界的准入配额，同时保持同一 FIFO 执行顺序。只合并相邻的进度采样；心跳和进度广播最多各有一个待执行任务。真实内部错误仍停止服务，而不是被当成普通限流忽略。
2. **Windows 路径别名被错误识别成符号链接。** 检查真实祖先组件中的 symlink / junction，而不是直接比较 realpath 和字符串路径；保留加载时的目录约束和文件身份校验。
3. **Vite 存在两个版本，导致插件类型不兼容。** 用根级 overrides 统一到已经选定的 7.3.1，没有通过类型断言或关闭严格检查掩盖错误。
4. **Fastify 路由配置弃用警告。** `maxParamLength` 改为通过 `routerOptions` 传递。
5. **`npm start` / systemd / `npm run admin` 全部起不来（发布阻断项）。** tsup 的 `removeNodeProtocol` 默认把 `node:sqlite` 改写成 `sqlite`，构建产物运行时报 `ERR_MODULE_NOT_FOUND`；开发模式走 tsx 掩盖了它。已在 `apps/server/tsup.config.ts` 设 `removeNodeProtocol: false`，并实测 `dist/index.js` 能启动、`dist/admin.js` 能进入自身校验。
6. **mpv 崩溃后不可恢复且零日志。** 驱动永久 `broken`、丢弃子进程输出，只有重启能救。现记录失败原因（含脱敏后的 mpv 输出尾部），并允许下一次 `play` 重建驱动一次，成功则广播 `player.recovered`，失败保持显式错误态。
7. **设备回退不可见。** 设备名写错或设备消失时 PipeWire 会静默改道，界面仍显示 playing。现观察 `audio-out-detected-device`，与显式配置的设备不符时在快照的 `player.warning` 中持续告警（`auto` 不算不符）。
8. **崩溃后需人工清锁、孤儿 mpv 继续出声。** 现仅在锁记录的属主**确已消失**时接管锁，并按 uid 与私有 socket 目录回收残留 mpv；属主存活 / 记录不可读 / PID 被重用一律 fail closed。systemd 示例改为 `Restart=on-failure`。
9. **启动失败只有一句通用提示。** 新增 `StartupError` 标记可安全打印的消息（无文件名 / SQL / 连接细节），入口原样输出；锁、配置、数据目录等失败现在可区分。
10. **新增必填字段会让旧数据库无法启动。** `player.warning` 使旧 checkpoint 行严格校验失败；读取时先补默认值再校验，并有回归测试。

新增回归覆盖：mpv 失败原因与脱敏、驱动重建与 `player.recovered`、设备回退告警、过期锁接管与存活锁拒绝、孤儿 mpv 匹配、旧 checkpoint 读取。

相关测试：

- [mpv.test.ts](../apps/server/tests/mpv.test.ts)
- [coordinator.test.ts](../apps/server/tests/coordinator.test.ts)
- [store.test.ts](../apps/server/tests/store.test.ts)
- [orphans.test.ts](../apps/server/tests/orphans.test.ts)

## 跳过项

本次 Windows 环境跳过两项原有用例，不能算作通过：

- 普通符号链接文件 / 子目录及扫描后替换的用例（该用例在 Windows 下跳过）。新增的祖先 junction 用例已在本次环境通过。
- Linux `/proc/<pid>/fd/<fd>` 固定文件描述符、路径替换后仍读取原文件的用例（仅 Linux 执行）。

## 尚未验证

- npm 漏洞审计的处置：`npm audit --omit=dev` 报告 3 个 high 级运行时依赖（fastify、@fastify/static、ws），修复版本均超出当前锁定范围、需要破坏性升级；尚未完成影响评估，不能声称依赖无已知风险。没有运行 `npm audit fix` 或静默升级依赖。
- 真实浏览器布局、网络 WebSocket 握手、反向代理与 HTTPS 的可重复验收脚本（运营者已实测，但未随仓库提供）。
- 本机交互式管理员初始化、真实服务启动、systemd 安装与启动的可重复验收脚本。
- Linux mpv 选项和设备适配、USB / 3.5mm 出声、设备拔插及连续播放稳定性。
- 修复后的版本尚未在 Linux 上复验（本轮 Linux 结论基于修复前的提交）。
- 上一轮中断的完整正确性审查，不能用当前测试通过替代完整审查结论。

## 功能边界

这是本地文件遥控的第一版，不是全项目完成：NAS 专用管理、网易云、私人收藏和歌单、歌词等仍未实现。

当前重启仅保留待播队列和音量 / 静音设置，播放器恢复为空闲，**不保留中断的当前曲目与播放位置**。原计划的暂停恢复尚未实现，不能把当前行为标记成已完成该项。

下一步：在 Linux 上复验本轮改动（mpv 自愈、设备告警、锁接管与孤儿回收——现有 Linux 结论基于修复前的提交），再补 USB 声卡、长时间运行与依赖审计处置。不要因为单元测试通过就直接对外部署。
