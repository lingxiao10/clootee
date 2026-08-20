# assist —— 可嵌任意网页的 AI 学习小助手组件

一行 `<script>` 就能给任意静态网页加一个能看懂本页的 AI 侧栏。单文件、零依赖、无后端。

| 文件 | 作用 |
|---|---|
| `assistant.js` | 组件本体（唯一产物，548 行，无依赖） |
| `docs.md` | **给 AI 读的接入文档**，生成教程时把这个地址丢给 AI |
| `index.html` | 落地页，本身就嵌着组件，等于活的演示 |
| `deploy/assist.xfeixie.com.conf` | nginx 配置 |

## 两个可用地址

- **本机**（Clootee 在跑时）：`http://localhost:8970/assist/assistant.js`
- **公网**（部署后）：`https://assist.xfeixie.com/assistant.js`

要发给别人或双击打开的教程，把 `assistant.js` 拷到 HTML 旁边用 `./assistant.js` 引用，
这样整个文件夹能随便拷贝，断网也打得开。

## 首次部署（personal1 106.13.193.3，root）

仓库按约定走 git，不手动传文件：

```bash
# 1. 检出仓库（该机直连 github 不通，走本机 xray 代理）
mkdir -p /www/wwwroot && cd /www/wwwroot
git clone https://github.com/lingxiao10/clootee.git
cd clootee && git config http.proxy http://127.0.0.1:10809

# 2. 证书（acme.sh webroot 签发，目录放在站点外，git pull 不受影响）
mkdir -p /www/wwwroot/assist.xfeixie.com_acme
~/.acme.sh/acme.sh --issue -d assist.xfeixie.com -w /www/wwwroot/assist.xfeixie.com_acme
~/.acme.sh/acme.sh --install-cert -d assist.xfeixie.com \
  --key-file       /www/server/panel/vhost/cert/assist.xfeixie.com/privkey.pem \
  --fullchain-file /www/server/panel/vhost/cert/assist.xfeixie.com/fullchain.pem \
  --reloadcmd      'nginx -s reload'

# 3. nginx
cp /www/wwwroot/clootee/projects/claude_hub/frontend/assist/deploy/assist.xfeixie.com.conf \
   /www/server/panel/vhost/nginx/
nginx -t && nginx -s reload
```

## 以后更新

```bash
cd /www/wwwroot/clootee && git pull
```

静态文件，不用重启任何进程。`Cache-Control: max-age=300`，5 分钟内生效。

## 验收

```bash
curl -I https://assist.xfeixie.com/assistant.js   # 200 + Access-Control-Allow-Origin: *
curl -s https://assist.xfeixie.com/docs.md | head # 纯文本，不是下载
```

再用浏览器打开 `https://assist.xfeixie.com/` —— 落地页自己就装着组件，
右上角能点开、能划词、填了 Key 能问，就算通。
