# 番茄时钟 · DSH 插件

DeepSeek Harness 的番茄工作法插件。它给 Web GUI 加两处 UI：

- **浮层计时器**（`shell.overlay` 槽位）：右下角的状态药丸，点开是完整卡片——倒计时、进度条、开始/暂停、跳过、重置，并标出计时由谁维护。
- **偏好设置行**（`settings.general.item` 槽位）：**设置 → 通用** 里的「番茄时钟」分组，用来改时长、轮数、提示音与桌面通知。

```
专注 25 分钟 → 短休 5 分钟 → … 每 4 轮专注后 → 长休 15 分钟
```

## 计时归宿主所有

计时器跑在**宿主进程**里，不是页面里：

- 关掉页面、刷新、换窗口，倒计时照常走；多个窗口看到同一个时钟。
- 状态落盘在 `$DSH_HOME/storages/pomodoro/{state,settings}.json`（原子写：先写临时文件再 rename）。
- 页面每 2 秒拉一次宿主状态，期间本地插值显示，所以秒数平滑，也不受后台节流影响。
- 宿主不可达时（或插件尚未重启生效时）页面**自动降级**为本地引擎——同一套状态机，倒计时照常可用，只是关掉页面就停。卡片上的徽章会显示当前是 **宿主计时** 还是 **本页计时**。

> **需要重启一次 DSH 进程。** 宿主半侧的代码在进程启动时就被 Node 的模块缓存住了，替换包里的 `lib/index.js` 不会让运行中的进程重新导入它（插件管理器自己的文档也这么写：替换已有包后需要重启）。重启后 `/pomodoro` 路由才会挂上，页面随即切到宿主计时。

### HTTP 表面

