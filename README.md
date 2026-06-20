# SekaiText 插件市场

SekaiText 插件市场的官方源。客户端默认从本仓库的 `index.json` 拉取可安装插件列表。

## 结构

- `index.json` — 插件索引。`version` 为索引格式版本，`plugins[]` 为条目列表。
- `plugins/` — 托管的 `.sekplugin` 安装包。

## 索引条目字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 插件唯一 ID，与 manifest 一致 |
| `name` | ✓ | 显示名 |
| `version` | ✓ | 版本号，用于更新检测 |
| `download` | ✓ | `.sekplugin` 的直链 URL |
| `description` | | 简介 |
| `author` | | 作者 |
| `icon` | | lucide 图标名 |
| `minHostVersion` | | 最低宿主版本要求 |
| `sha256` | | 下载完整性校验（推荐） |
| `homepage` | | 插件主页/源码仓库 |

## 发布新插件 / 更新

1. 在插件仓库 `npm run dist` 生成 `dist-plugins/<id>-<version>.sekplugin`。
2. 把产物放进本仓库 `plugins/`。
3. 在 `index.json` 新增或更新对应条目（`version`、`download`、`sha256`）。
4. `sha256` 用 `shasum -a 256 <file>` 计算。
5. 提交并推送到 `main`，客户端即可在「设置 → 插件市场」看到。

## 已收录

- **live2d** — Live2D 剧情播放器（[源码](https://github.com/SnowGlow-aww/sekaitext-plugin-live2d)）
