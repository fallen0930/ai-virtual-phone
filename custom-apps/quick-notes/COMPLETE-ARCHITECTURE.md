# 随想笔记 v2.0 完整架构设计方案

> **设计原则**：
> 1. 所有功能完整保留，一个不漏
> 2. 角色互动完全用户触发，成本透明
> 3. 导航清晰，高频功能易达
> 4. 移动端优先，桌面端兼容

---

## 一、完整功能清单

### Phase 1: 基础增强
1. ✅ **附件上传**（v1.1 已实现）
2. ✅ **附件 AI 分析开关**（v1.1 已实现）
3. 📋 **语音输入**（v1.2）
4. 📋 **快捷模板**（v1.3）

### Phase 2: 知识管理
5. 📋 **双向链接**（v2.0）
6. 📋 **智能推荐**（v2.1）
7. 📋 **时间线视图**（v2.2）
8. 📋 **导出功能**（v2.3）

### Phase 3: 自我提升
9. 📋 **周期性回顾**（v3.0）
10. 📋 **目标追踪**（v3.1）
11. 📋 **模式识别**（v3.2）

---

## 二、主页导航架构（方案 C：混合导航）

### 整体布局

```
┌─────────────────────────────────────────────┐
│ 顶部栏（固定）                               │
│ ┌─────────────────────────────────────────┐ │
│ │ 🔍 搜索想法...    [+新建] [🎤语音] [📝模板] │ │
│ └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│                                             │
│           主内容区（可滚动）                 │
│     根据选中的底部 Tab 动态切换              │
│                                             │
│                                             │
├─────────────────────────────────────────────┤
│ 底部 Tab 栏（固定）                          │
│ ┌─────┬─────┬─────┬─────┬─────┐           │
│ │ 📝  │ 🔗  │ 🎯  │ 📅  │ ☰   │           │
│ │想法 │关联 │目标 │时间 │菜单 │           │
│ └─────┴─────┴─────┴─────┴─────┘           │
└─────────────────────────────────────────────┘
```

---

### 顶部栏设计

#### HTML 结构
```html
<header class="qn-topbar">
  <!-- 搜索框 -->
  <div class="qn-search-box">
    <svg class="qn-search-icon" width="16" height="16" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2"/>
    </svg>
    <input type="text" placeholder="搜索想法、标签..." id="qnSearchInput" />
  </div>
  
  <!-- 快捷操作按钮 -->
  <div class="qn-topbar-actions">
    <!-- 新建笔记 -->
    <button class="qn-btn-icon primary" id="qnNewNote" title="新建想法">
      <svg width="18" height="18" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    </button>
    
    <!-- 语音输入 -->
    <button class="qn-btn-icon" id="qnVoiceInput" title="语音输入">
      <svg width="18" height="18" viewBox="0 0 24 24">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" 
              fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" 
              fill="none" stroke="currentColor" stroke-width="2"/>
        <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2"/>
      </svg>
    </button>
    
    <!-- 快捷模板 -->
    <button class="qn-btn-icon" id="qnTemplates" title="快捷模板">
      <svg width="18" height="18" viewBox="0 0 24 24">
        <rect x="3" y="3" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"/>
        <rect x="14" y="3" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"/>
        <rect x="14" y="14" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"/>
        <rect x="3" y="14" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"/>
      </svg>
    </button>
  </div>
</header>
```

#### 样式
```css
.qn-topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(241, 242, 246, 0.95);
  backdrop-filter: blur(10px);
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--line-soft);
}

.qn-search-box {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 7px 10px;
  transition: .2s;
}

.qn-search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.qn-search-box input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--title);
}

.qn-search-icon {
  color: var(--muted);
  flex-shrink: 0;
}

.qn-topbar-actions {
  display: flex;
  gap: 6px;
}

.qn-btn-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  cursor: pointer;
  transition: .2s;
}

.qn-btn-icon:active {
  transform: scale(0.95);
}

.qn-btn-icon.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.qn-btn-icon.primary:active {
  background: var(--accent);
  opacity: 0.9;
}
```

