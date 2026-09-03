#!/usr/bin/env bash
# 在 koishi 容器内安装 HDSI-TG 插件包与 Telegram 适配器。
# 用法: docker compose exec koishi sh /opt/install.sh
set -e

cd /koishi

# 等待首启初始化完成(实例骨架出现 package.json 为止,最多 120 秒)
for i in $(seq 1 60); do
  [ -f package.json ] && break
  echo "等待 Koishi 实例初始化... ($i)"
  sleep 2
done
[ -f package.json ] || { echo "错误: /koishi 里没有实例骨架,首启可能失败,查 docker compose logs koishi"; exit 1; }

TGZ=$(ls /pkg/koishi-plugin-hds-interlude-*.tgz 2>/dev/null | head -n1)
[ -n "$TGZ" ] || { echo "错误: /pkg 里没有插件包。tgz 不在 git 仓库里,请从 Release 下载放到宿主机 koishi-pkg/ 目录:"; echo "  wget https://github.com/yegetables/hds-interlude/releases/download/v0.1.4-tg.2/koishi-plugin-hds-interlude-0.1.4-tg.2.tgz -O <koishi-pkg 目录>/"; exit 1; }

echo "安装 HDSI-TG: $TGZ"
yarn add "$TGZ" --exact
echo "安装 Telegram 适配器与 SQLite 数据库"
yarn add @koishijs/plugin-adapter-telegram @koishijs/plugin-database-sqlite
echo "完成。接下来: docker compose restart koishi,然后到控制台启用插件。"
