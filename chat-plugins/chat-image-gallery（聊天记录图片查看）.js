// 聊天图片墙 · 聊天室插件（apiVersion 1）
// 功能：在聊天室顶部放一个「🖼 图片墙」按钮，点开后可查看
//       不论是 char（对方）还是我发过的所有图片，网格浏览、点击放大、左右切换。
// 用法：把本文件整段源码粘贴进「聊天插件」管理页 → 安装 → 启用即可。
export default {
  manifest: {
    id: "chat-image-gallery",
    name: "聊天图片墙",
    apiVersion: 1,
    version: "1.0.0",
    author: "栗子",
    description: "一键查看当前聊天（或全部聊天）里，不论对方(char)还是你发过的所有图片；网格浏览、点击放大、支持左右切换。",
    permissions: ["chat.read", "ui"],
    settings: [
      {
        key: "defaultScope",
        label: "默认范围",
        type: "select",
        default: "all",
        options: [
          { value: "all", label: "全部会话" },
          { value: "current", label: "仅当前会话" },
        ],
      },
      {
        key: "columns",
        label: "每行列数",
        type: "number",
        default: 3,
      },
    ],
  },

  setup(ctx) {
    // ── 工具函数 ──────────────────────────────────────────

    // 一条消息是否含图片：覆盖 image / sticker / media_file(fileType=image)
    function isImageMessage(msg) {
      if (!msg) return false;
      if (msg.mediaType === "image") return true;
      if (msg.role === "user" && msg.mediaType === "sticker" && msg.mediaData && msg.mediaData.stickerUrl) return true;
      if (msg.mediaType === "media_file" && msg.mediaData && msg.mediaData.fileType === "image") return true;
      return false;
    }

    // 发件人显示名：我 / 角色名 / 群名 / 对方
    function senderName(msg, session) {
      if (msg.role === "user") return "我";
      if (session) {
        const contact = ctx.data.contacts.list().find((c) => c.id === session.contactId);
        if (contact) {
          const ch = ctx.data.characters.get(contact.characterId);
          if (ch && ch.name) return ch.name;
          if (contact.nickname) return contact.nickname;
        }
        if (session.isGroup && session.groupName) return session.groupName;
      }
      return "对方";
    }

    // 收集图片消息；scope: "all" | "current"
    function collect(scope, currentSessionId) {
      const result = [];
      const sessions = ctx.data.sessions.list();
      const targets =
        scope === "current" && currentSessionId
          ? sessions.filter((s) => s.id === currentSessionId)
          : sessions;
      for (const s of targets) {
        const msgs = ctx.data.messages.list(s.id);
        for (const m of msgs) {
          if (!isImageMessage(m)) continue;
          result.push({
            msg: m,
            sessionId: s.id,
            sessionName: s.title || (s.isGroup ? s.groupName || "群聊" : "") || "",
            sender: senderName(m, s),
            time: m.createdAt || "",
          });
        }
      }
      result.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      return result;
    }

    function fmtTime(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // ── 图片墙弹窗 ────────────────────────────────────────
    // options: { sessionId?, scope?, focusMessageId? }
    function openGallery(options) {
      options = options || {};
      let scope = options.scope || (ctx.system.settings.get("defaultScope") === "current" ? "current" : "all");
      const currentSessionId = options.sessionId || null;
      let items = [];
      let lightbox = null;

      ctx.ui.openModal((root, api) => {
        root.style.cssText =
          "position:relative;background:#fff;color:#1a1a1a;width:min(880px,94vw);max-height:88vh;" +
          "display:flex;flex-direction:column;overflow:hidden;" +
          "font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;";

        // 顶部栏
        const header = document.createElement("div");
        header.style.cssText =
          "display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #eee;flex:0 0 auto;";
        const title = document.createElement("div");
        title.style.cssText = "font-size:16px;font-weight:600;";
        title.textContent = "🖼 聊天图片墙";
        const spacer = document.createElement("div");
        spacer.style.cssText = "flex:1;";

        const seg = document.createElement("div");
        seg.style.cssText = "display:flex;border:1px solid #ddd;border-radius:8px;overflow:hidden;font-size:13px;";
        const segAll = document.createElement("button");
        segAll.textContent = "全部会话";
        const segCur = document.createElement("button");
        segCur.textContent = "仅当前";
        [segAll, segCur].forEach((b) => {
          b.style.cssText = "border:0;padding:6px 12px;cursor:pointer;";
          seg.appendChild(b);
        });
        function updateSeg() {
          segAll.style.background = scope === "all" ? "#2f6df6" : "#f6f6f6";
          segAll.style.color = scope === "all" ? "#fff" : "#444";
          segCur.style.background = scope === "current" ? "#2f6df6" : "#f6f6f6";
          segCur.style.color = scope === "current" ? "#fff" : "#444";
        }
        segAll.onclick = () => { scope = "all"; updateSeg(); refresh(); };
        segCur.onclick = () => { scope = "current"; updateSeg(); refresh(); };

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "✕";
        closeBtn.style.cssText = "border:0;background:transparent;font-size:18px;cursor:pointer;color:#888;";
        closeBtn.onclick = () => api.close();
        header.append(title, spacer, seg, closeBtn);

        // 统计条
        const stat = document.createElement("div");
        stat.style.cssText =
          "padding:8px 16px;font-size:12px;color:#888;border-bottom:1px solid #f0f0f0;flex:0 0 auto;";

        // 网格区
        const gridWrap = document.createElement("div");
        gridWrap.style.cssText = "overflow:auto;padding:14px 16px;flex:1 1 auto;";
        const grid = document.createElement("div");
        gridWrap.appendChild(grid);
        root.append(header, stat, gridWrap);

        // 单张卡片
        function makeCard(item, idx) {
          const card = document.createElement("div");
          card.style.cssText =
            "background:#fafafa;border:1px solid #eee;border-radius:10px;overflow:hidden;" +
            "cursor:pointer;display:flex;flex-direction:column;";
          const thumb = document.createElement("div");
          thumb.style.cssText =
            "aspect-ratio:1/1;background:#eee center/cover no-repeat;display:flex;" +
            "align-items:center;justify-content:center;color:#aaa;font-size:12px;";
          thumb.textContent = "加载中…";
          const meta = document.createElement("div");
          meta.style.cssText = "padding:6px 8px;font-size:11px;color:#666;line-height:1.4;";
          const line1 = document.createElement("div");
          line1.style.cssText = "font-weight:600;color:#333;";
          line1.textContent = item.sender + (item.sessionName ? ` · ${item.sessionName}` : "");
          const line2 = document.createElement("div");
          line2.style.cssText = "color:#999;margin-top:2px;";
          line2.textContent = fmtTime(item.time);
          meta.append(line1, line2);
          card.append(thumb, meta);
          card.onclick = () => openLightbox(idx);

          // 懒解析媒体（mediastore:// 引用 → dataURL）
          ctx.data.messages.resolveMedia(item.msg).then((media) => {
            if (media && media.dataURL) {
              thumb.style.backgroundImage = `url("${media.dataURL}")`;
              thumb.textContent = "";
            } else {
              thumb.textContent = "无法读取";
            }
          }).catch(() => { thumb.textContent = "无法读取"; });
          return card;
        }

        function renderGrid() {
          const cols = Math.max(1, Math.min(6, Number(ctx.system.settings.get("columns")) || 3));
          grid.style.cssText = `display:grid;grid-template-columns:repeat(${cols},1fr);gap:10px;`;
          grid.innerHTML = "";
          if (items.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "grid-column:1/-1;text-align:center;color:#999;padding:40px 0;";
            empty.textContent = "这个范围内还没有图片消息 🤔";
            grid.appendChild(empty);
            return;
          }
          items.forEach((it, i) => grid.appendChild(makeCard(it, i)));
        }

        // 灯箱（放大 + 左右切换），覆盖在弹窗内
        function closeLightbox() {
          if (lightbox) { lightbox.remove(); lightbox = null; }
        }
        function openLightbox(idx) {
          closeLightbox();
          if (!items.length) return;
          lightbox = document.createElement("div");
          lightbox.style.cssText =
            "position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;flex-direction:column;z-index:5;";
          const bar = document.createElement("div");
          bar.style.cssText =
            "display:flex;align-items:center;gap:10px;padding:10px 14px;color:#fff;font-size:13px;flex:0 0 auto;";
          const cap = document.createElement("div");
          cap.style.cssText = "flex:1;";
          const prev = document.createElement("button");
          prev.textContent = "‹ 上一张";
          const next = document.createElement("button");
          next.textContent = "下一张 ›";
          const lbClose = document.createElement("button");
          lbClose.textContent = "✕ 关闭";
          [prev, next, lbClose].forEach((b) => {
            b.style.cssText =
              "border:0;background:rgba(255,255,255,.15);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer;";
          });
          const stage = document.createElement("div");
          stage.style.cssText =
            "flex:1;display:flex;align-items:center;justify-content:center;padding:10px;overflow:auto;";
          const img = document.createElement("img");
          img.style.cssText =
            "max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.4);";
          stage.appendChild(img);
          lightbox.append(bar, stage);
          root.appendChild(lightbox);

          function show(i) {
            idx = (i + items.length) % items.length;
            const it = items[idx];
            cap.textContent =
              `${it.sender}${it.sessionName ? " · " + it.sessionName : ""} · ${fmtTime(it.time)}  (${idx + 1}/${items.length})`;
            img.removeAttribute("src");
            img.alt = "加载中…";
            ctx.data.messages.resolveMedia(it.msg).then((media) => {
              if (media && media.dataURL) { img.src = media.dataURL; img.alt = ""; }
              else img.alt = "无法读取图片";
            }).catch(() => { img.alt = "无法读取图片"; });
          }
          prev.onclick = () => show(idx - 1);
          next.onclick = () => show(idx + 1);
          lbClose.onclick = closeLightbox;
          lightbox.onclick = (e) => { if (e.target === lightbox) closeLightbox(); };
          show(idx);
        }

        // 刷新（重新扫描）
        function refresh() {
          items = collect(scope, currentSessionId);
          const mine = items.filter((i) => i.sender === "我").length;
          const others = items.length - mine;
          stat.textContent = `共 ${items.length} 张图片 · 我发的 ${mine} 张 · 对方发的 ${others} 张`;
          updateSeg();
          renderGrid();
          // 若指定了要聚焦的消息，直接打开它的灯箱
          if (options.focusMessageId) {
            const fi = items.findIndex((i) => i.msg.id === options.focusMessageId);
            if (fi >= 0) openLightbox(fi);
            options.focusMessageId = null; // 只跳一次
          }
        }

        // 实时更新：新图片进来时刷新
        const offMsg = ctx.hooks.on("message.persisted", () => refresh());
        refresh();

        return () => { offMsg(); closeLightbox(); };
      });
    }

    // ── 入口 1：聊天室顶部按钮 ───────────────────────────
    ctx.ui.slot("chat.header", (el, props) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "🖼 图片墙";
      btn.style.cssText =
        "border:1px solid #d8e0f0;background:#f3f7ff;color:#2f6df6;font-size:13px;" +
        "padding:5px 12px;border-radius:999px;cursor:pointer;font-weight:600;";

      const badge = document.createElement("span");
      badge.style.cssText =
        "background:#2f6df6;color:#fff;font-size:11px;min-width:18px;height:18px;line-height:18px;" +
        "border-radius:999px;padding:0 5px;text-align:center;display:none;";

      function updateBadge() {
        const n = props.sessionId ? collect("current", props.sessionId).length : 0;
        if (n > 0) { badge.style.display = "inline-block"; badge.textContent = String(n); }
        else badge.style.display = "none";
      }
      btn.onclick = () => openGallery({ sessionId: props.sessionId });
      updateBadge();
      const off = ctx.hooks.on("message.persisted", updateBadge);

      wrap.append(btn, badge);
      el.appendChild(wrap);
      return () => off();
    });

    // ── 入口 2：图片消息长按菜单「在图片墙中查看」 ────────
    ctx.ui.messageAction({
      id: "view-in-gallery",
      label: "在图片墙中查看",
      filter: (msg) => isImageMessage(msg),
      onSelect: (msg) => {
        openGallery({ sessionId: msg.sessionId, focusMessageId: msg.id });
      },
    });

    ctx.system.log("聊天图片墙已启用");
  },
};
