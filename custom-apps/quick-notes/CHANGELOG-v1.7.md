# v1.7 更新说明 - 移除设置 & 时间线分组切换

## 功能调整

### 1. 移除"设置"按钮和抽屉
**原因**：角色选择已集成到编辑面板的"问角色"功能中，每次使用时手动选择更灵活，无需预设默认角色。

**变更内容**：
- 移除顶部工具栏的"设置"按钮
- 移除设置抽屉（`qnSetSheet`）及其HTML结构
- 移除 `openSettings()`、`saveSettings()` 函数
- 移除 `qnSettings`、`qnSetSave` 事件绑定
- `closeSheets()` 不再包含 `qnSetSheet`

**影响**：
- 分类管理：已在v1.2实现智能分类系统，输入时自动匹配/新建，无需预先设定
- 默认角色：不再需要，每次点击"问角色"时从角色卡列表中选择即可

### 2. 时间线分组依据可切换
**新增功能**：时间线视图顶部添加两个切换按钮
- **按更新时间**（默认）：根据笔记的最后修改时间分组
- **按创建时间**：根据笔记的首次创建时间分组

**使用场景**：
- **按更新时间**：查看最近活跃的思考，适合回顾近期工作进展
- **按创建时间**：查看思考的起源时间线，适合追溯想法的演进脉络

**技术实现**：
```javascript
// Store新增字段
timelineGroupBy: "updated" // "updated" | "created"

// 分组逻辑动态选择时间字段
var timeStr = store.timelineGroupBy === "created" ? n.createdAt : n.updatedAt;

// 排序逻辑同步
var timeField = store.timelineGroupBy === "created" ? "createdAt" : "updatedAt";
var notes = store.notes.slice().sort(function(a, b) {
  return String(b[timeField]).localeCompare(String(a[timeField]));
});

// 日期标签显示同步
var dateLabel = formatDateLabel(store.timelineGroupBy === "created" ? n.createdAt : n.updatedAt);
```

**UI设计**：
- 切换按钮位于时间线视图顶部，使用标准按钮样式
- 当前激活的按钮显示为 `primary` 样式（蓝色高亮）
- 点击即时刷新时间线，无需重新加载数据

## 代码优化

### 精简冗余代码
- 移除约50行设置相关代码（函数定义、事件绑定、HTML结构）
- index.html文件大小从113.8 KB降至110.7 KB（减少3.1 KB）

### 事件委托优化
- 时间线切换按钮使用事件委托模式，避免重复绑定
- 在 `qnList` 上统一监听点击事件，通过 `target.id` 区分按钮

## 测试清单

- [ ] 顶部工具栏不再显示"设置"按钮
- [ ] 时间线视图顶部显示"按更新时间"和"按创建时间"两个按钮
- [ ] 默认选中"按更新时间"按钮（蓝色高亮）
- [ ] 点击"按创建时间"后按钮高亮切换，时间线重新分组
- [ ] 按创建时间分组时，笔记按首次创建时间归类到正确时间段
- [ ] 按更新时间分组时，笔记按最后修改时间归类到正确时间段
- [ ] 切换分组方式后，卡片上的日期标签同步更新
- [ ] 切换回"想法"Tab再返回"时间线"Tab，分组方式保持
- [ ] 刷新页面后分组方式重置为默认的"按更新时间"

## 已知限制

- 分组方式不持久化存储，刷新页面后恢复默认值（可按需改进）
- 暂不支持自定义时间段（如"上周"、"上月"等），后续版本可扩展
