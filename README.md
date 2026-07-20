# SekaiText 插件市场

SekaiText 插件市场的官方源。客户端默认从本仓库的 `index.json` 拉取可安装插件列表。

## 结构

- `index.json` — 插件索引。`version` 为索引格式版本，`plugins[]` 为条目列表。
- `index.schema.json` — 索引 JSON Schema；v2 为兼容签名格式，正式发布升级为 v3。
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
| `sha256` | ✓ | 包文件 SHA-256，64 位小写十六进制 |
| `publisher` | v2 ✓ | 固定为 `sekaitext-official` |
| `keyId` | v2 ✓ | 签名公钥标识，用于轮换 |
| `signatureAlgorithm` | v2 ✓ | 固定为 `ed25519` |
| `packageSignature` | v2 ✓ | canonical payload 的 Ed25519 签名，标准 Base64 |
| `homepage` | | 插件主页/源码仓库 |
| `sequence` | v3 ✓ | 全索引单调递增序号，防止重放旧索引 |
| `expiresAt` | v3 ✓ | canonical RFC3339 UTC 过期时间 |
| `metadataSignature` | v3 ✓ | 覆盖所有用户可见字段及 sequence/expiry 的 Ed25519 签名 |

v3 索引顶层还必须包含 `publisher`、`keyId`、`signatureAlgorithm`、`sequence`、`expiresAt` 与 `snapshotSignature`。每个条目的前五项签名元数据必须与顶层完全相同。

## 官方包签名

v2 条目签名以下 UTF-8 payload。字段顺序、大小写、每行结尾的 `\n` 以及最后一个 `\n` 都属于协议；`N` 是字段值的 UTF-8 字节数，不是字符数：

```text
SekaiText-Plugin-Signature-V1\n
publisher:N:<publisher>\n
keyId:N:<keyId>\n
algorithm:N:<signatureAlgorithm>\n
id:N:<id>\n
version:N:<version>\n
download:N:<download>\n
sha256:64:<sha256>\n
```

`packageSignature` 保持 v1 payload，以兼容现有客户端。v3 同时增加 `metadataSignature`，其 v2 payload 还绑定 name/description/author/icon/minHostVersion/homepage、sequence 与 expiresAt。

v3 的 `snapshotSignature` 使用同一 Ed25519 key 签署以下 UTF-8 payload，其中插件按 `plugins[]` 的原始顺序出现。每个 `metadataSignature` 已绑定该条目的完整用户可见元数据、包 URL/digest、sequence 与 expiry；顶层签名因此同时认证完整成员集合、顺序和全局防重放元数据：

```text
SekaiText-Plugin-Market-Snapshot-V1\n
publisher:N:<publisher>\n
keyId:N:<keyId>\n
algorithm:N:<signatureAlgorithm>\n
version:1:3\n
sequence:N:<sequence>\n
expiresAt:N:<expiresAt>\n
pluginCount:N:<plugins.length>\n
pluginId:N:<plugins[0].id>\n
metadataSignature:N:<plugins[0].metadataSignature>\n
...每个后续条目重复 pluginId / metadataSignature...
```

新客户端必须先验证所有条目签名，再验证顶层签名，之后才持久化顶层最高 sequence；相同 sequence 仅接受完全相同的已签名 snapshot。观察到 v3 后拒绝降级到 v2，并拒绝过期索引。5.9.0 过渡客户端仅在 `2026-10-01T00:00:00Z` 前接受当前生产 v2；届时即使从未见过 v3 也会 fail closed，避免攻击者无限冻结 v2。必须在该日期前发布首个 v3。

客户端构建使用 `SEKAITEXT_PLUGIN_PUBLIC_KEYS` 注入公开信任集合，格式为 `{"keyId":"标准 Base64 的 32 字节原始 Ed25519 公钥"}`。该值只在构建 Go sidecar 时写入二进制；运行时环境变量不会改变信任根。

轮换顺序：先发布同时内置旧、新公钥的客户端，再把发布 workflow 的 `PLUGIN_SIGNING_KEY_ID` 和私钥切到新 key，最后在旧客户端淘汰后移除旧公钥。不要复用或修改既有 `keyId` 对应的公钥。

