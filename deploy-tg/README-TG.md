# HDS Interlude — Telegram 版部署指南

这是 [HDS Interlude](https://gitee.com/MomoiCore/hds-interlude) v0.1.4 的 Telegram 适配 fork
(`0.1.4-tg.1`),跳过语音转写,其余 QQ 特有能力已适配或天然可用。

## 这个 fork 改了什么

| 改动 | 位置 | 效果 |
|---|---|---|
| 识图 allowlist 加 `api.telegram.org` | `src/service.ts` `isTrustedImageHost()` | TG 图片可进入视觉管道(原生/sidecar 都生效) |
| tsconfig 自包含化 | `tsconfig.json` | 镜像仓库缺 `tsconfig.base.json`,补齐后可独立构建 |
| 版本号 `0.1.4-tg.1` + build 脚本 | `package.json` | 标识 fork 构建 |

**无需改动即在 TG 生效的能力**(源码本就平台无关):主叙事、自动推进、主动联系、
意愿阈值、Agency Window、记忆分层、贴纸库(私聊)、消息分段与打字延迟、
语音消息的"已收到语音"降级标记。

**TG 上的限制**:群聊不进剧情(群访问层写死 OneBot);贴反应/NativeFace 是 QQ 专有;
语音转写未接(SnowLuma 是 NapCat 专有);识图 URL 带 bot token,**推荐 sidecar 视觉模式**
避免 token 随图片 URL 发给模型服务商。

## 部署步骤

前置:服务器能访问 `api.telegram.org`(境外 VPS 最省事);已装 docker 与 docker compose;
TG 上找 @BotFather 建好 bot 并拿到 token。

```bash
# 1. 把 deploy-tg/ 整个目录传到服务器(含 pkg/*.tgz)
scp -r deploy-tg user@server:/opt/hdsi

# 2. 启动(首次会自动初始化 Koishi 实例到 ./koishi)
cd /opt/hdsi && docker compose up -d

# 3. 安装插件(HDSI-TG + Telegram 适配器 + SQLite 数据库)
docker compose exec koishi sh /opt/install.sh

# 4. 重启加载
docker compose restart koishi
```

然后本机开 SSH 隧道访问控制台:

```bash
ssh -L 5140:127.0.0.1:5140 user@server
# 浏览器打开 http://127.0.0.1:5140
```

> 要公网直接访问 5140,先把 compose 端口改成 `"5140:5140"`,并**立即**配置
> 防火墙白名单或反代认证——Koishi 控制台默认无密码,等于把机器人交出去。

## 控制台配置顺序

1. **adapter-telegram**:启用 → 填 BotFather 的 token → 保存。
2. **database-sqlite**:确认已启用(HDSI 的剧本/记忆存 SQLite)。
3. **hds-interlude**:
   - **模型中心**:一行模型连接。`mode=openai-compatible` 填 Endpoint/Key/模型名,
     勾"用作主叙事模型";或用 `deepseek-official` / `zhipu-official` 官方模式。
     主叙事要 JSON 输出稳定、便宜的模型(GLM-5.3-Flash / deepseek-chat 级别)。
   - **基础设定**:主角/世界观/配角/叙事风格(你的人设粘贴到这里)。
   - **平台控制**:OneBot 部分忽略不启用(TG 不走它)。
   - **贴纸库**(可选):启用后把表情包文件放到 `./koishi/data/hds-interlude/stickers/`。
   - **视觉**(可选):主模型支持图片输入用 `native`;否则配一个视觉连接用
     `sidecar`(推荐,token 不出服务器)。
   - **剧情节奏**:自动推进间隔先调长(30-60 分钟),跑稳了再加密;主动联系显式开启。
4. 在 TG 里**先给 bot 发一次 /start**(TG 规矩:用户没 /start 过,bot 无法主动发消息),
   之后私聊随便聊;主动联系在此之后随时生效。

## 自定义 TG API 域名(反代)

三层各管一段,别混淆:

| 层 | 谁决定 | 怎么配 |
|---|---|---|
| **图片下载 URL 的域名**(HDSI 收到的 `img src`) | 适配器的 `files.baseUrl`(默认 `https://api.telegram.org`) | 控制台 → adapter-telegram → 文件设置 → "文件请求的终结点" 填 `https://tgapi.yegetables.com` |
| **识图 allowlist**(HDSI 肯不肯去拉这个图源) | HDSI(本 fork) | 环境变量 `HDSI_TRUSTED_IMAGE_HOSTS=tgapi.yegetables.com`(compose 里加),或控制台 → hds-interlude → 图片理解 → 额外信任域名 |
| **Bot API 调用端点**(sendMessage/getFile 等) | 适配器源码**硬编码** `https://api.telegram.org` | 换域名无效。服务器连不上 TG 时,正确姿势是给 Koishi 配 HTTP 代理(@koishijs/plugin-proxy-agent + 全局 http.proxy),或用境外服务器 |

即:自建反代 `tgapi.yegetables.com` 后,把上面第 1、2 层都指向它,识图链路就走反代;
但 **API 调用层永远直连 api.telegram.org**,务必确保服务器本身可达(代理或境外机)。

## 运维

- **备份**:`./koishi` 目录(数据库、配置、node_modules 全在内)。
- **升级插件**:本地重新 `npm run build && npm pack` → 覆盖 `pkg/*.tgz` → 重跑 install → restart。
- **常见问题**:剧情崩坏/格式失败 → 换更强的主叙事模型,比调配置有效;
  token 消耗 → 自动推进是常驻开销,间隔与休息时段控制成本。
- **许可**:上游 AGPL-3.0,本 fork 同协议;自用无义务,对外提供服务需开源修改。
