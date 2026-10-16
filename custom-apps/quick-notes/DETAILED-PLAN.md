# 随想笔记 v2.0-v4.0 详细技术方案

> **核心设计理念**：将「世界观角色卡」深度融入笔记的全生命周期——从记录、整理、分析到回顾，让角色成为用户的思考伙伴和成长导师。

---

## Phase 1: 基础增强（v1.2 - v1.4）

### 1. 语音输入（v1.2）

#### 功能设计
- **快速记录模式**：点击编辑面板的「🎤 语音输入」按钮，开始录音
- **实时转写**：调用 `ai.speechToText` API，将语音转为文字并追加到正文
- **支持连续录音**：可多次录音，每次追加到末尾或插入光标位置
- **自动标点**：AI 模型自动为口语化内容添加标点符号

#### 技术实现
```javascript
// 新增权限检查
var canSpeech = !!(AI && AI.ai && AI.ai.speechToText);

// 语音输入函数
function startVoiceInput() {
  if (!canSpeech) {
    showNotice("暂不支持", "当前环境没有语音转文字权限（缺少 ai.speechToText）。");
    return;
  }
  
  setEditorBusy(true, "正在聆听…");
  AI.ai.speechToText({
    language: "zh-CN",
    continuous: true // 连续录音模式
  }).then(function(result) {
    var text = result.text || "";
    if (text) {
      // 在光标位置插入或追加到末尾
      var textarea = $("qnFText");
      var startPos = textarea.selectionStart;
      var endPos = textarea.selectionEnd;
      var before = textarea.value.substring(0, startPos);
      var after = textarea.value.substring(endPos);
      textarea.value = before + text + after;
      textarea.selectionStart = textarea.selectionEnd = startPos + text.length;
      toast("语音已转写");
    }
  }).catch(function(err) {
    showNotice("语音识别失败", String(err && err.message ? err.message : err));
  }).then(function() {
    setEditorBusy(false);
  });
}
```

#### UI 设计
```
[内容]
┌─────────────────────────────────────┐
│ 随手把想法写下来……                   │
│                                     │
│ [🎤 语音输入]  [粘贴]                │
└─────────────────────────────────────┘
```

#### 与角色卡的结合点
- **语音日记模式**：用户可以用语音向角色"倾诉"一天的想法
- **角色引导录音**：角色可以提出问题，用户用语音回答（需扩展宿主支持多轮对话）

---

### 2. 快捷模板（v1.3）

#### 功能设计
预设 5 种常用模板，新建笔记时可选择：

| 模板类型 | 适用场景 | 结构示例 |
|---------|---------|---------|
| 🐛 Bug 记录 | 遇到问题时 | 现象 / 复现步骤 / 期望结果 / 可能原因 |
| 💡 灵感想法 | 突发奇想 | 背景 / 核心点 / 可能价值 / 下一步 |
| ✅ 待办事项 | 任务管理 | 任务描述 / 截止时间 / 优先级 / 关联项目 |
| 🤔 反思总结 | 每日/每周复盘 | 事件 / 感受 / 收获 / 改进计划 |
| 📚 学习笔记 | 学习新知识 | 主题 / 关键概念 / 疑问 / 行动计划 |

#### 技术实现
```javascript
var TEMPLATES = {
  bug: {
    title: "Bug: ",
    text: "【现象】\n\n【复现步骤】\n1. \n2. \n\n【期望结果】\n\n【可能原因】\n",
    category: "技术问题",
    tags: ["bug", "待排查"]
  },
  idea: {
    title: "💡 ",
    text: "【背景】\n\n【核心想法】\n\n【可能价值】\n\n【下一步行动】\n",
    category: "",
    tags: ["灵感"]
  },
  todo: {
    title: "✅ ",
    text: "【任务描述】\n\n【截止时间】\n\n【优先级】高/中/低\n\n【关联项目】\n",
    category: "待办",
    tags: ["todo"]
  },
  reflection: {
    title: "🤔 ",
    text: "【事件】\n\n【我的感受】\n\n【学到了什么】\n\n【下次可以改进的】\n",
    category: "反思",
    tags: ["复盘"]
  },
  learning: {
    title: "📚 ",
    text: "【学习主题】\n\n【关键概念】\n- \n\n【我的疑问】\n\n【行动计划】\n",
    category: "学习",
    tags: ["笔记"]
  }
};

function applyTemplate(type) {
  var tmpl = TEMPLATES[type];
  if (!tmpl) return;
  
  store.editing.title = tmpl.title;
  store.editing.text = tmpl.text;
  store.editing.category = tmpl.category;
  store.editing.tags = tmpl.tags.slice();
  
  $("qnFTitle").value = tmpl.title;
  $("qnFText").value = tmpl.text;
  $("qnFCat").value = tmpl.category;
  $("qnFTags").value = tmpl.tags.join(", ");
  
  toast("已应用模板：" + type);
}
```

#### UI 设计
新建笔记时弹出选择器：
```
┌──────────────────────────┐
│  选择笔记模板             │
├──────────────────────────┤
│  🐛 Bug 记录             │
│  💡 灵感想法             │
│  ✅ 待办事项             │
│  🤔 反思总结             │
│  📚 学习笔记             │
│  （空白笔记）             │
└──────────────────────────┘
```

