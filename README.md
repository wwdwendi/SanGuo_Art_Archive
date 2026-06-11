# 三国服饰资料库

## 资料保存同步

新建资料页不会把正式数据保存到浏览器 `localStorage`。保存草稿和保存资料都会请求资料库 API：

```env
VITE_ARCHIVE_API_BASE_URL=http://127.0.0.1:8791/api/archive
```

本仓库提供一个最小文件型 API 服务，适合内网部署或开发联调：

```bash
npm run api
npm run dev
```

如果需要让局域网同事直接访问你这台机器上的开发页面，用：

```bash
npm run dev:lan
```

独立 API 默认监听 `0.0.0.0:8791`，同事机器可以通过你的内网 IP 访问同一份资料库。只想本机使用时可以改回：

```bash
set ARCHIVE_API_HOST=127.0.0.1
npm run api
```

接口：

```http
POST /api/archive/drafts
POST /api/archive/items
POST /api/archive/web-clips
GET /api/archive/drafts
GET /api/archive/items
GET /api/archive/health
```

`GET /api/archive/items` 会同时返回 `items` 和网页采集产生的 `assets`。前端启动时会读取共享资料库，并每 15 秒刷新一次；保存正式资料后也会立即重新拉取，其他同事刷新或等待轮询后能看到同一份数据。

默认数据写入 `.archive-data/archive-db.json`。要让同事看到同一份资料，需要把 `npm run api` 部署在团队都能访问的机器上，并把前端环境变量 `VITE_ARCHIVE_API_BASE_URL` 指向这台服务，例如：

```env
VITE_ARCHIVE_API_BASE_URL=http://archive-server.company.local:8791/api/archive
```

生产环境建议后续把这个文件型服务替换为正式数据库；前端接口路径可以保持不变。

## SVN 图片库接入

前端不会直接连接 SVN，也不应该在浏览器里保存 SVN 账号密码。真实 SVN 由本项目的后端代理读取本地 SVN 工作副本。

先在服务器或你的电脑上 checkout 图片库，然后启动服务前配置工作副本根目录：

```bash
set SVN_WORKING_COPY_ROOT=D:\Your\Svn\CostumeLibrary
npm run api
npm run dev:lan
```

如果使用 `start.bat` 启动，把 SVN 工作副本路径写入本地配置文件即可：

```text
.archive-data/svn-root.txt
```

文件内容示例：

```text
D:\Your\Svn\CostumeLibrary
```

修改后需要重新运行 `start.bat`，让 API 服务重新读取路径。

图片选择弹窗会请求：

```http
GET /api/svn/files?path=文官&q=关键词
```

默认前端会请求同源 `/api/svn`。如果 SVN 代理部署在另一台机器，也可以显式指定：

```env
VITE_SVN_API_BASE_URL=http://archive-server.company.local:8791/api/svn
```

接口返回：

```json
{
  "total": 128,
  "folders": ["/History/东汉", "文官", "武官", "民俗", "器物", "建筑"],
  "files": [
    {
      "assetId": "img-robe-01",
      "name": "东汉末文官宽袍大袖.jpg",
      "path": "/Costume/LateHan/robes/scholar-wide-sleeve.jpg",
      "thumbnailUrl": "/api/svn/file?path=%2FCostume%2FLateHan%2Frobes%2Fscholar-wide-sleeve.jpg",
      "sizeLabel": "PNG · 220KB"
    }
  ]
}
```

系统会把 SVN 相对路径转换成资料库图片资产。选择图片后，保存资料会把这些资产一起写入共享资料库，同事刷新或等待轮询后可见。