---

### 底部 Tab 栏设计

#### Tab 结构

| Tab | 图标 | 名称 | 说明 |
|-----|------|------|------|
| 1 | 📝 | 想法 | 主视图，笔记列表（现有） |
| 2 | 🔗 | 关联 | 双向链接图谱（新增） |
| 3 | 🎯 | 目标 | 目标追踪（新增） |
| 4 | 📅 | 时间线 | 时间轴视图（新增） |
| 5 | ☰ | 菜单 | 侧滑菜单（分析记录/洞察/设置等） |

#### HTML 结构
```html
<nav class="qn-tabbar">
  <button class="qn-tab" data-tab="notes" data-active="1">
    <svg width="22" height="22" viewBox="0 0 24 24">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" 
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span>想法</span>
  </button>
  
  <button class="qn-tab" data-tab="graph" data-active="0">
    <svg width="22" height="22" viewBox="0 0 24 24">
      <circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
      <circle cx="18" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
    </svg>
    <span>关联</span>
  </button>
  
  <button class="qn-tab" data-tab="goals" data-active="0">
    <svg width="22" height="22" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
      <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
      <circle cx="12" cy="12" r="2" fill="currentColor"/>
    </svg>
    <span>目标</span>
  </button>
  
  <button class="qn-tab" data-tab="timeline" data-active="0">
    <svg width="22" height="22" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2"/>
      <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2"/>
      <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/>
    </svg>
    <span>时间线</span>
  </button>
  
  <button class="qn-tab" data-tab="menu" data-active="0">
    <svg width="22" height="22" viewBox="0 0 24 24">
      <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="3" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="3" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span>菜单</span>
  </button>
</nav>
```

#### 样式
```css
.qn-tabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 20;
  background: rgba(255, 255, 255, 0.98);
  backdrop-filter: blur(10px);
  border-top: 1px solid var(--line-soft);
  display: flex;
  padding: 6px 0 calc(var(--safe-bottom) + 6px);
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.05);
}

.qn-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 0;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 10.5px;
  cursor: pointer;
  transition: .2s;
  position: relative;
}

.qn-tab svg {
  width: 22px;
  height: 22px;
  transition: .2s;
}

.qn-tab[data-active="1"] {
  color: var(--accent);
}

.qn-tab[data-active="1"] svg {
  transform: scale(1.05);
}

.qn-tab:active {
  transform: scale(0.95);
}
```

---

### 侧滑菜单设计

