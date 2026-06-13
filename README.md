# Yet Another HTTP Proxy Server (yahps)

基于 Bun 的正向代理服务。支持这种访问形式：

```
https://你的域名/你的代理路径/https://目标域名/path?a=1
```

实际请求会被转发为 `https://目标域名/path?a=1`。

本项目为纯 AI 辅助实验品，仅供学习交流使用，请勿用于商业用途。

没有缓存等功能，仅做最简单的请求转发。

## 配置

默认会读取「可执行文件同目录」下的 `config.js`。如果需要自定义路径，
使用环境变量 `CONFIG` 指定：

```console
CONFIG=/etc/yahps.config.js bun run index.ts
```

也可以通过 `HOST` 和 `PORT` 指定监听地址和端口。

`config.js` 示例：

```js
export default {
  proxyPath: "/yahps-secret-path",
  allowlist: [/^https:\/\/example\.com/],
  denylist: [/^https:\/\/example\.com\/private/],
  userAgentAllowlist: [/^Mozilla\//],
  userAgentDenylist: [/bot/i],
  localRejectionResponse: {
    status: 404,
    body: "Not Found.",
    headers: {
      "cache-control": "no-store",
    },
  },
};
```

规则说明：

- `proxyPath` 可选，用于配置代理入口路径；不配置时默认使用 `/`
- 配置 `proxyPath` 后，请求必须使用 `/<proxyPath>/https://目标域名/path` 形式
- 先匹配 denylist，命中则直接拒绝
- 如果 allowlist 非空，目标 URL 必须至少命中一条 allow 规则
- 上游 30x 响应带有可解析的 `Location` 时，yahps 会先对 redirect destination
  执行相同的 URL allowlist/denylist 规则；允许后会把 `Location` 改写成当前
  `proxyPath` 下的 yahps URL 并返回 30x，拒绝时返回本地拒绝响应
- `userAgentDenylist` 和 `userAgentAllowlist` 可选，用于按 `User-Agent` 请求头配置正则规则
- `User-Agent` 规则同样先匹配 denylist；如果 `userAgentAllowlist` 非空，请求的
  `User-Agent` 必须至少命中一条 allow 规则
- `localRejectionResponse` 可选，用于配置 yahps 本地拒绝请求时返回的状态码和响应体
- `localRejectionResponse.status` 必须是 `200` 到 `599` 之间的整数，`body` 必须是字符串
- `localRejectionResponse.headers` 可选，用于配置本地拒绝响应头
- `localRejectionResponse.headers` 不能配置 hop-by-hop 或 body framing/encoding 相关响应头，例如
  `connection`、`transfer-encoding`、`content-length`、`content-encoding`、`host`
- 本地拒绝包括：`CONNECT` 请求、缺少或无效的目标 URL、URL/User-Agent denylist 命中、
  URL/User-Agent allowlist 未命中
- 上游请求失败不会使用 `localRejectionResponse`，仍会返回 yahps 的诊断响应

如果不想部署后被滥用，建议同时配置：

- 严格的 URL `allowlist`/`denylist` 和 `userAgentAllowlist`/`userAgentDenylist`
- 复杂的 `proxyPath`，避免根路径 `/` 直接暴露代理能力
- 更通用的 `localRejectionResponse` 响应体，例如返回普通的 `404 Not Found`

GitHub 相关资源可参考:

GitHub archive 下载通常会从 `github.com` 30x 跳转到 `codeload.github.com`。
如果只允许 `github.com`，yahps 会在改写 `codeload.github.com` 的 `Location` 前拒绝它；
因此两者都需要放进 allowlist。允许后，客户端看到的会是 yahps URL，而不是原始
`https://codeload.github.com/...`。

```js
export default {
  allowlist: [
    /^https?:\/\/github\.com\//,
    /^https?:\/\/raw\.github\.com\//,
    /^https?:\/\/raw\.githubusercontent\.com\//,
    /^https?:\/\/gist\.github\.com\//,
    /^https?:\/\/objects\.githubusercontent\.com\//,
    /^https?:\/\/gist\.githubusercontent\.com\//,
    /^https?:\/\/avatars\.githubusercontent\.com\//,
    /^https?:\/\/release-assets\.githubusercontent\.com\//,
    /^https?:\/\/codeload\.github\.com\//,
    /^https?:\/\/api\.github\.com\//,
  ],
};
```

宽松

```js
export default {
  allowlist: [
    /^(https?:\/\/)(?:[\w-]+\.)*(?:github\.com|githubusercontent\.com)(?:\/|$)/i,
  ],
};
```

## systemd 示例

从 Releases 下载对应系统平台的可执行文件，放到 `/usr/local/bin/yahps`，并赋权：

```console
chmod +x /usr/local/bin/yahps
```

创建配置文件 `/etc/yahps.config.js`，然后创建 systemd 服务文件
`/etc/systemd/system/yahps.service`：

```
[Unit]
Description=yahps
After=network-online.target
Wants=network-online.target systemd-networkd-wait-online.service

[Service]
Type=simple
Restart=on-failure
RestartSec=5s
ExecStart=/usr/local/bin/yahps
Environment=CONFIG=/etc/yahps.config.js
Environment=HOST=127.0.0.1
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

启动服务：

```console
systemctl daemon-reload
systemctl enable --now yahps
```

查看日志：

```console
journalctl -f -o cat -n 100 -u yahps
```