#### 与角色卡的结合点 ⭐
- **角色推荐模板**：根据角色的专业领域推荐模板
  - 例如：技术型角色 → 优先显示 Bug 记录模板
  - 创意型角色 → 优先显示灵感想法模板
- **模板自定义**：用户可以保存自己常用的模板结构，不同角色可以有不同偏好

---

### 3. 双向链接（v2.0）

#### 功能设计
- **语法**：在正文中使用 `[[笔记ID]]` 或 `[[笔记标题]]` 引用其他笔记
- **自动补全**：输入 `[[` 时弹出笔记列表供选择
- **反向索引**：查看某条笔记时，显示"被哪些笔记引用"
- **图谱视图**：可视化展示笔记之间的关联网络

#### 技术实现

##### 数据结构扩展
```javascript
// notes 集合新增字段
{
  id: "note_xxx",
  // ... 现有字段
  references: ["note_yyy", "note_zzz"], // 这条笔记引用的其他笔记 ID
  backlinks: ["note_aaa", "note_bbb"]   // 引用这条笔记的 ID（计算得出，不存储）
}
```

##### 解析链接
```javascript
function parseReferences(text) {
  var refs = [];
  var regex = /\[\[(.+?)\]\]/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    var target = match[1].trim();
    // 尝试匹配 ID 或标题
    var note = store.notes.filter(function(n) {
      return n.id === target || n.title === target;
    })[0];
    if (note) {
      refs.push(note.id);
    }
  }
  return refs;
}

// 保存时更新 references
function saveEditor() {
  var e = collectEditor();
  e.references = parseReferences(e.text);
  // ... 其余保存逻辑
}
```

##### 渲染链接
```javascript
function renderNoteWithLinks(text) {
  return text.replace(/\[\[(.+?)\]\]/g, function(match, target) {
    var note = store.notes.filter(function(n) {
      return n.id === target || n.title === target;
    })[0];
    if (note) {
      return '<a href="#" data-link-note="' + escapeHtml(note.id) + '">' + 
             escapeHtml(note.title || target) + '</a>';
    }
    return match; // 未找到目标，保留原文
  });
}
```

##### 计算反向链接
```javascript
function computeBacklinks(noteId) {
  return store.notes.filter(function(n) {
    return n.references && n.references.indexOf(noteId) >= 0;
  });
}
```

#### UI 设计

**编辑时自动补全**：
```
【背景】最近在想 [[
         ┌──────────────┐
         │ 💡 新的交互方案│
         │ 🐛 登录 Bug   │
         │ 📚 React 笔记 │
         └──────────────┘
```

**详情页显示反向链接**：
```
┌─────────────────────────────┐
│ 💡 新的交互方案              │
│                             │
│ 正文内容...                  │
│                             │
│ ─── 引用了以下笔记 ───       │
│ • 🐛 登录 Bug               │
│ • ✅ 优化性能任务            │
└─────────────────────────────┘

┌─────────────────────────────┐
│ 被以下笔记引用               │
│ • 📚 竞品分析               │
│ • 🤔 Q3 反思                │
└─────────────────────────────┘
```

#### 与角色卡的结合点 ⭐⭐⭐
- **角色发现关联**：当用户问角色某条笔记时，角色可以主动提及相关的其他笔记
  ```
  用户：你怎么看这个交互方案？
  角色：这个想法和你上周记录的「登录 Bug」有关联，
        当时你提到用户体验的问题，这里是不是可以考虑...
  ```
- **知识网络导读**：角色可以基于双向链接图谱，为用户规划学习路径
  ```
  角色：我注意到你已经记录了 5 篇关于「状态管理」的笔记，
        但它们之间还没有建立联系。要不要我帮你梳理一下脉络？
  ```

---

## Phase 2: 知识管理（v2.1 - v2.3）

### 4. 时间线视图（v2.1）

#### 功能设计
- **时间轴展示**：按时间顺序展示所有笔记，支持缩放（日/周/月/年）
- **聚类显示**：同一天的笔记聚合显示，点击展开
- **筛选能力**：按分类/标签/关键词过滤时间线
- **里程碑标记**：用户可手动标记重要日期（如"项目启动"）

#### 技术实现

##### 数据准备
```javascript
function buildTimelineData() {
  var notes = store.notes.slice().sort(function(a, b) {
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
  
  // 按日期分组
  var groups = {};
  notes.forEach(function(note) {
    var date = note.createdAt.split('T')[0]; // YYYY-MM-DD
    if (!groups[date]) groups[date] = [];
    groups[date].push(note);
  });
  
  return Object.keys(groups).sort().map(function(date) {
    return {
      date: date,
      count: groups[date].length,
      notes: groups[date]
    };
  });
}
```