#### HTML 结构
```html
<div class="qn-side-menu" id="qnSideMenu">
  <div class="qn-menu-mask" data-close="1"></div>
  <div class="qn-menu-panel">
    <div class="qn-menu-header">
      <h3>更多功能</h3>
      <button class="qn-close" data-close="1">✕</button>
    </div>
    
    <div class="qn-menu-list">
      <!-- 周期性回顾（高亮） -->
      <button class="qn-menu-item highlight" data-action="weekly-review">
        <span class="qn-menu-icon">📅</span>
        <span class="qn-menu-text">
          <strong>周期性回顾</strong>
          <small>让角色分析你的思维</small>
        </span>
      </button>
      
      <!-- 思维洞察 -->
      <button class="qn-menu-item" data-action="insights">
        <span class="qn-menu-icon">🔍</span>
        <span class="qn-menu-text">
          <strong>思维洞察</strong>
          <small>发现盲点和模式</small>
        </span>
      </button>
      
      <!-- 分析记录 -->
      <button class="qn-menu-item" data-action="analyses">
        <span class="qn-menu-icon">📊</span>
        <span class="qn-menu-text">
          <strong>分析记录</strong>
          <small>角色点评历史</small>
        </span>
      </button>
      
      <!-- 智能推荐 -->
      <button class="qn-menu-item" data-action="recommendations">
        <span class="qn-menu-icon">💡</span>
        <span class="qn-menu-text">
          <strong>智能推荐</strong>
          <small>相关笔记推荐</small>
        </span>
      </button>
      
      <div class="qn-menu-divider"></div>
      
      <!-- 导出数据 -->
      <button class="qn-menu-item" data-action="export">
        <span class="qn-menu-icon">📤</span>
        <span class="qn-menu-text">
          <strong>导出数据</strong>
          <small>Markdown / PDF / JSON</small>
        </span>
      </button>
      
      <!-- 备份恢复 -->
      <button class="qn-menu-item" data-action="backup">
        <span class="qn-menu-icon">📦</span>
        <span class="qn-menu-text">
          <strong>备份与恢复</strong>
          <small>导入导出数据</small>
        </span>
      </button>
      
      <div class="qn-menu-divider"></div>
      
      <!-- 设置 -->
      <button class="qn-menu-item" data-action="settings">
        <span class="qn-menu-icon">⚙️</span>
        <span class="qn-menu-text">设置</span>
      </button>
      
      <!-- 关于 -->
      <button class="qn-menu-item" data-action="about">
        <span class="qn-menu-icon">ℹ️</span>
        <span class="qn-menu-text">关于</span>
      </button>
    </div>
  </div>
</div>
```

#### 样式
```css
.qn-side-menu {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: none;
}

.qn-side-menu[data-open="1"] {
  display: block;
}

.qn-menu-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
}

.qn-menu-panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 300px;
  max-width: 85%;
  background: var(--bg);
  animation: qnSlideIn .25s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.15);
}

@keyframes qnSlideIn {
  from { 
    transform: translateX(100%); 
    opacity: 0.5;
  }
  to { 
    transform: translateX(0); 
    opacity: 1;
  }
}

.qn-menu-header {
  padding: 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.qn-menu-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.qn-close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel-2);
  border: none;
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
}

.qn-menu-list {
  padding: 8px;
  overflow-y: auto;
  max-height: calc(100% - 60px);
}

.qn-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: none;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  color: var(--title);
  text-align: left;
  cursor: pointer;
  transition: .2s;
}

.qn-menu-item:hover {
  background: var(--panel-2);
}

.qn-menu-item:active {
  transform: scale(0.98);
  background: var(--accent-soft);
}

.qn-menu-item.highlight {
  background: linear-gradient(135deg, var(--ai-soft), rgba(91, 107, 232, 0.08));
  border: 1px solid rgba(124, 91, 232, 0.2);
  margin-bottom: 4px;
}

.qn-menu-icon {
  font-size: 20px;
  width: 24px;
  text-align: center;
  flex-shrink: 0;
}

.qn-menu-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.qn-menu-text strong {
  font-weight: 600;
  font-size: 14px;
}

.qn-menu-text small {
  font-size: 11px;
  color: var(--muted);
}

.qn-menu-divider {
  height: 1px;
  background: var(--line-soft);
  margin: 8px 0;
}
```

---

## 三、各 Tab 内容设计

### Tab 1: 📝 想法（现有优化）

