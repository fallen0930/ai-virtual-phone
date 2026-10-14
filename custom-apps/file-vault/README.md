# 文件库（file.vault）

世界观 / 人设 / 剧情等**长篇材料的私人仓库**，也是聊天室「从文件库导入」的数据源。

## 它解决什么

- 手上散着一堆 `docx / doc / txt / pdf` 世界观文档，想统一收进来、分类、写备注，需要时一句话捞出来。
- 聊天室里要喂给角色超长设定，不想每次手动复制粘贴。
- 材料要能带走：导出单篇、导出整库 zip、整库 json 备份 + 恢复。

## 用法

1. **导入材料** —— 点顶部按钮选文件（可多选 / 可拖拽）。导入时统一指定「这批的分类」和「统一标签」，导完再逐条细调。
   - 解析能力：`.docx`（自写 zip 解包 + `word/document.xml` 抽段落）、`.txt`（utf-8 / gb18030 / gbk / big5 / utf-16 自动探测）、`.md`、`.rtf`、伪装成 `.doc` 的 rtf/html；
   - `.doc` 旧版二进制：**尽力抽取**（utf-16le 与 gb18030 双解码比分数择优），抽不干净时应用会提示你另存为 `.docx`；
   - `.pdf`：联网加载 PDF.js 按页抽文字层，扫描件（无文字层）会明确报错。
2. **分类 / 标签 / 备注** —— 详情页里改。分类是单选（世界观 / 人物 / 剧情 / 设定 / 规则 / 其他，也可以自己敲），标签是逗号分隔的多个，备注写给自己看，会一并进入「引用块」。
3. **搜索** —— 标题、正文、标签、备注全文匹配；顶部 chips 按分类筛，列表里的标签点一下就按标签筛。
4. **导出**
   - 单篇：详情页「导出 txt / md / json」；
   - 整库：底部「整库导出 zip」（`index.json` 元数据 + `materials/` 每条正文纯文本）或「整库备份 json」；
   - 换设备：新设备上用「更多 → 从 json 备份恢复」，同标题同字数视为重复自动跳过。
5. **复制引用块** —— 生成一段带标题 / 分类 / 标签 / 备注 / 正文的文本，可以直接粘进任何聊天框。

## 和聊天室的联动

聊天室输入框旁的文件按钮里有一项 **「从文件库导入」**：它读的就是这个 APP 的 `documents` 集合（`ai_phone_custom_app_data_v1:<appId>/documents`）。
所以只要这个 APP 装着，你在聊天里就能直接挑一条材料发出去，不用再走一遍选文件、解析的过程。

## 权限

`app.data.read` / `app.data.write`（本地材料库读写）、`app.manifest.read`（读自身信息）、`ui.toast`（操作提示）。
数据只存在本机应用沙盒（IndexedDB），不上传云端。

## 目录

```
manifest.json   应用清单（id / 版本 / 权限）
index.html      应用本体（单文件：内联 CSS + JS，零外部依赖）
icon.svg        图标
README.md       本文件
file-vault.zip  打包产物，用于「应用工坊 → 导入」
```

## 重新打包

```bash
node tools/build-custom-app-zip.mjs file-vault
```

会读本目录下的 `manifest.json` + entry + icon + README.md，产出同目录的 `file-vault.zip`（内部结构与应用工坊的包格式一致）。

### 装过旧版怎么更新

应用工坊 → 本地测试（创作区）→ 找到「文件库」→ 点卡片上的 **「换包」** → 选新 zip。
这是**原地替换，已有的材料数据会保留**。别用「卸载再装」——那会连数据一起清掉。

## 沙盒限制（写这个 APP 时踩到的）

应用跑在 `sandbox="allow-scripts allow-downloads"` 的 iframe 里，**不透明源**，因此：

- **`window.confirm` / `alert` / `prompt` 会被浏览器静默忽略**（confirm 直接返回 `false`，alert 什么都不显示）。
  → 本应用的确认框、失败提示、复制兜底全部是自己画的 `.fv-dialog`（`askConfirm` / `showNotice` / `showCopyFallback`），**不要改回 window.confirm**。
- `localStorage` / `sessionStorage` / 直接 `indexedDB` 一律不可用 → 数据只走 `AiPhone.db`。
- `new Worker` 起不来（PDF.js 会退化成主线程解析）、`navigator.clipboard` 多半被拒 → 复制有「摊出文本让你手动选」的兜底。
- 导出下载走 `<a download>` + blob URL，失败时回落 data URL。

## 已知边界

- 单条正文上限 60 万字；材料库最多 500 条（宿主 `db.list` 的单集合上限）。
- 同一集合内一条记录就是一条材料，导入是逐条写入，方便单独编辑与删除。
- `.doc` 二进制抽取是启发式的，复杂文档可能漏段或混入杂字符，**关键材料请另存为 `.docx` 后重导**。