##### 渲染时间线
```javascript
function renderTimeline() {
  var data = buildTimelineData();
  var html = data.map(function(day) {
    return '<div class="qn-timeline-day">' +
      '<div class="qn-timeline-date">' + formatDate(day.date) + 
      ' <span class="qn-timeline-count">' + day.count + '</span></div>' +
      '<div class="qn-timeline-notes">' +
      day.notes.map(function(note) {
        return '<div class="qn-timeline-note" data-id="' + note.id + '">' +
          '<span class="qn-timeline-icon">' + getCategoryIcon(note.category) + '</span>' +
          '<span class="qn-timeline-title">' + escapeHtml(titleOf(note)) + '</span>' +
          '</div>';
      }).join('') +
      '</div></div>';
  }).join('');
  
  $("qnTimelineBody").innerHTML = html;
}
```

#### UI 设计
```
┌─────────────────────────────────┐
│ 时间线视图                       │
│ [日] [周] [月] [年]  🔍 搜索    │
├─────────────────────────────────┤
│                                 │
│ 2026-10-16  (3)                 │
│ ├─ 💡 新的交互方案               │
│ ├─ 🐛 登录超时 Bug              │
│ └─ ✅ 优化首屏加载               │
│                                 │
│ 2026-10-15  (1)                 │
│ └─ 📚 React 性能优化笔记        │
│                                 │
│ 2026-10-14  (5)                 │
│ ├─ 🤔 本周反思                  │
│ ├─ 💡 缓存策略想法              │
│ └─ ...                          │
└─────────────────────────────────┘
```

#### 与角色卡的结合点 ⭐⭐
- **时间跨度分析**：角色可以分析用户在某个时间段的思想变化
  ```
  角色：过去两周你记录了 8 次关于「性能优化」的想法，
        从最初的困惑到现在的系统化方案，进步很明显。
  ```
- **里程碑回顾**：在重要日期（如项目上线）时，角色主动生成回顾

---

### 5. 导出功能（v2.2）

#### 功能设计
- **单条导出**：导出为 Markdown 文件
- **批量导出**：按分类/标签导出整个文件夹
- **全库导出**：导出为 JSON（备份用）或 ZIP（含附件）
- **PDF 导出**：使用 jsPDF 生成精美排版的 PDF

#### 技术实现

##### Markdown 导出
```javascript
function exportNoteAsMarkdown(note) {
  var md = "# " + (note.title || "未命名") + "\n\n";
  md += "- **分类**：" + (note.category || "未分类") + "\n";
  md += "- **标签**：" + (note.tags || []).map(function(t) { return "#" + t; }).join(" ") + "\n";
  md += "- **创建时间**：" + fmtTime(note.createdAt) + "\n";
  md += "- **最后更新**：" + fmtTime(note.updatedAt) + "\n\n";
  
  if (note.aiSummary) {
    md += "## AI 摘要\n\n" + note.aiSummary + "\n\n";
  }
  
  md += "## 正文\n\n" + (note.text || "") + "\n\n";
  
  if (note.attachments && note.attachments.length) {
    md += "## 附件\n\n";
    note.attachments.forEach(function(att) {
      md += "- 📎 " + att.name + " (" + formatFileSize(att.size) + ")\n";
    });
  }
  
  if (note.references && note.references.length) {
    md += "\n## 相关笔记\n\n";
    note.references.forEach(function(refId) {
      var refNote = store.notes.filter(function(n) { return n.id === refId; })[0];
      if (refNote) {
        md += "- [[" + refNote.title + "]]\n";
      }
    });
  }
  
  downloadFile(md, (note.title || "note") + ".md", "text/markdown");
}

function downloadFile(content, filename, mimeType) {
  var blob = new Blob([content], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

##### 全库 JSON 导出
```javascript
function exportAllNotesAsJSON() {
  var data = {
    version: "1.0",
    exportedAt: nowIso(),
    notes: store.notes,
    analyses: store.anas,
    meta: {
      categories: store.cats,
      defaultCharacterId: store.defaultCharId
    }
  };
  
  var json = JSON.stringify(data, null, 2);
  downloadFile(json, "quick-notes-backup-" + Date.now() + ".json", "application/json");
}
```

##### PDF 导出（需引入 jsPDF）
```javascript
// 需要在 index.html 头部引入
// <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>

