# Login 功能后端实现指南

## 概述

`deckflow login` 命令使用**本地服务器回调**方式实现自动登录，类似于 GitHub CLI、AWS CLI 等工具。

## 工作流程

```
┌─────────┐                ┌──────────┐              ┌─────────────┐
│   CLI   │                │ Browser  │              │   Backend   │
└────┬────┘                └────┬─────┘              └──────┬──────┘
     │                          │                           │
     │ 1. Start local server    │                           │
     │  (http://localhost:3737) │                           │
     ├─────────────────────────>│                           │
     │                          │                           │
     │ 2. Open browser          │                           │
     │    /login?callback_url=  │                           │
     │    http://localhost:3737 │                           │
     ├─────────────────────────>│                           │
     │                          │                           │
     │                          │ 3. User login             │
     │                          ├─────────────────────────> │
     │                          │                           │
     │                          │ 4. Generate token         │
     │                          │ <───────────────────────> │
     │                          │                           │
     │ 5. Redirect to callback  │                           │
     │    http://localhost:3737 │                           │
     │    ?token=xxx            │                           │
     │ <─────────────────────── │                           │
     │                          │                           │
     │ 6. Receive token & save  │                           │
     │                          │                           │
```

## 后端实现要求

### 1. `/login` 端点

**请求：**
```
GET /login?callback_url=http://localhost:3737
```

**参数：**
- `callback_url`: CLI 本地服务器的回调地址（必需）

**功能：**
1. 显示登录页面（或跳转到 OAuth 登录页面）
2. 用户完成登录后，生成 token
3. 重定向到 `callback_url?token=<generated_token>`

### 2. 实现示例（Express.js）

```javascript
// GET /login
app.get('/login', async (req, res) => {
  const callbackUrl = req.query.callback_url;

  // 验证 callback_url
  if (!callbackUrl) {
    return res.status(400).send('Missing callback_url parameter');
  }

  // 验证 callback_url 是本地地址（安全考虑）
  const url = new URL(callbackUrl);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return res.status(400).send('Invalid callback_url: must be localhost');
  }

  // 存储 callback_url 到 session
  req.session.callbackUrl = callbackUrl;

  // 渲染登录页面
  res.render('login', {
    callbackUrl: callbackUrl
  });
});

// POST /login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const callbackUrl = req.session.callbackUrl;

  try {
    // 验证用户凭证
    const user = await authenticateUser(email, password);

    // 生成 token
    const token = await generateToken(user.id);

    // 重定向到 callback URL
    res.redirect(`${callbackUrl}?token=${token}`);
  } catch (error) {
    res.render('login', {
      error: 'Invalid credentials',
      callbackUrl: callbackUrl
    });
  }
});
```

### 3. 登录页面示例（HTML）

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Deckflow CLI Login</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .login-container {
      background: white;
      padding: 2rem;
      border-radius: 1rem;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      margin: 0 0 1.5rem 0;
      color: #333;
    }
    .form-group {
      margin-bottom: 1rem;
    }
    label {
      display: block;
      margin-bottom: 0.5rem;
      color: #555;
    }
    input {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 0.5rem;
      font-size: 1rem;
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 0.5rem;
      font-size: 1rem;
      cursor: pointer;
      margin-top: 1rem;
    }
    button:hover {
      background: #5568d3;
    }
    .error {
      background: #fee;
      color: #c33;
      padding: 0.75rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
    }
    .info {
      background: #e3f2fd;
      color: #1976d2;
      padding: 0.75rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>🔐 Deckflow CLI Login</h1>

    <div class="info">
      Logging in from your terminal. After successful login, you'll be redirected automatically.
    </div>

    <% if (error) { %>
      <div class="error"><%= error %></div>
    <% } %>

    <form method="POST" action="/login">
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required>
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
      </div>

      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>
```

## 安全考虑

### 1. 验证 callback_url

只允许 localhost/127.0.0.1 的回调地址：

```javascript
const url = new URL(callbackUrl);
if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
  return res.status(400).send('Invalid callback_url');
}
```

### 2. Token 安全

- 使用 JWT 或其他安全的 token 格式
- 设置合理的过期时间
- Token 只能使用一次（单次有效）或有时间限制

```javascript
function generateToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}
```

### 3. HTTPS

生产环境应使用 HTTPS：

```javascript
// 检查是否是生产环境
if (process.env.NODE_ENV === 'production') {
  // 确保使用 HTTPS
  if (req.protocol !== 'https') {
    return res.redirect('https://' + req.get('host') + req.url);
  }
}
```

## OAuth 集成（可选）

如果使用第三方 OAuth 登录（如 Google, GitHub）：

```javascript
app.get('/login', (req, res) => {
  const callbackUrl = req.query.callback_url;
  req.session.callbackUrl = callbackUrl;

  // 重定向到 OAuth 提供商
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${OAUTH_CALLBACK}&` +
    `response_type=code&` +
    `scope=email profile`;

  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  const callbackUrl = req.session.callbackUrl;

  // 用 code 换取 access token
  const oauthToken = await exchangeCodeForToken(code);

  // 获取用户信息
  const user = await getUserInfo(oauthToken);

  // 创建或更新用户
  const localUser = await createOrUpdateUser(user);

  // 生成 CLI token
  const cliToken = await generateToken(localUser.id);

  // 重定向到 CLI 回调
  res.redirect(`${callbackUrl}?token=${cliToken}`);
});
```

## 测试

使用 curl 测试后端实现：

```bash
# 1. 获取登录页面
curl "http://localhost:3000/login?callback_url=http://localhost:3737"

# 2. 提交登录（模拟）
curl -X POST http://localhost:3000/login \
  -d "email=test@example.com" \
  -d "password=testpass" \
  -L  # 跟随重定向

# 应该重定向到：http://localhost:3737?token=xxx
```

## 完整示例代码

参考实现：https://github.com/your-org/deckflow-backend/tree/main/examples/cli-login

## 常见问题

**Q: 为什么要用本地服务器而不是让用户复制粘贴 token？**

A: 本地服务器回调提供更好的用户体验，用户只需在浏览器中登录，无需手动复制粘贴。这是现代 CLI 工具的标准做法。

**Q: 如果用户的端口 3737 被占用怎么办？**

A: CLI 支持 `--port` 参数自定义端口：
```bash
deckflow login --port 8080
```

**Q: 如何处理防火墙/代理环境？**

A: 在这种情况下，可以提供备用方案：
1. 显示登录 URL，让用户手动打开
2. 登录成功后，显示 token 让用户手动执行 `deckflow config set-token <token>`
