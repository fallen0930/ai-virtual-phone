# v1.10.2 修复 - 日期跳转 + 日期标记

## 问题修复

### 1. 日期选择器跳转无反应

**问题**：点击日期选择器选择日期后，没有任何反应，笔记没有跳转

**原因分析**：
- body的`change`事件委托在沙盒环境中可能不触发
- `change`事件对`<input type="date">`的触发时机因浏览器而异
- 部分移动浏览器的原生date picker在确认选择后才触发change，但事件可能不冒泡

**解决方案**：
将事件绑定改为**在renderTimeline()函数内直接绑定到元素**，确保元素已存在后再绑定：

```javascript
// ✅ 新代码：在渲染完成后立即绑定
box.innerHTML = html;

var datePick = $("qnTimelineDatePick");
if (datePick) {
  datePick.onchange = function() {
    var dateStr = this.value;
    if (!dateStr) return;
    
    try {
      jumpToDate(dateStr); // 调用独立的跳转函数
    } catch(err) {
      console.error("日期跳转失败:", err);
      toast("跳转失败");
    }
    
    this.value = ""; // 重置选择器
  };
}
```

**关键改进**：
- 使用`onchange`属性而非`addEventListener`，更兼容旧浏览器
- 在元素渲染后立即绑定，确保元素存在
- 每次渲染时先清除旧监听器（`datePick.onchange = null`），防止重复绑定
- 提取`jumpToDate()`为独立函数，便于复用和测试

### 2. 缺少有笔记日期的视觉提示

**问题**：用户不知道哪些天写过笔记，时间线看起来都一样

**解决方案**：
在每个笔记卡片的日期标签前添加**蓝色圆点标记**：

```html
<div class="qn-timeline-date">
  <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--accent); margin-right:5px; vertical-align:middle;"></span>
  10月16日
</div>
```

**视觉效果**：
```
● 10月16日          ← 蓝色圆点表示该日期有笔记
  都是测试一下
  
● 10月16日
  笔记实现方案
  
● 10月15日
  昨天的想法
```

**设计原则**：
- 使用主题色（`var(--accent)`）保持一致性
- 6px小圆点，不喧宾夺主
- `vertical-align:middle`确保与文字对齐
- 每个笔记卡片都有圆点，形成连续的视觉线索

**为什么这样设计**：
- 时间线视图本身就是按日期分组的，所有显示的卡片都代表"有笔记的日期"
- 圆点的作用是**强化"这是有内容的日期"这一认知**
- 配合左侧的时间轴线和小节点，形成完整的视觉引导系统

## 技术细节

### jumpToDate() 独立函数

将日期跳转逻辑提取为独立函数，提高可维护性：

```javascript
function jumpToDate(dateStr) {
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
}
```

**优势**：
- 可在多处调用（未来可扩展快捷日期按钮）
- 逻辑集中，修改一处即可
- 便于单元测试

## 用户体验改进

### 使用流程优化

**场景：回顾上周三的想法**

旧版（v1.10.1）：
1. 打开时间线视图
2. 手动滚动查找"本周"时间段
3. 展开"本周"
4. 逐条查看找到上周三的笔记 ❌ 繁琐

新版（v1.10.2）：
1. 打开时间线视图
2. 看到每个日期前的蓝色圆点 ●
3. 点击日期选择器，选择上周三
4. 自动展开"本周"并高亮跳转 ✅ 高效

### 视觉层次强化

```
时间线视图的视觉引导系统：
─ 左侧时间轴线（渐变线条）         → 整体时间流向
├─ 时间节点圆点（8px，带外发光）     → 时间段分组边界
├─ 卡片日期圆点（6px，纯色）        → 具体日期标记 ← 新增
└─ 卡片内容                         → 笔记详情
```

三层视觉线索帮助用户快速理解时间结构。

## 版本迭代记录

| 版本 | 状态 | 关键变更 |
|------|------|----------|
| v1.10 | ❌ 废弃 | 日期选择器事件绑定错误，导致卡死 |
| v1.10.1 | ❌ 废弃 | 修复卡死但日期跳转仍无效 |
| v1.10.2 | ✅ 推荐 | 修复日期跳转 + 添加日期圆点标记 |

## 测试清单

- [ ] 在时间线视图点击日期选择器能正常弹出日期面板
- [ ] 选择今天日期后，"今天"时间段展开并高亮
- [ ] 选择昨天日期后，"昨天"时间段展开并高亮
- [ ] 选择3天前日期后，"本周"时间段展开并高亮
- [ ] 选择10天前日期后，"本月"时间段展开并高亮
- [ ] 选择上月日期后，"更早"时间段展开并高亮
- [ ] 跳转后有淡蓝色背景高亮1.5秒
- [ ] 平滑滚动动画正常
- [ ] Toast提示显示正确日期
- [ ] 日期选择器在选择后自动重置为空
- [ ] 每个笔记卡片的日期前有蓝色圆点
- [ ] 圆点大小适中（6px），不影响阅读
- [ ] 圆点颜色与主题色一致
- [ ] 切换分组方式（更新时间/创建时间）后圆点仍然显示
- [ ] 刷新页面后功能正常

## 后续优化方向

1. **日期热力图** - 在时间线顶部显示日历热力图，颜色深浅表示笔记数量
2. **快捷日期按钮** - "今天"、"昨天"、"本周一"等一键跳转
3. **日期筛选范围** - 选择起止日期，只显示该范围内的笔记
4. **笔记数量徽章** - 在日期标签旁显示该日期的笔记数量（如"10月16日 (3)"）
5. **空日期折叠** - 自动折叠没有笔记的日期段（当前已实现时间段级别折叠）