function exportNoteAsPDF(note) {
  var doc = new jspdf.jsPDF();
  
  // 标题
  doc.setFontSize(20);
  doc.text(note.title || "未命名", 20, 30);
  
  // 元数据
  doc.setFontSize(10);
  doc.text("分类：" + (note.category || "未分类"), 20, 45);
  doc.text("时间：" + fmtTime(note.createdAt), 20, 52);
  
  // 正文（需要处理换行和分页）
  doc.setFontSize(12);
  var lines = doc.splitTextToSize(note.text || "", 170);
  var y = 65;
  lines.forEach(function(line) {
    if (y > 270) {
      doc.addPage();
      y = 20;
    }
    doc.text(line, 20, y);
    y += 7;
  });
  
  doc.save((note.title || "note") + ".pdf");
}
```

#### UI 设计
在笔记详情页底部添加导出按钮组：
```
┌─────────────────────────────┐
│ [复制] [发到聊天室] [删除]   │
│                             │
│ 导出：                       │
│ [📄 Markdown] [📑 PDF]      │
└─────────────────────────────┘
```

在设置页添加批量导出：
```
┌─────────────────────────────┐
│ 数据管理                     │
│                             │
│ [导出全部为 JSON（备份）]    │
│ [导出全部为 ZIP（含附件）]   │
│ [导入备份]                  │
└─────────────────────────────┘
```

#### 与角色卡的结合点
- **角色协助整理**：让用户选择一个角色，AI 帮忙决定哪些笔记值得导出归档
  ```
  角色：这周你记录了 12 条想法，我建议导出这 5 条最有价值的：
  1. 新的交互方案（已实施）
  2. 性能优化总结
  ...
  要我现在帮你打包吗？
  ```

---

## Phase 3: 自我提升辅助（v3.0 - v3.2）

### 6. 周期性回顾（v3.0）⭐⭐⭐

#### 功能设计
每周/每月自动生成回顾报告，包含：
- 📊 **统计数据**：新增/整理/归档数量，高频标签
- 🔥 **热点话题**：出现最多的关键词/分类
- ⏳ **待处理事项**：收集箱超过 7 天未处理的
- 💬 **AI 点评**：基于本周内容的整体观察和建议
- 🎯 **角色寄语**：指定角色给出一段鼓励/建议

#### 技术实现

##### 触发机制
由于 Custom App 没有后台定时任务，采用以下方案：
1. **用户主动触发**：在首页添加「生成本周回顾」按钮
2. **被动触发**：每次打开应用时检查距离上次回顾是否超过 7 天，如是则提示

```javascript
function checkReviewNeeded() {
  var lastReview = localStorage.getItem('qn_last_review');
  if (!lastReview) return true;
  
  var daysSince = (Date.now() - parseInt(lastReview)) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}

function generateWeeklyReview(characterId) {
  var now = Date.now();
  var weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  
  var weekNotes = store.notes.filter(function(n) {
    return new Date(n.createdAt).getTime() > weekAgo;
  });
  
  if (!weekNotes.length) {
    showNotice("本周无新笔记", "这周还没有记录任何想法，去记一条吧！");
    return;
  }
  
  setBusy(true, "AI 正在生成本周回顾…");
  
  // 统计数据
  var stats = {
    total: weekNotes.length,
    inbox: weekNotes.filter(function(n) { return n.status === 'inbox'; }).length,
    sorted: weekNotes.filter(function(n) { return n.status === 'sorted'; }).length,
    categories: {},
    tags: {}
  };
  
  weekNotes.forEach(function(n) {
    if (n.category) stats.categories[n.category] = (stats.categories[n.category] || 0) + 1;
    (n.tags || []).forEach(function(t) {
      stats.tags[t] = (stats.tags[t] || 0) + 1;
    });
  });
  
  // 找出高频标签
  var topTags = Object.keys(stats.tags)
    .sort(function(a, b) { return stats.tags[b] - stats.tags[a]; })
    .slice(0, 5);
  
  // 找出未处理事项
  var overdue = weekNotes.filter(function(n) {
    return n.status === 'inbox' && 
           (now - new Date(n.createdAt).getTime()) > 7 * 24 * 60 * 60 * 1000;
  });
  
  // 构建 AI 提示词
  var prompt = "你是用户的思考伙伴。请阅读用户本周记录的 " + weekNotes.length + 
    " 条想法，生成一份温暖的回顾报告。\n\n" +
    "统计概览：\n" +
    "- 新增 " + stats.total + " 条，其中 " + stats.inbox + " 条待整理，" + stats.sorted + " 条已整理\n" +
    "- 主要关注领域：" + Object.keys(stats.categories).join("、") + "\n" +
    "- 高频话题：" + topTags.join("、") + "\n\n" +
    "待处理事项（" + overdue.length + " 条超过 7 天未整理）：\n" +
    overdue.map(function(n) { return "- " + titleOf(n); }).join("\n") + "\n\n" +
    "请以第二人称（你）写一段 200-300 字的回顾，包括：\n" +
    "1. 肯定用户本周的思考成果\n" +
    "2. 指出一个值得深入的方向\n" +
    "3. 温和提醒处理待整理事项\n" +
    "4. 给下周一个小建议\n\n" +
    "语气温暖、真诚，像朋友聊天，不要写成报告。";
  
  var char = store.chars.filter(function(c) { return String(c.id) === String(characterId); })[0];
  var characterIdToUse = characterId || store.defaultCharId;
  
  if (characterIdToUse && canGen) {
    aiGenerate(characterIdToUse, prompt, "").then(function(review) {
      // 保存为分析记录
      var ana = {
        id: uid("ana"),
        noteIds: weekNotes.map(function(n) { return n.id; }),
        noteTitles: weekNotes.map(titleOf),
        characterId: characterIdToUse,
        characterName: char ? char.name : "AI",
        mode: "weekly_review",
        title: "第 " + getWeekNumber() + " 周回顾（" + new Date().toLocaleDateString() + "）",
        text: review,
        sentToChat: false,
        createdAt: nowIso()
      };
      
      dbCreate(COLL_ANAS, ana).then(function() {
        localStorage.setItem('qn_last_review', String(now));
        setBusy(false);
        openAna(ana.id);
        toast("本周回顾已生成");
      });
    }).catch(function(err) {
      setBusy(false);
      showNotice("生成失败", String(err && err.message ? err.message : err));
    });
  } else {
    // 退化：使用通用 AI
    aiChat(prompt, "", { temperature: 0.7, maxTokens: 800 }).then(function(review) {
      // 同上保存...
    });
  }
}