#### 内容结构
```html
<main class="qn-main-content" id="qnNotesTab">
  <!-- 筛选和排序区 -->
  <div class="qn-filters">
    <!-- 分类 chips -->
    <div class="qn-chips" id="qnChips">
      <button class="qn-chip" data-cat="" data-active="1">全部</button>
      <button class="qn-chip" data-cat="inbox">收集箱</button>
      <button class="qn-chip" data-cat="sorted">已整理</button>
      <button class="qn-chip" data-cat="archived">归档</button>
      <!-- 动态分类 -->
    </div>
    
    <!-- 排序和视图切换 -->
    <div class="qn-sort-bar">
      <select id="qnSort">
        <option value="updated">最近更新</option>
        <option value="created">创建时间</option>
        <option value="title">标题</option>
      </select>
      <button class="qn-btn-sm" id="qnViewToggle" title="切换视图">
        <svg><!-- 列表/网格图标 --></svg>
      </button>
    </div>
  </div>
  
  <!-- 周期性回顾提示（非侵入式） -->
  <div class="qn-review-hint" id="qnReviewHint" style="display:none">
    <div class="qn-hint-content">
      <span class="qn-hint-icon">📅</span>
      <span>过去一周新增了 <strong id="qnNewCount">8</strong> 条想法</span>
      <button class="qn-btn-sm ai" onclick="openReviewDialog()">让角色看看</button>
    </div>
  </div>
  
  <!-- 笔记列表 -->
  <div class="qn-body" id="qnList">
    <!-- 动态渲染 -->
  </div>
  
  <!-- 浮动新建按钮（移动端） -->
  <button class="qn-fab" id="qnFabNew" title="记一条想法">
    <svg width="24" height="24" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    </svg>
  </button>
</main>
```

#### 样式补充
```css
.qn-filters {
  padding: 12px 14px;
  background: var(--bg);
}

.qn-sort-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}

.qn-sort-bar select {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  font-size: 12px;
  color: var(--text);
}

.qn-btn-sm {
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}

.qn-btn-sm.ai {
  background: var(--ai-soft);
  border-color: rgba(124, 91, 232, 0.28);
  color: var(--ai);
  font-weight: 600;
}

.qn-review-hint {
  margin: 0 14px 12px;
  padding: 10px 12px;
  background: linear-gradient(135deg, var(--ai-soft), rgba(91, 107, 232, 0.08));
  border: 1px solid rgba(124, 91, 232, 0.2);
  border-radius: 12px;
}

.qn-hint-content {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--title);
}

.qn-hint-icon {
  font-size: 16px;
}

.qn-hint-content strong {
  color: var(--ai);
  font-weight: 700;
}

.qn-hint-content button {
  margin-left: auto;
}

/* 浮动按钮（移动端） */
.qn-fab {
  position: fixed;
  right: 16px;
  bottom: calc(70px + var(--safe-bottom));
  width: 56px;
  height: 56px;
  border-radius: 28px;
  background: var(--accent);
  border: none;
  color: #fff;
  box-shadow: 0 4px 12px rgba(91, 107, 232, 0.3);
  display: none; /* 桌面端隐藏 */
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 15;
  transition: .2s;
}

.qn-fab:active {
  transform: scale(0.95);
}

@media (max-width: 768px) {
  .qn-fab {
    display: flex;
  }
  .qn-topbar-actions #qnNewNote {
    display: none; /* 移动端隐藏顶部新建按钮 */
  }
}
```

---

### Tab 2: 🔗 关联（双向链接图谱）

#### 内容结构
```html
<main class="qn-main-content" id="qnGraphTab" style="display:none">
  <div class="qn-graph-header">
    <h2>关联图谱</h2>
    <p class="qn-graph-desc">可视化展示笔记之间的引用关系</p>
  </div>
  
  <!-- 图谱视图切换 -->
  <div class="qn-graph-controls">
    <div class="qn-segmented-control">
      <button data-view="list" data-active="1">列表</button>
      <button data-view="graph">图谱</button>
    </div>
    <select id="qnGraphFilter">
      <option value="all">全部笔记</option>
      <option value="has-links">仅显示有关联的</option>
      <option value="backlinks">仅显示被引用的</option>
    </select>
  </div>
  
  <!-- 列表视图 -->
  <div class="qn-graph-list" id="qnGraphListView">
    <!-- 动态渲染：每条笔记显示其引用和被引用 -->
  </div>
  
  <!-- 图谱视图（使用 Canvas 或 SVG） -->
  <div class="qn-graph-canvas-wrap" id="qnGraphCanvasView" style="display:none">
    <canvas id="qnGraphCanvas"></canvas>
    <div class="qn-graph-legend">
      <span class="qn-legend-item">
        <span class="qn-legend-dot primary"></span> 选中笔记
      </span>
      <span class="qn-legend-item">
        <span class="qn-legend-dot secondary"></span> 关联笔记
      </span>
    </div>
  </div>
</main>
```

