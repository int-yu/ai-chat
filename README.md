# Grok 随身对话

一个面向手机浏览器的 JBB Grok 聊天页面。支持流式回答、多会话历史、停止与重试，以及接近上下文上限时自动提炼历史重点。

聊天记录和 JBB 密钥只保存在当前浏览器。Cloudflare Worker 只负责把请求转发到 `https://jbbtoken.pages.dev`，不会保存密钥或聊天内容。

## 第一次部署

### 1. 准备 Cloudflare 账号

前往 [Cloudflare 注册页面](https://dash.cloudflare.com/sign-up) 创建免费账号并验证邮箱。不需要购买域名。

在电脑打开本项目目录，安装开发工具：

```powershell
npm install
```

登录 Cloudflare：

```powershell
npx wrangler login
```

浏览器会打开授权页面。确认后发布 Worker：

```powershell
npm run deploy:worker
```

成功后会显示类似下面的地址：

```text
https://jbb-grok-chat-proxy.你的账号子域.workers.dev
```

### 2. 把 Worker 地址写入网页

将上一步的完整地址放到命令末尾：

```powershell
npm run configure:worker -- https://jbb-grok-chat-proxy.你的账号子域.workers.dev
```

该命令会同时更新前端连接地址和页面安全策略。随后检查项目：

```powershell
npm test
npm run check
```

### 3. 发布 GitHub Pages

将修改提交并推送到 `main` 分支，然后在 GitHub 仓库中打开：

`Settings` → `Pages` → `Build and deployment` → `Deploy from a branch`

选择 `main` 和 `/(root)`，保存。稍等片刻后访问：

<https://int-yu.github.io/ai-chat/>

打开网页，填入 JBB API 密钥，即可加载账号下可用的 Grok 模型并开始聊天。

## 手机上使用

- iPhone Safari：分享 → 添加到主屏幕。
- Android Chrome：菜单 → 添加到主屏幕。
- 密钥和历史由浏览器保存。清理站点数据、无痕模式结束或卸载浏览器可能导致历史丢失。
- 本应用不做跨设备同步。重要对话请自行复制备份。

## 上下文优化

应用默认按 128,000 tokens 估算上下文；若模型列表提供窗口大小，则使用模型返回的数值。输入达到安全窗口的 70% 后：

1. 保留最近 8 个完整问答轮次原文。
2. 调用当前 Grok 模型提炼更早内容。
3. 后续请求发送“摘要 + 最近原文”。
4. 页面仍保留并展示完整历史，不会删除早期消息。

摘要本身会额外产生一次 JBB API 调用费用。若上游先返回上下文超限，应用会强制优化并自动重试一次。

## 安全说明

- 仓库、Worker 配置和部署文件中都不包含你的 JBB 密钥。
- Worker 只开放 `/v1/models` 与 `/v1/chat/completions`，只允许 Grok 模型，单次请求最多 2 MB。
- 页面不加载第三方运行时脚本，并通过 CSP 限制网络目标。
- 密钥保存在浏览器 localStorage 中，没有使用无法提供实际安全性的“前端伪加密”。任何能控制设备、浏览器配置文件或本页面源代码的人仍可能读取密钥。
- 不要使用来历不明的公共 CORS 代理，它们能够看到你的密钥和聊天内容。

## 常见问题

### 页面提示“Worker 尚未配置”

重新执行“把 Worker 地址写入网页”步骤，并提交、推送修改。

### 密钥无效或模型列表为空

先在 JBB 网站确认密钥可用。若账号确实有 Grok 模型但列表未被识别，可在设置中手动填写包含 `grok` 的完整模型名称。

### 手机打不开或连接不稳定

先分别打开 GitHub Pages 地址和 `*.workers.dev` 地址确认网络可达。不同地区和运营商对这些域名的连通性可能不同。

## 本地验证

```powershell
npm install
npm test
npm run check
```

自动测试覆盖流式数据解析、API 错误、上下文压缩、本地存储、安全渲染、Worker 限制和页面基础结构。