function getWeekNumber() {
  var now = new Date();
  var start = new Date(now.getFullYear(), 0, 1);
  var diff = now - start;
  var oneWeek = 1000 * 60 * 60 * 24 * 7;
  return Math.ceil(diff / oneWeek);
}
```

#### UI 设计

**首页提示**：
```
┌─────────────────────────────────┐
│ 📅 距离上次回顾已过 9 天         │
│    [生成本周回顾]                │
└─────────────────────────────────┘
```

**回顾报告样式**：
```
┌─────────────────────────────────┐
│ 第 42 周回顾（2026-10-16）       │
│ 👤 小卷 · 刚刚                   │
├─────────────────────────────────┤
│                                 │
│ 📊 本周概览                      │
│ • 新增 8 条想法                  │
│ • 5 条已整理，3 条待处理         │
│ • 主要关注：交互设计、性能优化    │
│                                 │
│ 💬 AI 点评                       │
│                                 │
│ 这周你的思考很活跃呢！我注意到你  │
│ 花了大量时间在「交互细节」上，特  │
│ 别是那个「动态反馈」的想法很有潜  │
│ 力。不过有 3 条想法还在收集箱里等  │
│ 你整理，要不要趁周末把它们归类一  │
│ 下？                            │
│                                 │
│ 下周建议你试着把零散的想法串成系  │
│ 统化的方案，可以试试用「双向链接」 │
│ 功能建立关联。加油！✨            │
│                                 │
│ ─── 涉及的想法 ───               │
│ • 💡 动态交互动画                │
│ • 🐛 滚动卡顿问题                │
│ • ...                           │
│                                 │
│ [复制] [发到聊天室] [关闭]       │
└─────────────────────────────────┘
```

#### 与角色卡的结合点 ⭐⭐⭐⭐⭐
这是**最核心的结合点**：
- **角色人格化回顾**：不同性格的角色给出不同风格的回顾
  - 严厉型角色：直指问题，推动行动
  - 温柔型角色：多鼓励，少批评
  - 理性型角色：数据分析为主
- **长期记忆**：角色可以对比本周和上周的变化
  ```
  角色：上周你还在纠结「要不要做这个功能」，
        这周已经写出了完整方案，执行力很强！
  ```
- **个性化建议**：基于角色的专业知识给出针对性建议
  ```
  角色（技术专家）：你最近频繁提到「性能问题」，
        我建议系统学习一下 Chrome DevTools 的 
        Performance 面板，可以从这篇文档开始...
  ```

---

### 7. 目标追踪（v3.1）

#### 功能设计
- **目标管理**：创建长期目标（如"掌握 React 性能优化"）
- **笔记关联**：编辑笔记时可关联到一个或多个目标
- **进度评估**：AI 定期评估每个目标的进展
- **仪表盘**：可视化展示所有目标的状态

#### 技术实现

##### 数据结构
新增 `goals` 集合：
```javascript
{
  id: "goal_xxx",
  title: "掌握 React 性能优化",
  description: "能够独立分析和解决复杂性能问题",
  status: "active", // active | completed | paused
  priority: "high", // high | medium | low
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
  completedAt: null,
  relatedNotes: ["note_aaa", "note_bbb"], // 关联的笔记 ID
  milestones: [
    { title: "学习 Profiler", completed: true },
    { title: "实践 Memo/Callback", completed: false }
  ]
}
```

notes 集合新增字段：
```javascript
{
  // ... 现有字段
  goalIds: ["goal_xxx", "goal_yyy"] // 关联的目标 ID
}
```

##### 目标 CRUD
```javascript
function createGoal(data) {
  var goal = {
    id: uid("goal"),
    title: data.title,
    description: data.description || "",
    status: "active",
    priority: data.priority || "medium",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    relatedNotes: [],
    milestones: data.milestones || []
  };
  return dbCreate("goals", goal);
}

function updateGoal(goalId, patch) {
  patch.updatedAt = nowIso();
  return dbUpdate("goals", goalId, patch);
}