#### 列表视图示例
```html
<div class="qn-link-card" data-note-id="note_xxx">
  <div class="qn-link-header">
    <h4>💡 新的交互方案</h4>
    <span class="qn-link-count">3 个关联</span>
  </div>
  
  <div class="qn-link-section">
    <h5>引用了以下笔记</h5>
    <ul class="qn-link-list">
      <li>
        <a href="#" data-link-note="note_yyy">🐛 登录超时 Bug</a>
        <span class="qn-link-type">outgoing</span>
      </li>
      <li>
        <a href="#" data-link-note="note_zzz">✅ 优化性能任务</a>
        <span class="qn-link-type">outgoing</span>
      </li>
    </ul>
  </div>
  
  <div class="qn-link-section">
    <h5>被以下笔记引用</h5>
    <ul class="qn-link-list">
      <li>
        <a href="#" data-link-note="note_aaa">📚 竞品分析</a>
        <span class="qn-link-type">incoming</span>
      </li>
    </ul>
  </div>
</div>
```

---

### Tab 3: 🎯 目标（新增）

详见之前的设计文档，这里省略。

---

### Tab 4: 📅 时间线（新增）

详见之前的设计文档，这里省略。

---

## 四、特殊功能入口设计

### 1. 语音输入

**入口**：顶部栏「🎤 语音」按钮

**流程**：
1. 点击按钮
2. 如果没有打开编辑面板，自动打开新建笔记面板
3. 开始录音，显示录音状态
4. 用户点击停止
5. 调用 `ai.speechToText` 转写
6. 文本追加到正文

**录音状态 UI**：
```html
<div class="qn-recording-indicator" id="qnRecordingIndicator" style="display:none">
  <div class="qn-recording-pulse"></div>
  <span>正在聆听…</span>
  <button class="qn-btn-sm danger" onclick="stopRecording()">停止</button>
</div>
```

---

### 2. 快捷模板

**入口**：顶部栏「📝 模板」按钮

**流程**：
1. 点击按钮
2. 弹出模板选择器
3. 用户选择模板
4. 自动新建笔记并填充模板内容

**模板选择器 UI**：
```html
<div class="qn-sheet" id="qnTemplateSheet">
  <div class="qn-mask" data-close="1"></div>
  <div class="qn-panel">
    <div class="qn-sheet-head">
      <div>
        <div class="qn-sheet-title">选择笔记模板</div>
        <div class="qn-sheet-sub">快速开始，结构化记录</div>
      </div>
      <button class="qn-close" data-close="1">✕</button>
    </div>
    <div class="qn-sheet-body">
      <div class="qn-template-grid">
        <button class="qn-template-card" data-template="bug">
          <div class="qn-template-icon">🐛</div>
          <div class="qn-template-name">Bug 记录</div>
          <div class="qn-template-desc">现象、复现步骤、期望结果</div>
        </button>
        
        <button class="qn-template-card" data-template="idea">
          <div class="qn-template-icon">💡</div>
          <div class="qn-template-name">灵感想法</div>
          <div class="qn-template-desc">背景、核心点、可能价值</div>
        </button>
        
        <button class="qn-template-card" data-template="todo">
          <div class="qn-template-icon">✅</div>
          <div class="qn-template-name">待办事项</div>
          <div class="qn-template-desc">任务、截止时间、优先级</div>
        </button>
        
        <button class="qn-template-card" data-template="reflection">
          <div class="qn-template-icon">🤔</div>
          <div class="qn-template-name">反思总结</div>
          <div class="qn-template-desc">事件、感受、收获、改进</div>
        </button>
        
        <button class="qn-template-card" data-template="learning">
          <div class="qn-template-icon">📚</div>
          <div class="qn-template-name">学习笔记</div>
          <div class="qn-template-desc">主题、概念、疑问、计划</div>
        </button>
        
        <button class="qn-template-card" data-template="blank">
          <div class="qn-template-icon">📄</div>
          <div class="qn-template-name">空白笔记</div>
          <div class="qn-template-desc">从零开始</div>
        </button>
      </div>
    </div>
  </div>
</div>
```

