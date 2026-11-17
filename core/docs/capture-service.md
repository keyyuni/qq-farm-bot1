# 抓包登录服务手册

本服务通过内置 MITM（中间人）代理抓取手机 QQ 农场小程序的登录 Code 与好友 GID，
用于「添加账号 → 抓包登录」流程。移植自 qq-farm-bot 抓包子系统。

## 工作原理

- 应用启动时在进程内拉起抓包核心（嵌入模式，默认开启）；
- 核心包含：根 CA 证书 → 会话存储 → MITM 代理 → 好友 GID 提取器；
- 手机将 Wi-Fi 代理指向本服务后，对 `*.nqf.qq.com` 等抓取域名做 TLS 中间人，
  从网关 WebSocket 升级请求中提取 `code` / `openID`，并解析服务器推送的
  `FriendService.GetAll/SyncAll/GetGameFriends` 回包提取好友 GID；
- 其他域名走原始 TCP 隧道（不解密）。

## 使用流程

1. 确认「系统配置 → Code/GID 抓取服务」中抓包登录已开启（默认开启）。
2. 进入「添加账号 → 抓包登录」，点击「开始抓取」。
3. 手机安装并信任面板提供的根 CA 证书（面板有下载链接，iOS 需在
   设置 → 通用 → 关于本机 → 证书信任设置中手动开启信任）。
4. 将手机 Wi-Fi 的 HTTP 代理设置为面板显示的 `地址:端口`。
5. 手机上打开 QQ 农场小程序，面板会自动显示抓到的登录信息并完成账号添加。

## 配置

配置文件位于 `core/data/capture/config.json`，首次启动自动生成默认配置；
环境变量优先级最高（适用于 Docker/二进制部署）：

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `CAPTURE_API_HOST` | API 监听地址（独立模式） | `127.0.0.1` |
| `CAPTURE_API_PORT` | API 端口（独立模式） | `8450` |
| `CAPTURE_API_TOKEN` | API Bearer Token（独立模式必填） | 空 |
| `CAPTURE_PROXY_BIND` | 代理监听 IP（逗号分隔） | `0.0.0.0` |
| `CAPTURE_ADVERTISE_IPS` | 对外公布的 IP，`auto` 自动检测 | `auto` |
| `CAPTURE_PREFER_ORDER` | 地址排序优先级 | `tailscale,lan,other` |
| `CAPTURE_PORTS` | 代理端口（如 `18000`），不设则每次启动随机 | 随机 2000-9999 |
| `CAPTURE_HOSTS` | 需要中间人的域名（支持 `*.`） | `*.nqf.qq.com` 等 |
| `CAPTURE_AUTOSTOP_SEC` | 代理自动停止秒数 | `900` |
| `CAPTURE_SESSION_TTL_MS` | 会话过期时间 | `3600000` |
| `CAPTURE_DATA_DIR` | 数据目录覆盖 | 复用 bot 数据目录 |

面板侧配置（嵌入/独立模式切换、自动导入好友 GID 开关）保存在
`core/data/capture-config.json`。

## 运行模式

- **嵌入模式（默认）**：随应用启动，进程内直接调用，不占用独立端口；
- **独立模式**：`pnpm capture`（等价 `pnpm -C core capture` / `tsx capture-server.ts`）
  监听独立 API 端口（默认 8450），面板配置中关闭「嵌入模式」并填写 API Base 与 Token。

## REST API（独立模式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（免认证） |
| POST | `/api/sessions` | 创建抓包会话（请求头 `x-capture-session-id`） |
| POST | `/api/capture/start` | 启动 MITM 代理 |
| POST | `/api/capture/stop` | 停止 MITM 代理 |
| GET | `/api/sessions/:id/state` | 查询抓取状态（code/好友/代理信息） |
| DELETE | `/api/sessions/:id` | 停止并删除会话 |
| GET | `/cert/mitmproxy-ca-cert.cer` | 下载根 CA 证书（DER/.cer） |

独立模式下所有 `/api` 接口需携带 `Authorization: Bearer <token>`。

## 抓包协议分析工具

使用抓包 HAR 或二进制帧目录检查协议定义的兼容性：

```bash
pnpm inspect:protocol -- <抓包.har|bin目录> [选项]

# 选项
--service <名称>       按完整或末尾 service 名过滤
--method <名称>        按 method/通知类型过滤
--direction <方向>     request、response 或 notify
--shape                仅输出 protobuf wire 结构摘要
--audit                发现未知字段、wire 不匹配或缺失类型时返回非零状态
--decrypt-requests     使用本地 TSDK WASM 解密请求 body
--show-sensitive       不脱敏已知敏感字段
--pretty               格式化 JSON 输出（默认 JSON Lines）
```

## 安全提示

根 CA 被手机信任后，可解密该手机经代理的**所有** HTTPS 流量。
仅应在受信任网络与自己的设备上启用；用完后及时停止代理并删除证书信任。