function linkNoteToGoal(noteId, goalId) {
  // 更新 note
  var note = store.notes.filter(function(n) { return n.id === noteId; })[0];
  if (!note.goalIds) note.goalIds = [];
  if (note.goalIds.indexOf(goalId) < 0) {
    note.goalIds.push(goalId);
    dbUpdate(COLL_NOTES, noteId, { goalIds: note.goalIds });
  }
  
  // 更新 goal
  var goal = store.goals.filter(function(g) { return g.id === goalId; })[0];
  if (!goal.relatedNotes) goal.relatedNotes = [];
  if (goal.relatedNotes.indexOf(noteId) < 0) {
    goal.relatedNotes.push(noteId);
    dbUpdate("goals", goalId, { relatedNotes: goal.relatedNotes });
  }
}
```

##### AI 进度评估
```javascript
function evaluateGoalProgress(goalId, characterId) {
  var goal = store.goals.filter(function(g) { return g.id === goalId; })[0];
  if (!goal) return;
  
  var relatedNotes = store.notes.filter(function(n) {
    return goal.relatedNotes && goal.relatedNotes.indexOf(n.id) >= 0;
  });
  
  if (!relatedNotes.length) {
    return Promise.resolve("还没有相关笔记，先去记录一些想法吧！");
  }
  
  var prompt = "请评估用户在目标「" + goal.title + "」上的进展。\n\n" +
    "目标描述：" + (goal.description || "") + "\n" +
    "相关笔记（" + relatedNotes.length + " 条）：\n" +
    relatedNotes.map(function(n, i) {
      return (i+1) + ". " + titleOf(n) + "\n   " + (n.text || "").slice(0, 100);
    }).join("\n") + "\n\n" +
    "请给出：\n" +
    "1. 进度百分比（0-100%）\n" +
    "2. 已完成的关键步骤\n" +
    "3. 还缺什么\n" +
    "4. 下一步建议\n\n" +
    "用简洁的语言，分点列出。";
  
  return aiChat(prompt, "", { temperature: 0.3, maxTokens: 600 });
}
```

#### UI 设计

**目标列表页**：
```
┌─────────────────────────────────┐
│ 目标追踪                         │
│ [+ 新建目标]                     │
├─────────────────────────────────┤
│                                 │
│ 🎯 掌握 React 性能优化           │
│    进度：██████░░░░ 60%          │
│    相关笔记：8 条                 │
│    [查看详情] [评估进度]          │
│                                 │
│ 🎯 完成个人作品集                │
│    进度：████░░░░░░ 40%          │
│    相关笔记：5 条                 │
│    [查看详情] [评估进度]          │
│                                 │
│ 🎯 养成每日反思习惯              │
│    进度：█████████░ 90%          │
│    相关笔记：23 条                │
│    [查看详情] [评估进度]          │
└─────────────────────────────────┘
```

**目标详情页**：
```
┌─────────────────────────────────┐
│ 🎯 掌握 React 性能优化           │
│                                 │
│ 描述：能够独立分析和解决复杂性能  │
│      问题                        │
│                                 │
│ 进度：60%                        │
│ ██████████████░░░░░░░░          │
│                                 │
│ 里程碑：                         │
│ ☑️ 学习 Profiler 工具            │
│ ☑️ 理解重渲染机制                │
│ ☐ 实践 useMemo/useCallback      │
│ ☐ 优化大型列表渲染               │
│                                 │
│ 相关笔记（8 条）：               │
│ • 💡 虚拟滚动方案                │
│ • 🐛 内存泄漏排查                │
│ • 📚 React Fiber 原理           │
│ • ...                           │
│                                 │
│ [编辑目标] [标记完成] [删除]     │
└─────────────────────────────────┘
```

**编辑笔记时关联目标**：
```
┌─────────────────────────────────┐
│ 关联目标（可选）                  │
│                                 │
│ ○ 掌握 React 性能优化            │
│ ○ 完成个人作品集                 │
│ ○ 养成每日反思习惯               │
│ (+ 新建目标)                     │
└─────────────────────────────────┘
```

#### 与角色卡的结合点 ⭐⭐⭐⭐
- **角色作为导师**：定期检查用户的各个目标，给出专业建议
  ```
  角色：你的「React 性能优化」目标已经推进到 60% 了，
        但 milestone 3 和 4 还没开始。我建议本周
        重点攻克 useMemo，这里有几个典型案例...
  ```
- **目标分解助手**：用户设定大目标后，角色帮忙拆解为小步骤
  ```
  用户：我想"成为前端专家"
  角色：这个目标很大，我们拆一下：
        1. 深入 JavaScript 核心（预计 2 个月）
        2. 掌握至少一个框架的深度原理（3 个月）
        3. 系统学习工程化（2 个月）
        ...
        先从哪个开始？
  ```
- **进度庆祝**：当用户完成里程碑时，角色给予正向反馈
  ```
  角色：恭喜！你完成了「学习 Profiler」这个里程碑，
        这意味着你已经具备了自主诊断性能问题的能力。
        接下来可以尝试实战了！
  ```

---

### 8. 模式识别（v3.2）⭐⭐⭐⭐⭐

#### 功能设计
AI 定期扫描整个笔记库，发现用户的思维模式和盲点：
- **重复但未深入**：某些话题反复出现，但每次都浅尝辄止
- **想做但未做**：多次提到同一个想法，但没有实际行动
- **领域失衡**：在某些领域投入过多，其他领域几乎空白
- **情绪模式**：通过用词分析用户的情绪状态变化
- **认知偏差**：发现用户思考中的逻辑漏洞或偏见

#### 技术实现

##### 洞察生成引擎
```javascript
function generateInsights(characterId) {
  setBusy(true, "AI 正在分析你的思维模式…");
  
  // 准备数据
  var allNotes = store.notes.slice();
  var categories = {};
  var keywords = {};
  var actionWords = ["做了", "实现了", "完成了", "上线了", "提交了"];
  var wishWords = ["想做", "打算", "计划", "希望", "应该"];
  
  // 统计分类分布
  allNotes.forEach(function(n) {
    if (n.category) {
      categories[n.category] = (categories[n.category] || 0) + 1;
    }
    
    // 提取关键词（简化版：用空格/标点分割）
    var words = (n.text || "").split(/[\s\u3000,，.。!！?？;；]+/);
    words.forEach(function(w) {
      if (w.length >= 2) {
        keywords[w] = (keywords[w] || 0) + 1;
      }
    });
  });
  
  // 找出高频但未行动的 topic
  var topics = {};
  allNotes.forEach(function(n) {
    var hasAction = actionWords.some(function(w) { return (n.text || "").indexOf(w) >= 0; });
    var hasWish = wishWords.some(function(w) { return (n.text || "").indexOf(w) >= 0; });
    
    // 提取主题（用标题或前 20 字）
    var topic = (n.title || n.text || "").slice(0, 20);
    if (!topics[topic]) topics[topic] = { count: 0, actions: 0, wishes: 0 };
    topics[topic].count++;
    if (hasAction) topics[topic].actions++;
    if (hasWish) topics[topic].wishes++;
  });
  
  // 找出"想说但未做"的 topic
  var stuckTopics = Object.keys(topics).filter(function(t) {
    return topics[t].count >= 3 && topics[t].actions === 0 && topics[t].wishes >= 2;
  });
  
  // 构建洞察报告
  var insights = [];
  
  // 洞察 1：重复但未深入
  if (stuckTopics.length) {
    insights.push({
      type: "stuck",
      title: "这些想法你提了很多次，但还没行动",
      content: stuckTopics.slice(0, 3).map(function(t) {
        return "• " + t + "（提到了 " + topics[t].count + " 次）";
      }).join("\n"),
      suggestion: "选一个最心动的，本周就迈出第一步？"
    });
  }
  
  // 洞察 2：领域失衡
  var catValues = Object.values(categories);
  if (catValues.length > 1) {
    var maxCat = Object.keys(categories).reduce(function(a, b) {
      return categories[a] > categories[b] ? a : b;
    });
    var minCat = Object.keys(categories).reduce(function(a, b) {
      return categories[a] < categories[b] ? a : b;
    });
    
    if (categories[maxCat] > categories[minCat] * 5) {
      insights.push({
        type: "imbalance",
        title: "你的注意力分布不太均衡",
        content: "「" + maxCat + "」有 " + categories[maxCat] + " 条笔记，\n" +
                 "而「" + minCat + "」只有 " + categories[minCat] + " 条。",
        suggestion: "是否需要调整一下重心？"
      });
    }
  }
  
  // 洞察 3：高频关键词
  var topKeywords = Object.keys(keywords)
    .sort(function(a, b) { return keywords[b] - keywords[a]; })
    .slice(0, 10);
  
  insights.push({
    type: "keywords",
    title: "你最近最常想到的词",
    content: topKeywords.map(function(k, i) {
      return (i+1) + ". " + k + "（" + keywords[k] + " 次）";
    }).join("\n"),
    suggestion: "这些词反映了你当前的关注焦点。"
  });
  
  // 如果有角色，让角色生成个性化解读
  if (characterId && canGen) {
    var charPrompt = "以下是用户的笔记数据统计，请以角色的视角给出一段 150-200 字的个性化解读：\n\n" +
      insights.map(function(ins) {
        return "【" + ins.title + "】\n" + ins.content;
      }).join("\n\n") + "\n\n" +
      "语气要像朋友聊天，既指出问题又给予鼓励。";
    
    return aiGenerate(characterId, charPrompt, "").then(function(charResponse) {
      return {
        insights: insights,
        charCommentary: charResponse,
        generatedAt: nowIso()
      };
    });
  } else {
    return Promise.resolve({
      insights: insights,
      generatedAt: nowIso()
    });
  }
}
```

#### UI 设计

**洞察卡片**：
```
┌─────────────────────────────────┐
│ 🔍 思维洞察                      │
│ [生成本次分析]                   │
├─────────────────────────────────┤
│                                 │
│ ⚠️ 这些想法你提了很多次          │
│    但还没行动                    │
│                                 │
│ • 重构登录模块（5 次）           │
│ • 学习 TypeScript（4 次）        │
│ • 写技术博客（3 次）             │
│                                 │
│ 💡 建议：选一个最心动的，本周就  │
│    迈出第一步？                  │
│                                 │
│ [标记"已开始"] [忽略]            │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ ⚖️ 注意力分布不均                │
│                                 │
│ 「技术问题」有 28 条笔记         │
│ 「个人成长」只有 3 条            │
│                                 │
│ 💡 是否需要调整一下重心？        │
│                                 │
│ [查看分类详情]                   │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ 🔑 高频关键词                    │
│                                 │
│ 1. 性能（18 次）                 │
│ 2. 用户体验（15 次）             │
│ 3. 组件复用（12 次）             │
│ 4. 测试（10 次）                 │
│ 5. 文档（9 次）                  │
│                                 │
│ 💡 这些词反映了你当前的关注焦点  │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ 👤 小卷的观察                    │
│                                 │
│ 我发现你对「性能优化」特别执着，  │
│ 这很好！但你也提到了很多次「写博 │
│ 客」却一直没动笔。其实把你解决性 │
│ 能问题的过程写下来，就是一篇很棒  │
│ 的技术文章。要不要试试？          │
│                                 │
│ [谢谢建议] [换个角色看看]        │
└─────────────────────────────────┘
```

#### 与角色卡的结合点 ⭐⭐⭐⭐⭐
这是**最具差异化价值**的功能：

1. **角色作为镜子**：帮助用户看到自己看不到的盲点
   ```
   角色：你有没有发现，你总是在「准备阶段」花很多时间，
         但真正动手时反而犹豫？这可能是完美主义在作祟。
   ```

2. **跨时间对比**：角色可以对比用户半年前和现在的思维变化
   ```
   角色：半年前你还在纠结"要不要学 React"，
         现在已经能独立解决性能问题了，
         成长速度超出预期！
   ```

3. **个性化干预**：不同性格的角色给出不同的建议
   - 教练型角色：直接指出问题，推动行动
   - 心理咨询师型角色：探索背后的心理原因
   - 导师型角色：提供具体的学习路径

4. **成长轨迹记录**：角色可以定期总结用户的成长
   ```
   角色：回顾过去 3 个月，你从「对性能优化一知半解」
         到「能独立诊断复杂问题」，完成了 3 个实战项目，
         写了 5 篇技术文章。这个成长曲线很漂亮！
   ```

---

## 综合架构设计

### 数据流图
```
用户输入（文本/语音/附件）
    ↓
