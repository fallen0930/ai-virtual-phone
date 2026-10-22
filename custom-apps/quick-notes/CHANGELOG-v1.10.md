# v1.10 更新说明 - 日期选择器 + UI修复

## 问题修复

### 1. "全部展开"按钮显示异常
**问题**：按钮文字被截断为"全部展"，且位置布局不合理

**原因**：
- 使用了`ghost`样式但按钮宽度计算有误
- 文字"全部展开/全部收起"过长，在小屏幕上容易溢出

**解决方案**：
- 改用标准按钮样式（带边框），视觉更清晰
- 缩短文字为"展开/收起"（4字），节省空间
- 减小padding和字体大小（11.5px），适配移动端
- 调整按钮顺序：分组切换 → 展开/收起 → 日期选择器

**新布局**：
```
[按更新] [按创建]              [展开/收起] [📅日期选择器]
```

### 2. 时间段高亮动画
**新增**：跳转到指定日期后，目标时间段会有淡蓝色背景高亮1.5秒，帮助用户快速定位

**CSS实现**：
```css
.qn-timeline-section {
  transition: background .3s; /* 平滑过渡 */
}
```

**JS逻辑**：
```javascript
section.style.background = "rgba(91,107,232,0.05)"; // 淡蓝色
setTimeout(function() { section.style.background = ""; }, 1500); // 1.5秒后恢复
```

## 新增功能

### 日期选择器跳转

**核心功能**：在时间线视图顶部添加原生`<input type="date">`日期选择器，用户可以选择任意日期，系统自动：
1. 计算该日期属于哪个时间段（今天/昨天/本周/本月/更早）
2. 自动展开对应的时间段
3. 平滑滚动到目标位置
4. 高亮提示1.5秒

**使用场景**：

#### 场景1：回顾特定日期的笔记
- 记得上周三写了一个重要想法，但不记得具体内容
- 点击日期选择器，选择上周三的日期
- 自动跳转到"本周"时间段并高亮
- 快速找到那天的笔记

#### 场景2：月度复盘
- 想查看上个月某天的所有记录
- 选择对应日期
- 自动跳转到"更早"时间段（如果超过本月）
- 结合搜索功能精确定位

#### 场景3：项目里程碑回顾
- 某个项目启动于3月15日，想回顾当天的想法
- 选择2026-03-15
- 自动跳转到"更早"并高亮
- 追溯项目的起源思考

**技术实现**：

```javascript
$("qnTimelineDatePick").addEventListener("change", function() {
  var dateStr = this.value; // YYYY-MM-DD
  if (!dateStr) return;
  
  var selectedDate = new Date(dateStr + "T00:00:00");
  var now = new Date();
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var selectedTime = selectedDate.getTime();
  var diffDays = Math.floor((todayStart - selectedTime) / 86400000);
  
  // 确定目标时间段
  var targetKey = "";
  if (diffDays === 0) targetKey = "today";
  else if (diffDays === 1) targetKey = "yesterday";
  else if (diffDays >= 2 && diffDays <= 7) targetKey = "thisWeek";
  else if (diffDays > 7 && selectedDate.getMonth() === now.getMonth()) targetKey = "thisMonth";
  else targetKey = "earlier";
  
  // 展开目标时间段
  var items = $("qnTimelineItems_" + targetKey);
  var arrow = $("qnTimelineArrow_" + targetKey);
  if (items && arrow) {
    items.style.display = "";
    arrow.style.transform = "rotate(90deg)";
  }
  
  // 滚动到高亮
  setTimeout(function() {
    var section = $("qnTimelineSection_" + targetKey);
    if (section) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      section.style.background = "rgba(91,107,232,0.05)";
      setTimeout(function() { section.style.background = ""; }, 1500);
    }
  }, 100);
  
  toast("已跳转到 " + dateStr);
  this.value = ""; // 重置选择器
});
```

**日期范围计算逻辑**：

| 条件 | 目标时间段 | 示例 |
|------|-----------|------|
| `diffDays === 0` | 今天 | 2026-10-16 |
| `diffDays === 1` | 昨天 | 2026-10-15 |
| `2 ≤ diffDays ≤ 7` | 本周 | 2026-10-09 ~ 2026-10-14 |
| `diffDays > 7` 且同月 | 本月 | 2026-10-01 ~ 2026-10-08 |
| 其他 | 更早 | 2026-09及之前 |

**UI设计**：

```
┌─────────────────────────────────────────────┐
│ [按更新] [按创建]        [展开/收起] [____] │
│                                              │
│ ▼ 📅 今天 (3)                               │
│   ● 10月16日                                 │
│     都是测试一下                              │
│                                              │
│ ▶ ⏮️ 昨天 (5)                                │
│                                              │
│ ▶ 📆 本周 (12)                               │
│   ← 选择2026-10-12后自动展开并高亮            │
│                                              │
│ ▶ 🗓️ 本月 (28)                               │
│                                              │
│ ▶ ️ 更早 (47)                                │
└─────────────────────────────────────────────┘
```

**交互细节**：
- 日期选择器使用原生控件，适配各平台（iOS/Android/Desktop）
- 选择后立即跳转，无需额外确认
- 跳转后自动重置选择器为空，避免误操作
- Toast提示"已跳转到 YYYY-MM-DD"，给用户明确反馈
- 平滑滚动（`behavior: "smooth"`）而非瞬间跳转，体验更自然

## 对比旧版

| 功能 | 旧版 (v1.9) | 新版 (v1.10) |
|------|-------------|--------------|
| 展开/收起按钮 |  文字溢出/截断 | ✅ 正常显示 |
| 日期快速跳转 | ❌ 无 | ✅ 日期选择器 |
| 跳转后高亮提示 | ❌ 无 | ✅ 淡蓝色背景1.5秒 |
| 平滑滚动 | ❌ 无 | ✅ scrollIntoView |
| 按钮布局 | ❌ 不合理 | ✅ 紧凑适配移动端 |

## 后续优化方向

1. **日期范围选择** - 支持选择起止日期，查看某段时间内的所有笔记
2. **日历视图** - 以月历形式展示，有笔记的日期标记圆点
3. **快捷日期按钮** - "上周一"、"上月1号"等常用日期一键跳转
4. **搜索联动** - 选择日期后自动填充搜索框，组合筛选
5. **导出指定日期范围** - 导出某段时间的笔记为Markdown/PDF

## 测试清单

- [ ] "展开/收起"按钮文字完整显示，不被截断
- [ ] 点击"展开/收起"能正确切换所有时间段的折叠状态
- [ ] 日期选择器可以正常选择日期
- [ ] 选择今天的日期后，"今天"时间段展开并高亮
- [ ] 选择昨天的日期后，"昨天"时间段展开并高亮
- [ ] 选择3天前的日期后，"本周"时间段展开并高亮
- [ ] 选择10天前的日期后，"本月"时间段展开并高亮
- [ ] 选择上个月的日期后，"更早"时间段展开并高亮
- [ ] 高亮效果持续1.5秒后自动消失
- [ ] 滚动动画平滑，不突兀
- [ ] Toast提示显示正确的日期
- [ ] 选择器在跳转后自动重置为空
- [ ] 日期选择器在不同平台（iOS/Android/Desktop）显示正常
- [ ] 时间段切换（更新时间/创建时间）不影响日期选择器功能