宿主插件用 `ctx.webServer.register()` 挂了一个 `prefix: /pomodoro` 路由（同源，页面直接 `fetch`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/pomodoro/ping` | 可达性探测 |
| GET | `/pomodoro/state` | 当前状态快照 |
| POST | `/pomodoro/command` | `{command}`：start / pause / toggle / skip / reset / resetStats / refresh |
| POST | `/pomodoro/settings` | `{settings}`：局部设置 |

为什么是 HTTP 而不是 client→host RPC：手写插件包（不在 monorepo 里构建）**拿不到**宿主的 Remote 服务——那需要 Typert 代码生成产物（`typert.host.js` / `./remote`）。`ctx.webServer.register()` 是官方文档化的插件自有路由面，页面同源，因此既简单又完全受支持。路由只接受回环 `Host` 头，避免任意网页驱动这个时钟。

## 桌面通知

阶段结束时可以弹系统通知：

- 在 **设置 → 通用 → 番茄时钟 → 桌面通知** 打开——**只有这个显式开关会请求浏览器授权**，阶段变化本身不会触发授权弹窗。
- 授权被拒绝时开关不会写成「已开启」，并在下方说明原因。
- 提示音与通知相互独立；两者都开就是「响一声 + 弹一条」。
- 阶段切换由宿主发生，页面在下一次轮询时发现并弹出通知；本地降级模式下由本地引擎直接触发。

## 安装

这是一个 DSH **组合包**（bundle）：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，由它把插件行插进 profile 根。所以安装方式是「装包 + 选入组合包」，而不是往 `cordis.patch.yml` 里手抄一行。

```powershell
# 把 <profile> 换成你的 profile 名（例如 desktop）
dsh plugin --profile <profile> install github:dlfhome/dsh-plugin-pomodoro
```

也可以直接克隆到本地再按路径装（也是本仓库的开发方式）：

```powershell
git clone https://github.com/dlfhome/dsh-plugin-pomodoro
dsh plugin --profile <profile> install file:D:\code\dsh-plugin-pomodoro
```

用 `plugin_manager` 工具等效：`install_bundle`，`target` 传上面同样的 spec；`list_bundles` 可确认它已选入。

> **装完必须重启一次 DSH 进程。** 宿主半侧的 `lib/index.js` 在进程启动时就被 Node 的模块缓存住了，替换已安装的包不会让运行中的进程重新导入它（插件管理器自己的文档也这么写）。重启后 `/pomodoro` 路由才会挂上，页面随即切到宿主计时。

安装前的两点说明：

- 包里**不含** `dependencies`，只有一条 peer：`@deepseek-ai/cordis ^4.0.2`（DSH 自带，满足即可）。
- 包名是 `@deepseek-ai/dsh-plugin-pomodoro`，沿用 DSH 官方插件的命名空间以便与本机已装副本一致——它**不是** DeepSeek 官方发布的包，也不发布到 npm（`package.json` 里 `private: true` 就是为此）。

### 本机开发时的快速同步

`npm run sync` 走的是另一条路：不经过 pnpm，直接把 `package.json`、`cordis.patch.yml`、`lib/client.js`、`lib/index.js`、`src/engine.js` 拷进 `$DSH_HOME/profiles/<profile>/node_modules/@deepseek-ai/dsh-plugin-pomodoro/`。客户端 bundle 会被 HMR 热重载，宿主半侧仍需重启。

## 使用

| 操作 | 位置 |
|---|---|
| 开始 / 暂停 / 继续 | 浮层卡片中间的按钮 |
| 跳到下一阶段 | 卡片上的「跳过」（不计入番茄数） |
| 把当前阶段重置为完整时长 | 卡片上的「重置」 |
| 改时长 / 轮数 / 自动进入 / 提示音 / 桌面通知 | 设置 → 通用 → 番茄时钟 |
| 清零番茄与轮次计数 | 设置行右下角的「重置计数」 |

## 结构

计时状态机只有**一份源**：`src/engine.js`。宿主半侧直接 `import` 它，浏览器半侧由构建脚本把它内联进 bundle（手写的客户端 bundle 不能 `import` 自己的包）。因此两半执行同一套代码，而不是两份副本。

| 文件 | 作用 |
|---|---|
| `src/engine.js` | **唯一**的状态机源：阶段、轮次、deadline、持久化钩子 |
| `src/client.template.js` | 浏览器半侧模板：宿主桥、浮层组件、设置行、样式与文案 |
| `lib/index.js` | 宿主半侧：拥有计时、落盘、`/pomodoro` 路由 |
| `lib/client.js` | **生成产物**——不要手改，`npm run build` 会覆盖 |
| `cordis.patch.yml` | 组合包 patch：把插件行插入 profile 根 |
| `tools/build-client.cjs` | 由上面两个源生成 `lib/client.js` |
| `tools/test-runner.cjs` | 轻量测试运行器（带 `afterEach` 清理，失败也不会留下定时器） |
| `tools/engine.test.cjs` | 状态机测试：代码从**生成的 bundle** 里提取，测的就是实际运行的东西 |
| `tools/browser.test.cjs` | 浏览器半侧测试：真实 bundle + React/DOM/fetch/Notification 桩 |
| `tools/host.test.mjs` | 宿主半侧测试：Node 真实定时器 + 真实磁盘文档 |
| `tools/check-build.cjs` | 产物一致性检查：过期 bundle 直接让测试失败 |
| `tools/declared-tokens.txt` | 设计 token 契约：哪些可直接用、哪些必须带 fallback |
| `tools/sync-plugin.ps1` | 把本目录同步进 profile（客户端 HMR 会重载 bundle） |

### 为什么浏览器半侧是手写的产物形态

DSH 的客户端插件不是普通 npm 前端包：宿主半侧把 `dsh.client` 声明编译成启动图，浏览器侧由 `window.__ModuleLoader__` 惰性加载。因此 bundle 必须长成：

- 只调用 `window.__ModuleLoader__.load({ id, factory })`，模块副作用（含样式注入）都在 factory 闭包内；
- 没有 JSX、没有 `import`，只用 `require("react")`——平台基座里冻结的那张模块表；
- 样式通过自带 `<style data-plugin-css=…>` 标签注入，随插件卸载一起回收。

### 两条容易踩的坑

- **设计 token 必须真的存在。** 未声明且无 fallback 的 `var()` 会让整条 CSS 声明失效（不是降级）。`--dsw-alias-fill-l1/l2`、`--dsw-font-mono` 这类名字在官方插件里出现过，但前端**从未声明**，照抄会静默丢样式。插件用到的 token 记在 `tools/declared-tokens.txt`（分「DSH 静态声明，可直接用」和「必须写 fallback」两类），测试据此断言——所以这份契约随仓库走，干净克隆也能跑，新增 token 忘了登记就会失败并点名。
- **`shell.overlay` 是点击穿透层。** 官方样式里的 `.overlayLayer > * { pointer-events: auto }` 让直接子元素默认又能接收点击；浮层用 `position: fixed` 并按 `--dsh-composer-height` 让开输入框。

## 开发

```powershell
npm test            # 构建一致性 + 引擎 17 + 浏览器 19 + 宿主 7
npm run build       # 重新生成 lib/client.js
npm run sync        # 同步到 profile；客户端 bundle 由 HMR 热重载
```

宿主半侧改完必须重启 DSH 进程（模块缓存）。客户端 bundle 改完 `npm run sync` 即可。

## 已知边界

- **宿主计时需要重启一次**（见上），之后不再需要。
- 计时器绑在宿主进程上：DSH 完全退出后不会继续（没有做成系统级守护任务）。
- 宿主半侧刻意**没有** `Config`：设置的用户入口是设置行，也就是浏览器的 localStorage 与宿主文档；再加一层 Loader 行配置只会多出一个不生效的控件。
- 阶段结束的桌面通知由页面弹出，因此**没有页面打开时不会有桌面通知**——但宿主的计时和落盘不受影响。

## 卸载

```powershell
# 工具 plugin_manager → remove_bundle，target = @deepseek-ai/dsh-plugin-pomodoro
```
