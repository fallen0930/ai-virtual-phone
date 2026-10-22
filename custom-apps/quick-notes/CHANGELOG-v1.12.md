# v1.12 - 导出功能

## 新增功能

### 📤 笔记导出

在编辑面板底部添加"导出"按钮，支持四种格式：

- **Markdown (.md)**: 包含标题、元信息（分类/标签/状态/时间）、正文、AI总结、附件列表。可用Word/WPS直接打开并另存为docx。
- **TXT (.txt)**: 纯文本格式，去掉Markdown标记，适合快速阅读和分享。
- **JSON (.json)**: 完整的笔记数据结构，便于后续导入或程序化处理。
- **ZIP (.zip)**: 🗜️ **完整备份格式**，包含`note.md`文本文件 + `attachments/`文件夹（所有原始附件文件），适合数据备份、迁移和长期存档。

**使用方式**:
1. 打开任意笔记的编辑面板
2. 点击底部的"导出"按钮
3. 选择导出格式（含附件时仅ZIP可用）
4. 文件自动下载到本地

**附件导出策略**:
- **含附件的笔记**：仅允许ZIP导出，确保附件文件完整保留
- **纯文本笔记**：可选Markdown/TXT/JSON/ZIP任意格式
- Markdown中不嵌入图片base64（避免文件过大无法打开），改为显示提示引导使用ZIP

**技术实现**:
- 使用Blob + URL.createObjectURL实现浏览器端文件下载
- Markdown格式保留完整的结构化信息，方便二次编辑
- JSON格式包含所有字段（包括attachments的base64数据），支持完整恢复
- **ZIP打包**：引入JSZip库（CDN加载），每条笔记打包为独立zip文件，包含markdown文本和原始附件文件，确保附件不丢失

## 沙盒环境限制说明

**为什么不支持doc/docx导出？**

自定义App运行在沙盒环境中，无法直接使用Office文件格式生成库（如`docx` npm包）。浏览器端生成docx需要复杂的二进制处理，超出了当前环境的能力范围。

**替代方案**: 
- 导出Markdown格式，用Word/WPS打开后可一键另存为docx
- Markdown保留了所有关键信息，格式转换无损

## 文件结构变更

- 新增HTML抽屉组件：`qnExportSheet`（导出格式选择对话框）
- 新增函数：
  - `openExport(noteId)`: 打开导出对话框
  - `generateMarkdown(note)`: 生成Markdown格式文本
  - `generateTxt(note)`: 生成TXT格式文本
  - `generateJson(note)`: 生成JSON格式文本
  - `downloadFile(content, filename, mimeType)`: 触发文件下载
  - `doExport(format)`: 执行导出逻辑
  - `formatDate(dateStr)`: 日期格式化辅助函数
- 更新`closeSheets()`: 加入导出对话框的关闭逻辑

## 下一步计划

Phase 3.1: 目标追踪 - 将笔记关联到长期目标，追踪思考进展