---

### 3. 周期性回顾

**入口**：
- 侧滑菜单「📅 周期性回顾」（高亮显示）
- 想法 Tab 顶部的非侵入式提示条

**对话框 UI**：
```html
<div class="qn-sheet" id="qnReviewSheet">
  <div class="qn-mask" data-close="1"></div>
  <div class="qn-panel">
    <div class="qn-sheet-head">
      <div>
        <div class="qn-sheet-title">生成周期性回顾</div>
        <div class="qn-sheet-sub">让角色分析你的思维轨迹</div>
      </div>
      <button class="qn-close" data-close="1">✕</button>
    </div>
    
    <div class="qn-sheet-body">
      <!-- 步骤1：选择角色 -->
      <div class="qn-field">
        <div class="qn-label">选择角色</div>
        <div class="qn-char-list" id="qnReviewCharList">
          <!-- 动态渲染角色卡片 -->
        </div>
      </div>
      
      <!-- 步骤2：选择时间范围 -->
      <div class="qn-field">
        <div class="qn-label">时间范围</div>
        <div class="qn-chiprow">
          <button class="pk" data-period="7" data-on="1">本周（7天）</button>
          <button class="pk" data-period="30">本月（30天）</button>
          <button class="pk" data-period="custom">自定义</button>
        </div>
      </div>
      
      <!-- 成本提示 -->
      <div class="qn-cost-hint">
        <span class="qn-cost-icon">💰</span>
        <div class="qn-cost-text">
          <strong>预计消耗</strong>
          <span>约 500 tokens（¥0.01）</span>
        </div>
      </div>
      
      <!-- 预览 -->
      <div class="qn-preview-hint">
        将分析过去 7 天的 <strong>8 条</strong>新想法
      </div>
    </div>
    
    <div class="qn-sheet-foot">
      <button class="qn-btn grow" data-close="1">取消</button>
      <button class="qn-btn ai grow" id="qnStartReview">开始分析</button>
    </div>
  </div>
</div>
```

---

### 4. 思维洞察（模式识别）

**入口**：侧滑菜单「🔍 思维洞察」

**UI 设计**：
```html
<main class="qn-main-content" id="qnInsightsPage" style="display:none">
  <div class="qn-insights-header">
    <h2>思维洞察</h2>
    <p class="qn-insights-desc">AI 分析你的笔记模式，发现思维盲点</p>
  </div>
  
  <!-- 生成按钮 -->
  <div class="qn-insight-generate">
    <button class="qn-btn primary" id="qnGenerateInsights">
      <span class="qn-btn-icon-left">🔍</span>
      开始分析
    </button>
    <span class="qn-cost-hint">预计消耗 ~800 tokens</span>
  </div>
  
  <!-- 洞察结果列表 -->
  <div class="qn-insights-list" id="qnInsightsList">
    <!-- 动态渲染洞察卡片 -->
  </div>
</main>
```

---

### 5. 智能推荐

**入口**：
- 侧滑菜单「💡 智能推荐」
- 笔记详情页底部「相关推荐」区域