## 发布新插件 / 更新

1. 在插件仓库 `npm run dist` 生成 `dist-plugins/<id>-<version>.sekplugin`。
2. 把产物放进本仓库 `plugins/`。
3. 官方插件 release workflow 从插件 tag 中运行受信任 publisher；市场 checkout 只作为数据读取，不执行其中的代码。publisher 在修改前使用 `SEKAITEXT_PLUGIN_PUBLIC_KEYS` 验证每个现有条目的 package 签名（v3 还验证 metadata 与完整 snapshot 签名），再校验完整 schema、所有包 digest 及包内 manifest ID/version，最后重签全部条目和 snapshot 并升级为 v3。任何现有签名失败都会中止，市场仓库写权限本身不能把替换 payload 洗成官方包。
4. 发布器拒绝用较低版本覆盖较高版本，也拒绝同版本替换不同字节。各插件仓库用 `plugin-market-write` concurrency 串行化本仓库发布；跨仓库写入依靠目标 `main` 的 non-fast-forward 拒绝，并从最新 main 重新克隆、重新验证、重新签名后有限重试。
5. workflow 必须配置 `MANIFEST_REPO_TOKEN`、`PLUGIN_SIGNING_PRIVATE_KEY`（标准 Base64 的 Ed25519 PKCS#8 DER）、`PLUGIN_SIGNING_KEY_ID` 与非空 `SEKAITEXT_PLUGIN_PUBLIC_KEYS`。私钥导出的公钥必须和同 keyId 的应用信任根一致。
6. 私钥只进入受信任 publisher 的进程环境；publisher 启动 git/unzip 时会移除该变量。私钥绝不写入市场 checkout、构建产物或日志。

## v3 续期

`sekaitext-plugin-autotiming` 的 `renew-market.yml` 每月从受信任源运行 `publish-market.mjs --renew-only`，在独立临时目录把市场仓库仅作为数据克隆。续期先验证所有既有签名（允许已签名 expiry 已到期以便恢复续签），然后提高全局 sequence、生成未来 180 天 expiry 并重签；push 冲突会丢弃本次结果，从最新 main 完整重做。

发布与续期 job 都绑定 GitHub Environment `plugin-market-signer`。上线前必须在该 Environment 中放置/限制 `MANIFEST_REPO_TOKEN` 与 `PLUGIN_SIGNING_PRIVATE_KEY`，配置 `PLUGIN_SIGNING_KEY_ID`、`SEKAITEXT_PLUGIN_PUBLIC_KEYS`，并用 environment protection/受保护默认分支隔离签名权限。定时续期 workflow 位于插件源码仓库而非市场数据仓库，市场仓库被攻破不能修改下一次执行的 signer 代码。

## OSS/CDN 同步

市场仓库的 `sync-market-cdn.yml` 在 `main` 的已签名索引或包变化后运行。它验证 v3 完整 snapshot，拒绝覆盖已有但 digest 不同的不可变包，先上传/验证 `sekaitext-plugins/plugins/*`，最后上传并回读 `sekaitext-plugins/index.json`。该路径对应应用默认地址 `https://sakimizuki.accr.cc/sekaitext-plugins/index.json`；同步器还会拒绝用较低 sequence 覆盖 CDN，并拒绝相同 sequence 的不同 snapshot。

在 GitHub Environment `plugin-market-cdn` 中配置 secrets `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`，以及 variables `OSS_REGION`、`OSS_BUCKET`、`CDN_ORIGIN`、`SEKAITEXT_PLUGIN_PUBLIC_KEYS`。OSS 身份只需目标 bucket 的对象读取/写入权限；`CDN_ORIGIN` 不带尾部 `/`，bucket 中必须把 `sekaitext-plugins/` 映射到该 CDN origin 的同名路径。

## 已收录

- **live2d** — Live2D 剧情播放器（[源码](https://github.com/SnowGlow-aww/sekaitext-plugin-live2d)）
