# v1.8 更新说明 - 时间线折叠优化

## 问题背景

当笔记跨越很多天时，时间线会变得很长难以浏览。例如：
- 有30天的笔记记录，全部展开后需要滚动很久
- 用户只想看今天的想法，却要滑过大量历史内容
- 无法快速定位到特定时间段

## 解决方案：时间段折叠/展开

### 核心功能

**默认折叠策略**：
- **今天** - 默认展开（最常查看的内容）
- **昨天** - 默认展开（近期回顾）
- **本周** - 默认折叠（需要时展开）
- **本月** - 默认折叠（偶尔查阅）
- **更早** - 默认折叠（历史归档）

**交互方式**：
1. **点击时间段标题** - 切换该时间段的展开/折叠状态
2. **"全部展开/全部收起"按钮** - 一键控制所有时间段
3. **箭头图标旋转动画** - ▶ 表示折叠，▼ 表示展开（旋转90度）

### UI设计

```
┌─────────────────────────────────────┐
│ [按更新时间] [按创建时间]    [全部展开] │
├─────────────────────────────────────┤
│ ▼  今天 (3)                        │  ← 默认展开
│   ● 10月16日                         │
│     都是测试一下                      │
│   ● 10月16日                         │
│     笔记实现方案                      │
├─────────────────────────────────────┤
│ ▶ ⏮️ 昨天 (5)                        │  ← 默认折叠
├─────────────────────────────────────
│ ▶ 📆 本周 (12)                       │  ← 默认折叠
├─────────────────────────────────────┤
│ ▶ 🗓️ 本月 (28)                       │  ← 默认折叠
├─────────────────────────────────────┤
│ ▶ ️ 更早 (47)                       │  ← 默认折叠
└─────────────────────────────────────┘
```

### 技术实现

**数据结构扩展**：
```javascript
var timeSections = [
  { key: "today", label: "今天", icon: "📅", defaultOpen: true },
  { key: "yesterday", label: "昨天", icon: "️", defaultOpen: true },
  { key: "thisWeek", label: "本周", icon: "📆", defaultOpen: false },
  { key: "thisMonth", label: "本月", icon: "🗓️", defaultOpen: false },
  { key: "earlier", label: "更早", icon: "🕰️", defaultOpen: false }
];
```

**HTML结构**：
```html
<div class="qn-timeline-section" id="qnTimelineSection_today">
  <div class="qn-timeline-header" data-toggle-section="today" style="cursor:pointer;">
    <span id="qnTimelineArrow_today" style="transform:rotate(90deg);">▶</span>
    📅 今天 (3)
  </div>
  <div class="qn-timeline-items" id="qnTimelineItems_today">
    <!-- 笔记卡片 -->
  </div>
</div>
```

**事件处理逻辑**：
```javascript
// 单个时间段折叠/展开
if (target.hasAttribute("data-toggle-section")) {
  var key = target.getAttribute("data-toggle-section");
  var items = $("qnTimelineItems_" + key);
  var arrow = $("qnTimelineArrow_" + key);
  
  if (items.style.display === "none") {
    items.style.display = "";
    arrow.style.transform = "rotate(90deg)";
  } else {
    items.style.display = "none";
    arrow.style.transform = "rotate(0deg)";
  }
}

// 全部展开/收起
else if (target.id === "qnTimelineToggleAll") {
  // 检测当前是否全部展开
  var allOpen = true;
  sections.forEach(function(sec) {
    var key = sec.getAttribute("data-toggle-section");
    var items = $("qnTimelineItems_" + key);
    if (items && items.style.display === "none") allOpen = false;
  });
  
  // 切换所有时间段
  timeKeys.forEach(function(key) {
    var items = $("qnTimelineItems_" + key);
    var arrow = $("qnTimelineArrow_" + key);
    if (!items || !arrow) return;
    
    if (allOpen) {
      items.style.display = "none";
      arrow.style.transform = "rotate(0deg)";
    } else {
      items.style.display = "";
      arrow.style.transform = "rotate(90deg)";
    }
  });
  
  target.textContent = allOpen ? "全部展开" : "全部收起";
}
```

### CSS样式优化

```css
.qn-timeline-header {
  cursor: pointer;
  user-select: none; /* 防止双击选中文本 */
}
.qn-timeline-header:hover {
  opacity: .85; /* hover反馈 */
}
.qn-timeline-items {
  overflow: hidden; /* 折叠时隐藏溢出内容 */
}
```

## 使用场景

### 场景1：日常记录查看
- 打开时间线视图，自动显示今天和昨天的笔记
- 无需滚动即可看到最近的想法
- 如需查看更早的记录，点击对应时间段展开

### 场景2：周回顾
- 点击"全部展开"查看所有时间段
- 或直接点击"本周"查看本周的所有笔记
- 快速了解一周的思考脉络

### 场景3：月度总结
- 展开"本月"查看所有本月笔记
- 配合"按创建时间"分组，追溯想法的起源
- 导出或整理为月度报告

### 场景4：历史检索
- 展开"更早"查找历史记录
- 结合搜索功能精确定位
- 避免在长列表中反复滚动

## 性能优势

**减少DOM渲染压力**：
- 折叠状态下不渲染笔记卡片（display:none）
- 对于有大量历史笔记的用户，初始加载更快
- 浏览器内存占用更低

**提升用户体验**：
- 减少不必要的滚动操作
- 聚焦于当前最相关的内容
- 按需加载历史信息

## 后续优化方向

1. **记住用户的折叠偏好** - 将展开/折叠状态保存到localStorage
2. **时间段内再分组** - "更早"可以按月份/年份进一步细分
3. **快速跳转** - 添加日期选择器，直接跳转到指定日期
4. **虚拟滚动** - 对于超大量笔记（>1000条），使用虚拟列表技术
5. **搜索联动** - 搜索时自动展开包含匹配结果的时间段

## 测试清单

- [ ] 默认只展开"今天"和"昨天"两个时间段
- [ ] 点击时间段标题能正确折叠/展开
- [ ] 箭头图标随折叠状态旋转（0deg ↔ 90deg）
- [ ] "全部展开"按钮能将所有时间段展开
- [ ] "全部收起"按钮能将所有时间段折叠
- [ ] 按钮文字在"全部展开"和"全部收起"之间切换
- [ ] 折叠状态下点击笔记卡片区域不会误触发展开
- [ ] 切换分组方式（更新时间/创建时间）后保持折叠状态
- [ ] 新建笔记后时间线刷新，今天时间段自动展开
- [ ] hover时间段标题时有视觉反馈（透明度变化）
- [ ] 时间段标题不可被选中（user-select:none）