**笔记详情页推荐区**：
```html
<div class="qn-recommendations" id="qnRecommendations">
  <h4>相关笔记推荐</h4>
  <p class="qn-rec-hint">基于内容和标签的相似度</p>
  
  <div class="qn-rec-list">
    <div class="qn-rec-card" data-note-id="note_yyy">
      <div class="qn-rec-title">💡 另一个交互方案</div>
      <div class="qn-rec-reason">都提到了「用户体验」</div>
      <div class="qn-rec-score">相似度 85%</div>
    </div>
    
    <div class="qn-rec-card" data-note-id="note_zzz">
      <div class="qn-rec-title">📚 React 性能优化</div>
      <div class="qn-rec-reason">相同标签：#性能</div>
      <div class="qn-rec-score">相似度 72%</div>
    </div>
  </div>
</div>
```

---

### 6. 导出功能

**入口**：侧滑菜单「📤 导出数据」

**导出选择器**：
```html
<div class="qn-sheet" id="qnExportSheet">
  <div class="qn-mask" data-close="1"></div>
  <div class="qn-panel">
    <div class="qn-sheet-head">
      <div>
        <div class="qn-sheet-title">导出数据</div>
        <div class="qn-sheet-sub">选择导出范围和格式</div>
      </div>
      <button class="qn-close" data-close="1">✕</button>
    </div>
    
    <div class="qn-sheet-body">
      <!-- 导出范围 -->
      <div class="qn-field">
        <div class="qn-label">导出范围</div>
        <div class="qn-radio-group">
          <label class="qn-radio">
            <input type="radio" name="exportScope" value="single" checked />
            <span>当前笔记</span>
          </label>
          <label class="qn-radio">
            <input type="radio" name="exportScope" value="category" />
            <span>某个分类</span>
          </label>
          <label class="qn-radio">
            <input type="radio" name="exportScope" value="all" />
            <span>全部笔记</span>
          </label>
        </div>
      </div>
      
      <!-- 导出格式 -->
      <div class="qn-field">
        <div class="qn-label">导出格式</div>
        <div class="qn-format-grid">
          <button class="qn-format-card" data-format="markdown">
            <div class="qn-format-icon">📄</div>
            <div class="qn-format-name">Markdown</div>
            <div class="qn-format-desc">纯文本，易编辑</div>
          </button>
          
          <button class="qn-format-card" data-format="pdf">
            <div class="qn-format-icon">📑</div>
            <div class="qn-format-name">PDF</div>
            <div class="qn-format-desc">美观排版</div>
          </button>
          
          <button class="qn-format-card" data-format="json">
            <div class="qn-format-icon">🗂️</div>
            <div class="qn-format-name">JSON</div>
            <div class="qn-format-desc">完整备份</div>
          </button>
          
          <button class="qn-format-card" data-format="zip">
            <div class="qn-format-icon">📦</div>
            <div class="qn-format-name">ZIP</div>
            <div class="qn-format-desc">含附件打包</div>
          </button>
        </div>
      </div>
      
      <!-- 高级选项 -->
      <div class="qn-field">
        <div class="qn-label">高级选项</div>
        <div class="qn-checkbox-group">
          <label class="qn-checkbox">
            <input type="checkbox" id="exportIncludeAttachments" checked />
            <span>包含附件</span>
          </label>
          <label class="qn-checkbox">
            <input type="checkbox" id="exportIncludeAnalyses" />
            <span>包含 AI 分析</span>
          </label>
          <label class="qn-checkbox">
            <input type="checkbox" id="exportIncludeMetadata" checked />
            <span>包含元数据</span>
          </label>
        </div>
      </div>
    </div>
    
    <div class="qn-sheet-foot">
      <button class="qn-btn grow" data-close="1">取消</button>
      <button class="qn-btn primary grow" id="qnStartExport">开始导出</button>
    </div>
  </div>
</div>
```

---

## 五、功能入口汇总表

