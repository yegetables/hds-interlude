/**
 * Fork 版本 = 上游版本 + `-tg.N` 后缀,标识 Telegram 适配 fork 的第 N 次修订。
 * 上游发布以 `0.1.4` 这类纯版本号为准;文档与发布物料沿用上游基准版本,
 * 见 test/release-consistency.test.ts 中的 FORK_BASE_VERSION。
 */
export const HDS_INTERLUDE_VERSION = '0.1.4-tg.3'

/** 上游基准版本:发布一致性检查中,文档与部署 HTML 仍按上游版本命名。 */
export const FORK_BASE_VERSION = '0.1.4'
