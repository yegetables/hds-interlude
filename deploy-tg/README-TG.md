# HDS Interlude — Telegram 版部署指南

这是 [HDS Interlude](https://gitee.com/MomoiCore/hds-interlude) 的 Telegram 适配 fork
(`0.1.4-tg.2`,基于上游 v0.1.4),跳过语音转写,其余 QQ 特有能力已适配或天然可用。

## 这个 fork 改了什么

| 改动 | 位置 | 效果 |
|---|---|---|
| 识图 allowlist 加 `api.telegram.org`,并支持自定义域名 | `src/service.ts` `isTrustedImageHost()` | TG 图片可进视觉管道;反代域名用环境变量 `HDSI_TRUSTED_IMAGE_HOSTS` 或控制台字段配置(tg.2) |
| tsconfig 自包含化 | `tsconfig.json` | 镜像仓库缺 `tsconfig.base.json`,补齐后可独立构建 |
| 完整 lib 构建产物 + 版本 `0.1.4-tg.2` | `lib/`、`package.json` | 可从 git / Release tgz 直接安装 |
| `deploy-tg/` 部署套件 | 本目录 | compose 基础版 + 1Panel 变体 + 安装脚本 |

**无需改动即在 TG 生效的能力**(源码本就平台无关):主叙事、自动推进、主动联系、
意愿阈值、Agency Window、记忆分层、贴纸库(私聊)、消息分段与打字延迟、
语音消息的"已收到语音"降级标记。

**TG 上的限制**:群聊不进剧情(群访问层写死 OneBot);贴反应/NativeFace 是 QQ 专有;
语音转写未接(SnowLuma 是 NapCat 专有);识图 URL 带 bot token,**推荐 sidecar 视觉模式**
避免 token 随图片 URL 发给模型服务商。

## 启动容器后的完整操作序列

前置:服务器能访问 `api.telegram.org`(境外 VPS 最省事);已装 docker 与 docker compose;
TG 上找 @BotFather 建好 bot 并拿到 token(形如 `123456:ABC-xxx`)。

以下命令按你选的变体二选一:基础版用 `docker compose`,1Panel 版加
`-f docker-compose.1panel.yaml`。

### 第 0 步:把文件弄到服务器

部署需要三样:`docker-compose.yml`(或 1panel 变体)、`koishi-pkg/install.sh`、
`koishi-pkg/*.tgz`(插件包)。**注意 tgz 不在 git 仓库里**(构建产物被 gitignore),
git clone 后必须从 Release 补:

```bash
# 方式 A:git clone 后从 Release 补 tgz + 刷新安装脚本
git clone https://github.com/yegetables/hds-interlude.git && cd hds-interlude/deploy-tg
wget https://github.com/yegetables/hds-interlude/releases/download/v0.1.4-tg.2/koishi-plugin-hds-interlude-0.1.4-tg.2.tgz -O koishi-pkg/

# 方式 B:整目录 scp(本地构建机上有完整 tgz)
scp -r deploy-tg user@server:/opt/hdsi
```

### 第 1 步:启动并等初始化完成

```bash
cd /opt/hdsi
docker compose -f docker-compose.1panel.yaml up -d
docker compose -f docker-compose.1panel.yaml logs -f koishi
# 看到 Koishi 控制台启动完成、无报错后 Ctrl+C 退出跟踪
```

### 第 2 步:安装插件(容器内一键脚本)

```bash
docker compose -f docker-compose.1panel.yaml exec koishi sh /opt/install.sh
# 脚本会:等实例初始化 → yarn add hds-interlude tgz → 装 @koishijs/plugin-adapter-telegram
#          与 @koishijs/plugin-database-sqlite
```

### 第 3 步:重启加载

```bash
docker compose -f docker-compose.1panel.yaml restart koishi
```

### 第 4 步:打开控制台

- 1Panel 版:浏览器开 `http://服务器IP:15314`(或 1Panel → 网站 → 反代 `http://koishi:5140`)
- 基础版:本机 `ssh -L 5140:127.0.0.1:5140 user@server` 后开 `http://127.0.0.1:5140`

> 控制台**默认无密码**。裸暴露前先配反代访问限制/防火墙,或装 `@koishijs/plugin-auth`。

### 第 5 步:控制台里添加并启用三个插件

脚本只是把包装进了实例,还需要在控制台逐个添加启用:
左侧栏「插件配置」→ 点「+」添加插件 → 选择下面的插件 → 填配置 → 启用。

1. **adapter-telegram**:`token` 填 BotFather 给的令牌;协议保持默认 polling。
2. **database-sqlite**:如果插件列表里已有且启用中,跳过(HDSI 剧本/记忆存 SQLite)。
3. **hds-interlude**:按下节配置,先启用跑通,细节随时改。

### 第 6 步:hds-interlude 关键配置

| 配置区 | 必做 | 说明 |
|---|---|---|
| **模型中心** | ✅ | 添加一行模型连接:`mode=openai-compatible` 填 Endpoint/Key/模型名,勾"**用作主叙事模型**";或选 `deepseek-official`/`zhipu-official` 官方模式。要 JSON 输出稳、便宜的模型(GLM-5.3-Flash / deepseek-chat 级别) |
| **基础设定** | ✅ | 主角/世界观/配角/叙事风格——你的**人设粘贴到这里**(Canon)。酒馆角色卡按映射搬:`description`→主角,`scenario`→世界,`first_mes` **不要直接用**(剧情让自动推进自己长) |
| **运行时** | ✅ | 勾选 **`autoCreate`(首次私聊自动创建故事)**——默认是关的,不开的话故事永远不会开始。或备选:私聊里发 `interlude.story.start`(`managerAccounts` 留空 = 人人可管理;设了就填你自己的 TG 数字 ID) |
| **剧情节奏** | 建议 | 自动推进间隔先调长(30-60 分钟),跑稳再加密;**主动联系需要显式开启**(受意愿阈值约束) |
| **贴纸库**(可选) | — | 启用后表情包放宿主机 `./koishi-data/data/hds-interlude/stickers/`(基础版是 `./koishi/...`) |
| **视觉**(可选) | — | 主模型支持图片输入用 `native`;否则配一个视觉连接用 `sidecar`(推荐,token 不出服务器) |
| **平台控制** | 忽略 | OneBot 区块不启用(TG 不走它) |

### 第 7 步:TG 里验证

1. 给 bot 发 `/start`(TG 规矩:用户没 /start 过,bot **无法主动发消息**;此后主动联系随时生效)
2. 私聊随便说句话 → 应收到拟人回复(有分段气泡和打字延迟)
3. Console 日志确认:用户事件被接收、主模型调用成功、自动推进周期开始运行
4. 管理指令可在私聊里发 `interlude.status` / `interlude.context` 查看

## 自定义 TG API 域名(反代)

三层各管一段,别混淆:

| 层 | 谁决定 | 怎么配 |
|---|---|---|
| **图片下载 URL 的域名**(HDSI 收到的 `img src`) | 适配器的 `files.baseUrl`(默认 `https://api.telegram.org`) | 控制台 → adapter-telegram → 文件设置 → "文件请求的终结点" 填 `https://tgapi.yegetables.com` |
| **识图 allowlist**(HDSI 肯不肯去拉这个图源) | HDSI(本 fork) | 环境变量 `HDSI_TRUSTED_IMAGE_HOSTS=tgapi.yegetables.com`(compose 里加),或控制台 → hds-interlude → 图片理解 → 额外信任域名 |
| **Bot API 调用端点**(sendMessage/getFile 等) | 适配器源码**硬编码** `https://api.telegram.org` | 换域名无效。服务器连不上 TG 时,正确姿势是给 Koishi 配 HTTP 代理(@koishijs/plugin-proxy-agent + 全局 http.proxy),或用境外服务器 |

即:自建反代 `tgapi.yegetables.com` 后,把上面第 1、2 层都指向它,识图链路就走反代;
但 **API 调用层永远直连 api.telegram.org**,务必确保服务器本身可达(代理或境外机)。

## 1Panel 变体(docker-compose.1panel.yaml)

与基础版共同一套文件(同一个 `koishi-pkg/` 提供插件包与安装脚本),差异:

| 项 | 基础版 | 1Panel 版 |
|---|---|---|
| 网络 | compose 默认 | 外部 `1panel-network`(OpenResty 反代目标填 `http://koishi:5140`) |
| 控制台端口 | `127.0.0.1:5140`(SSH 隧道) | `15314:5140`(高位随机端口,冲突自行换) |
| 数据目录 | `./koishi` | `./koishi-data` |
| 插件包目录 | `./koishi-pkg` | 同左 |

从基础版迁移数据:`docker compose down` 后 `mv koishi koishi-data`。

## 运维

- **备份**:`./koishi`(基础版)或 `./koishi-data`(1Panel 版)——配置、node_modules、HDSI 数据库全在内。
- **升级插件**:本地重新 `npm run build && npm pack` → 覆盖 `koishi-pkg/*.tgz` → 重跑 install → restart。
- **常见问题**:剧情崩坏/格式失败 → 换更强的主叙事模型,比调配置有效;token 消耗 →
  自动推进是常驻开销,间隔与休息时段控制成本;私聊无响应 → 检查 autoCreate/故事是否已启动、
  主模型行是否勾了"用作主叙事模型"。
- **许可**:上游 AGPL-3.0,本 fork 同协议;自用无义务,对外提供服务需开源修改。