| 功能 | 入口位置 | 触发方式 | 备注 |
|-----|---------|---------|------|
| 新建笔记 | 顶部栏 [+新建] / 底部 FAB | 点击 | 移动端显示 FAB |
| 语音输入 | 顶部栏 [🎤语音] | 点击 | 需宿主支持 |
| 快捷模板 | 顶部栏 [📝模板] | 点击 | 弹出选择器 |
| 搜索 | 顶部搜索框 | 输入 | 实时搜索 |
| 双向链接 | Tab 2 [🔗关联] | 点击 Tab | 列表/图谱视图 |
| 目标追踪 | Tab 3 [🎯目标] | 点击 Tab | CRUD + 评估 |
| 时间线 | Tab 4 [📅时间线] | 点击 Tab | 可视化展示 |
| 周期性回顾 | 侧滑菜单 / 提示条 | 点击 | 需选择角色 |
| 思维洞察 | 侧滑菜单 | 点击 | 模式识别 |
| 智能推荐 | 侧滑菜单 / 笔记详情 | 点击 | 相关笔记 |
| 导出数据 | 侧滑菜单 | 点击 | 多种格式 |
| 备份恢复 | 侧滑菜单 | 点击 | 导入导出 |
| 设置 | 侧滑菜单 | 点击 | 分类/角色 |
| 关于 | 侧滑菜单 | 点击 | 版本信息 |

---

## 六、角色互动控制总结

### 核心原则
1. **零自动触发**：所有角色互动都由用户主动发起
2. **明确入口**：每个功能都有清晰的"让角色看看"按钮
3. **成本透明**：执行前显示预计 token 消耗
4. **非侵入提示**：只在有价值时显示提示条，用户可忽略

### 角色互动的触发点

| 功能 | 触发方式 | 预计消耗 |
|-----|---------|---------|
| 周期性回顾 | 洞察 Tab / 提示条 → 选择角色 → 确认 | ~500 tokens |
| 思维洞察 | 洞察页 → 点击"开始分析" → 确认 | ~800 tokens |
| 目标评估 | 目标详情页 → 点击"评估进度" → 选择角色 | ~300 tokens |
| 问角色 | 笔记详情页 → 点击"问角色" → 选择角色 | ~400 tokens |

---

## 七、开发实施计划

### Phase 1: 导航重构（3-4天）
1. ✅ 实现顶部搜索栏
2. ✅ 实现底部 Tab 栏
3. ✅ 实现侧滑菜单
4. ✅ 迁移现有"想法"Tab
5. ✅ 添加语音输入和模板按钮

### Phase 2: 核心功能（5-7天）
1. 📋 实现双向链接（2-3天）
2. 📋 实现目标追踪（3-4天）

### Phase 3: 可视化（2-3天）
1. 📋 实现时间线视图

### Phase 4: AI 增强（4-6天）
1. 📋 实现周期性回顾（2-3天）
2. 📋 实现思维洞察（2-3天）

### Phase 5: 锦上添花（3-4天）
1. 📋 实现智能推荐（1-2天）
2. 📋 实现导出功能（2天）

---

## 八、技术债务与优化

### 性能优化
1. **虚拟滚动**：笔记 > 500 条时启用
2. **懒加载**：附件按需加载
3. **增量分析**：只分析新增/修改的笔记
4. **缓存策略**：洞察结果缓存 24 小时

### 数据迁移
1. 新增字段向后兼容
2. 旧数据自动补全默认值
3. 提供数据迁移工具

### 错误处理
1. API 调用失败优雅降级
2. 网络异常重试机制
3. 用户友好的错误提示

---

## 九、总结

这个完整方案涵盖了所有设计的功能：
- ✅ 语音输入
- ✅ 快捷模板
- ✅ 双向链接
- ✅ 智能推荐
- ✅ 时间线视图
- ✅ 导出功能
- ✅ 周期性回顾
- ✅ 目标追踪
- ✅ 模式识别

并且提供了清晰的导航架构和用户触发机制，确保：
1. 功能完整，一个不漏
2. 角色互动可控，成本透明
3. 导航清晰，易于使用
4. 移动端优先，桌面端兼容

**下一步**：根据这个方案开始实施开发。
