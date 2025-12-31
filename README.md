# Yet Another HTTP Proxy Server (yahps)

基于 Bun 的正向代理服务。支持这种访问形式：

```
https://你的域名/https://目标域名/path?a=1
```

实际请求会被转发为 `https://目标域名/path?a=1`。

## 配置

默认会读取「可执行文件同目录」下的 `config.js`。如果需要自定义路径，
使用环境变量 `CONFIG` 指定：

```console
CONFIG=/etc/yahps.config.js bun run src/index.ts
```

也可以通过 `PORT` 指定监听端口。

`config.js` 示例：

```js
export default {
  allowlist: [/^https:\/\/example\.com/],
  denylist: [/^https:\/\/example\.com\/private/],
};
```

规则说明：

- 先匹配 denylist，命中则直接拒绝
- 如果 allowlist 非空，目标 URL 必须至少命中一条 allow 规则

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