笔记存储（IndexedDB）
    ↓
AI 处理（分类/标签/摘要）
    ↓
关联建立（双向链接/目标关联）
    ↓
定期分析（回顾/洞察/进度评估）
    ↓
角色介入（点评/建议/鼓励）
    ↓
用户行动（整理/执行/反思）
    ↓
循环往复
```

### 权限需求扩展
```json
{
  "permissions": [
    "app.data.read",
    "app.data.write",
    "app.manifest.read",
    "ui.toast",
    "ai.classify",
    "ai.chat",
    "ai.generate",
    "ai.speechToText",        // 新增：语音输入
    "characters.read",
    "chat.read",
    "chat.sendMessage",
    "chat.requestReply"
  ]
}
```

### 性能优化要点
1. **虚拟滚动**：笔记超过 500 条时启用虚拟列表
2. **懒加载**：附件按需加载，避免一次性读取所有 base64
3. **增量分析**：只分析新增/修改的笔记，而非全量扫描
4. **缓存策略**：洞察结果缓存 24 小时，避免频繁调用 AI

---

## 开发优先级建议

| 优先级 | 功能 | 理由 | 预计工作量 |
|-------|------|------|----------|
| P0 | 快捷模板 | 高频刚需，立即可用 | 1 天 |
| P0 | 语音输入 | 降低记录门槛 | 1-2 天（依赖宿主支持） |
| P1 | 周期性回顾 | 核心价值点，强角色结合 | 3-4 天 |
| P1 | 双向链接 | 知识网络基础 | 3-4 天 |
| P2 | 目标追踪 | 长期价值，中等复杂度 | 4-5 天 |
| P2 | 时间线视图 | 可视化增强 | 2-3 天 |
| P3 | 模式识别 | 高级功能，需大量调试 | 5-7 天 |
| P3 | 导出功能 | 锦上添花 | 2-3 天 |

**建议开发顺序**：
1. 先做 P0（模板 + 语音），快速提升用户体验
2. 再做 P1（回顾 + 链接），建立核心价值
3. 最后做 P2/P3，完善生态系统

---

## 风险与挑战

1. **宿主 API 限制**：
   - `ai.speechToText` 可能不被所有宿主支持
   - 解决方案：优雅降级，不支持时隐藏按钮

2. **IndexedDB 容量**：
   - 大量附件可能导致存储超限
   - 解决方案：单文件限制 5MB，提供云端同步选项

3. **AI Token 消耗**：
   - 周期性回顾和模式识别会消耗较多 token
   - 解决方案：用户可控的触发机制，非自动执行

4. **数据迁移**：
   - 新增字段后旧数据兼容性问题
   - 解决方案：在 `normalizeNote` 中做向后兼容处理

---

## 总结

这套方案的核心优势在于：
1. **角色深度参与**：不是简单的工具，而是有"思考伙伴"的温度
2. **闭环设计**：从记录 → 整理 → 分析 → 行动 → 回顾，形成完整循环
3. **渐进式复杂度**：P0 功能简单实用，P3 功能强大但可选
4. **数据驱动**：所有洞察基于真实数据，而非空泛建议

期待与你一起将这些想法落地！
