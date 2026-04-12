# BC Listen Together - 开发者指南

本文档适用于 **项目开发者**。有关安装和使用说明，请参阅 [README.md](README.md)。

## 开发环境设置

### 前置条件
- Node.js 14+
- npm 6+
- Git

### 初始化项目

```bash
npm install
```

## 实时开发工作流 (Bondage Club 网站)

### 启动开发服务器

```bash
npm run dev
```

开发服务器将在 `http://127.0.0.1:5180` 运行。

### 加载本地开发脚本

1. 在 Violentmonkey 或 Tampermonkey 中创建新的用户脚本
2. 设置脚本 URL 为：

```
http://127.0.0.1:5180/BCWatchTogether.user.js
```

3. 访问 `https://www.bondageprojects.com`
4. 直接在网站上进行开发和测试

**重要提示**：
- 在开发过程中保持 `npm run dev` 运行
- 脚本更改会自动从本地 Vite 开发服务器提供
- 刷新页面以查看最新更改

## 生产构建

### 本地构建

```bash
npm run build
```

生产输出将在以下位置生成：
- `dist/BCWatchTogether.user.js` - 完整构建

## 本地打包流程

### 准备发布包

```bash
npm run pack:local
```

此命令完整执行以下操作：
- 清理旧的构建工件 (`dist/`)
- 校验版本指定的一致性
- 构建生产用户脚本
- 将脚本发布到仓库根目录 (`BCWatchTogether.user.js`)
- 将发布工件打包到 `release/vX.Y.Z`
- 生成 `SHA256SUMS.txt` 和 `release-manifest.json`

如果需要强制清理整个 `release/` 目录，可手动执行：

```bash
$env:CLEAN_RELEASE="1"; npm run clean
```

### 版本管理规则

在打包前，确保以下文件中的版本号一致：

| 文件 | 字段 |
|------|------|
| `package.json` | `version` |
| `loader.user.js` | `@version` |
| `CHANGELOG_UI.md` | 必须包含 `## [X.Y.Z] - ...` 标题 |

推荐使用自动化命令一次性完成版本同步：

```bash
npm run release:prepare -- 0.3.0
```

该命令会自动：
- 更新 `package.json` 的 `version`
- 更新 `loader.user.js` 的 `@version`
- 若 `CHANGELOG_UI.md` 缺少对应版本标题则自动插入模板

也可以直接执行一键本地发布（可选传入版本号）：

```bash
npm run release:local -- 0.3.0
```

该命令会先执行 `release:prepare`（仅当提供版本号时），再执行完整 `pack:local` 流程。

### 发布工作流（手动）

打包完成后，由您手动完成以下步骤：

```bash
# 提交所有更改
git add .
git commit -m "release: v0.3.0"

# 创建版本标签
git tag v0.3.0

# 推送到 GitHub（使用您配置的身份）
git push origin main
git push origin v0.3.0

# 手动上传 release/ 目录中的文件到 GitHub Release
```

**注意**：所有遠端同步由您手动完成，避免身份污染问题。

## 项目结构

```
BC-Watch-Together/
├── src/
│   ├── userscript-entry.js      # 用户脚本入口点
│   ├── ui.js                     # UI 组件和窗口管理
│   ├── sync.js                   # Supabase Realtime 事件同步
│   ├── state.js                  # 全局状态管理
│   └── bilibili.js               # Bilibili URL 处理
├── package.json                  # 项目配置和脚本
├── vite.config.js               # Vite 构建配置
├── loader.user.js               # 用户脚本加载程序
├── CHANGELOG_UI.md              # 变更日志
└── dist/                         # 构建输出目录
```

## 源文件说明

### `src/userscript-entry.js`
- 用户脚本的主入口点
- 初始化应用程序和 UI
- 处理脚本的生命周期

### `src/ui.js`
- `DraggableWindow` 类用于可拖动的窗口管理
- UI 模式管理（房间列表模式、播放器模式）
- 界面渲染和事件处理

### `src/sync.js`
- Supabase Realtime 连接管理
- 事件订阅和分发
- 远程视频共享事件处理

### `src/state.js`
- 全局应用状态管理
- 设置持久化 (localStorage)
- 状态更新回调

### `src/bilibili.js`
- Bilibili URL 解析和验证
- 播放器 URL 构建
- BV ID 提取

## 调试

### 启用控制台调试
开发时查看浏览器开发者工具的控制台。应用程序输出调试消息帮助追踪执行流程。

### 常见问题

**Q: 开发脚本不加载**
- 确认 `npm run dev` 仍在运行
- 检查脚本管理器是否正确指向 `http://127.0.0.1:5180/BCWatchTogether.user.js`
- 检查浏览器控制台是否有错误

**Q: 构建失败**
- 清除 `node_modules` 和 `dist` 目录
- 运行 `npm install` 重新安装依赖
- 检查是否安装了所有必需的工具

## 贡献指南

1. 创建功能分支：`git checkout -b feature/your-feature`
2. 提交更改：`git commit -am 'Add new feature'`
3. 推送分支：`git push origin feature/your-feature`
4. 开启 Pull Request

## 许可证

请查看 [LICENSE](LICENSE) 文件。
