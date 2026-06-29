# 批量 Markdown 投递

服务端会自动扫描批量投递目录，把 Markdown 和同目录图片生成资料卡。

默认目录：

```text
<SVN_WORKING_COPY_ROOT>/01_文献史料
```

当前本地如果 `.archive-data/svn-root.txt` 指向 `E:\X28Assets\X28Ref`，默认投递目录就是：

```text
E:\X28Assets\X28Ref\01_文献史料
```

也可以用环境变量覆盖：

```env
ARCHIVE_MARKDOWN_IMPORT_ROOT=D:\Your\Svn\01_文献史料
```

## 命名

```text
cao-cao-middle-age.md
cao-cao-middle-age_01.jpg
cao-cao-middle-age_02.png
cao-cao-middle-age_03.webp
```

多图使用同名后缀：`_01`、`_02`、`_03`，也支持 `-01`、`-02`。如果 Markdown 里写了 `images:`，服务端会优先使用显式图片列表。

建议实习整理时保持一个资料卡一份 Markdown。只有图片、没有同名 Markdown 的根目录散图会被忽略；像 `秦汉漆器图录` 这种子文件夹，只要里面有图片，就会自动生成一张图录卡。

## Markdown 示例

```markdown
---
title: 曹操中年角色冠服参考
summary: 中年曹操角色设定用冠服、袍服与佩饰参考。
period: 东汉
type: 角色设计参考
category: 冠帽、袍服
identityTypes: 权臣、武官
officialTypes: 丞相、将军
sourceType: 内部整理
referencePurpose: 造型转化参考
usageHints: 角色设定、服装拆解
tags: 曹操、冠帽、东汉、角色参考
sourceUrl: https://example.com/source-page
createdBy: 实习整理
images:
  - cao-cao-middle-age_01.jpg
  - cao-cao-middle-age_02.png
---

# 曹操中年角色冠服参考

这里写正文描述、考据备注、使用注意事项。第一段会在没有 summary 时作为卡片摘要。
```

## 同步

- 打开站点或刷新资料库时，`GET /api/archive/items` 会先扫描投递目录并写入资料库。
- 也可以手动请求 `POST /api/archive/imports/markdown` 立即同步。
- `GET /api/archive/imports/markdown` 可查看上次同步状态和投递目录。
- Markdown 和图片应放在 SVN 工作副本目录内；站点会引用 SVN 相对路径显示图片。
- 同步时服务端会尝试对本次扫描到的 Markdown 和图片执行 `svn add --parents --force`。
- 原始 Markdown 和图片是否真正提交到 SVN，仍按团队现有 `svn commit` 流程执行。
