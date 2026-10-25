# dsh-conversation-digest

DeepSeek Harness（DSH）的**对话总结插件** —— 把长对话压缩成可复用的摘要与改进建议。

> ⚠️ **当前状态：骨架阶段（v0.0.1）。** 打包约定、挂载声明、服务注入、生命周期、自检脚本都已打通并验证；**摘要与优化的业务逻辑尚未实现**。现在装上它只会多一条自检路由 `GET /dsh-conversation-digest/ping`。

## 它现在能验证什么

| 环节 | 怎么体现 |
|---|---|
| 打包约定 | `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml` |
| 挂载 | `cordis.patch.yml` 把本插件 insert 进 profile 的配置树 |
| 加载 | `apply(ctx)` 执行，控制台打印一行加载日志 |
| 服务依赖 | `ctx.inject(['webServer'], …)` 局部等待，不拖累整个插件启动 |
| 路由 | `GET /dsh-conversation-digest/ping` 返回 JSON |
| 卸载 | `ctx.effect` 的 disposer 把注册过的路由全部注销 |

## 目录结构

```text
dsh-conversation-digest/
├── package.json          # 插件元数据；dsh.bundle.patch 指向挂载声明；顶层 icon 指向图标
├── cordis.patch.yml      # 挂载声明（insert 一个条目）
├── icon.png              # 插件列表图标（256×256 PNG）
├── LICENSE               # MIT
├── lib/
│   └── index.js          # 宿主半区：插件入口 apply(ctx)
└── scripts/
    └── smoke.mjs         # 不装进 DSH 也能跑的自检
```

## 安装

### Web（`dsh web`）

```powershell
# 从本地目录链接安装（改了源码立即生效，适合开发）
dsh plugin --profile web add link:D:\path\to\dsh-conversation-digest

# 从 GitHub 安装
dsh plugin --profile web add github:LIN-F1SH/dsh-conversation-digest
```

装完重启 `dsh web`，浏览器 `Ctrl+F5`。

### 官方桌面客户端（Electron）

桌面端读的是 **`desktop` profile**，而 `dsh plugin` 命令行**按设计拒绝**碰它：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以在桌面端会话里让宿主自己装（用内置的 `plugin_manager`），不要用上面的 `--profile web` 命令：

> 请使用内置的 `plugin_manager` 安装本插件。先核对当前 profile 与是否已有同名插件，安装完成后告诉我结果以及是否需要重启。

## 验证

```powershell
# 把端口换成你的 DSH Web 端口
curl http://127.0.0.1:3080/dsh-conversation-digest/ping
```

正常返回：

```json
{
  "ok": true,
  "plugin": "dsh-conversation-digest",
  "version": "0.0.1",
  "uptimeMs": 1234,
  "node": "v24.x.x",
  "now": "2026-10-25T04:08:00.122Z"
}
```

> 如果宿主启用了浏览器信任栅栏，**裸 `curl` 可能返回 401/403** —— 那是栅栏在工作，不是接口坏了。用浏览器访问同一条路径才是 200。

## 自检（不用装进 DSH）

```powershell
node scripts/smoke.mjs
```

它用一个最小 `ctx` 桩调用 `apply()`，再直接跑一遍 handler，断言四件事：路由注册正确、响应是 200 + 合法 JSON、卸载后路由注销干净、宿主没有 `webServer` 时 `apply()` 不抛异常。

## 路线图

- [x] 骨架：打包、挂载、注入、卸载、自检
- [ ] **读**：从会话事件拿到完整对话（`ctx.on('session/event', …)`）
- [ ] **算**：聚合出可总结的上下文（分块、去噪、保留关键决策）
- [ ] **写**：调用模型产出摘要与改进建议
- [ ] **展示**：把结果呈现出来（命令 / 面板 / 文件导出，待定）

## 开发笔记

### 三条约定（踩过的人都在这里翻车）

1. **需要宿主服务时用 `ctx.inject([...], cb)`，不要写对象级 `inject`。** 对象级 inject 会把整个 `apply()` 推迟到服务就绪之后；而桌面端宿主是在启动时**一次性收集**注入表的，晚到的订阅就永远进不去 —— 表现是「装了、没报错、什么都没出现」。
2. **自己注册的一切都要能注销。** 注册路由返回的 disposer 记得收好，在 `ctx.effect` 里统一释放，否则热重载会残留、重复注册同名路由还会直接抛错。
3. **不要把凭据写进配置文件或仓库。** 需要密钥时走宿主提供的凭据服务，配置文件里只存凭据名。

## 许可

[MIT](./LICENSE) © 2026 LIN-F1SH
