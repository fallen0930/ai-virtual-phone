"use client";

// components/narrative-writer/legacy-migration-dialog.tsx
// 执笔 · 旧全局记忆归属迁移弹窗（任务 #20）。
//
// 规则（栗子定）：
// - 弹出前先 backupLegacyNarrativeData()，确认成功才展示内容；备份失败就停在这一步可重试，绝不带未备份的旧数据继续。
// - 只做复制，不删旧键；重复点"迁移"幂等。
// - 归属下拉永远不预选，哪怕只剩一个会话——旧数据属于哪场只有用户知道，选错难恢复。
// - 关闭（点叉 / 点遮罩）等同"稍后"：记 deferred，不删旧数据、不算已迁移。
// - 弹窗不阻塞面板：用户可以不选就继续用，此时旧记忆不参与生成。

import { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  backupLegacyNarrativeData,
  deferLegacyMigration,
  getLegacyNarrativeCounts,
  migrateLegacyToSession,
} from "@/lib/narrative-writer/storage";

export type MigrationSessionOption = { id: string; title: string };

type Props = {
  sessions: MigrationSessionOption[];
  /** 迁移成功后回调，带各类型数量 */
  onMigrated: (counts: { memories: number; emotions: number; history: number; skippedDuplicates: number }) => void;
  /** 用户选择"稍后"或直接关闭 */
  onDeferred: () => void;
};

type Phase = "backing" | "ready" | "migrating" | "done" | "failed_backup" | "failed_migrate";

export function LegacyMigrationDialog({ sessions, onMigrated, onDeferred }: Props) {
  const [phase, setPhase] = useState<Phase>("backing");
  const [counts, setCounts] = useState<Awaited<ReturnType<typeof getLegacyNarrativeCounts>> | null>(null);
  const [chosenId, setChosenId] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [doneCounts, setDoneCounts] = useState<{ memories: number; emotions: number } | null>(null);

  const runBackup = async () => {
    setPhase("backing");
    setErrorMsg("");
    try {
      await backupLegacyNarrativeData();
      const c = await getLegacyNarrativeCounts();
      setCounts(c);
      setPhase("ready");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("failed_backup");
    }
  };

  useEffect(() => {
    void runBackup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doMigrate = async () => {
    if (!chosenId) return;
    setPhase("migrating");
    try {
      const st = await migrateLegacyToSession(chosenId);
      const m = st.counts?.memories ?? 0;
      const e = st.counts?.emotions ?? 0;
      setDoneCounts({ memories: m, emotions: e });
      setPhase("done");
      onMigrated(st.counts ?? { memories: m, emotions: e, history: 0, skippedDuplicates: 0 });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("failed_migrate");
    }
  };

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
  };
  const box: React.CSSProperties = {
    width: "min(420px, 92vw)",
    maxHeight: "82vh",
    overflowY: "auto",
    background: "rgba(24, 24, 36, 0.98)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "12px",
    boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    color: "#e5e7eb",
  };
  const btn = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
    padding: "8px 14px",
    borderRadius: "8px",
    border: primary ? "none" : "1px solid rgba(255,255,255,0.15)",
    background: primary ? (disabled ? "rgba(167,139,250,0.35)" : "#a78bfa") : "transparent",
    color: primary ? (disabled ? "#cbb4ff" : "#14141f") : "#d1d5db",
    fontWeight: 600,
    fontSize: "13px",
    cursor: disabled ? "not-allowed" : "pointer",
  });

  return (
    <div style={overlay} onClick={onDeferred}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <span style={{ fontWeight: 700, fontSize: "15px" }}>旧记忆的归属</span>
          <button aria-label="关闭" onClick={onDeferred} style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", display: "flex" }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: "16px" }}>
          {phase === "backing" && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#9ca3af", padding: "24px 0", justifyContent: "center" }}>
              <Loader2 size={18} className="animate-spin" /> 正在先备份旧数据…
            </div>
          )}

          {phase === "failed_backup" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#f59e0b", marginBottom: "10px" }}>
                <AlertTriangle size={18} /> 备份失败
              </div>
              <p style={{ fontSize: "13px", lineHeight: 1.6, color: "#d1d5db", margin: "0 0 12px" }}>
                为避免在没有备份的情况下动旧数据，已停止。原数据仍原样保留、不受影响。
              </p>
              <div style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "14px", wordBreak: "break-word" }}>{errorMsg}</div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button style={btn(false)} onClick={onDeferred}>稍后</button>
                <button style={btn(true)} onClick={() => void runBackup()}>重试备份</button>
              </div>
            </div>
          )}

          {(phase === "ready" || phase === "migrating" || phase === "failed_migrate") && counts && (
            <div>
              <p style={{ fontSize: "13px", lineHeight: 1.7, color: "#d1d5db", margin: "0 0 14px" }}>
                这些是<strong style={{ color: "#c4b5fd" }}>升级前的旧记忆</strong>——它们还没有归属到任何一场聊天。
                为其中一场选定归属后，它们才会出现在那场聊天的执笔里。<strong style={{ color: "#9ca3af" }}>原数据不会被删除</strong>，只是复制过去。
              </p>

              <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: "8px", padding: "12px", marginBottom: "14px" }}>
                <div style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "8px" }}>待归属的旧数据概况</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "6px", fontSize: "13px" }}>
                  <div>记忆卡：<b>{counts.memories}</b></div>
                  <div>情感卡：<b>{counts.emotions}</b></div>
                  <div>生成历史：<b>{counts.history}</b></div>
                  <div>执笔状态：{counts.hasWriterState ? "有" : "无"}</div>
                  <div>关系水位：{counts.hasWater ? "有" : "无"}</div>
                  <div>剧情大纲：{counts.hasHierarchy ? "有" : "无"}</div>
                </div>
              </div>

              <label style={{ fontSize: "12px", color: "#9ca3af", display: "block", marginBottom: "6px" }}>归属到哪场聊天（必选）</label>
              <select
                value={chosenId}
                disabled={phase === "migrating"}
                onChange={(e) => setChosenId(e.target.value)}
                style={{
                  width: "100%", padding: "9px 10px", borderRadius: "8px", marginBottom: "6px",
                  background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.15)", color: "#e5e7eb", fontSize: "13px",
                }}
              >
                <option value="">— 请选择一场对局 —</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
              {sessions.length === 0 && (
                <div style={{ fontSize: "12px", color: "#f59e0b", margin: "6px 0" }}>本机还没有任何对局，先去特调里打开或新建一场再来归属。</div>
              )}

              {phase === "failed_migrate" && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: "6px", fontSize: "12px", color: "#f59e0b", margin: "8px 0", wordBreak: "break-word" }}>
                  <AlertTriangle size={14} style={{ marginTop: "2px", flex: "0 0 auto" }} /> 迁移未完成：{errorMsg}。原数据未受影响，可重试。
                </div>
              )}

              <div style={{ display: "flex", gap: "10px", marginTop: "16px", justifyContent: "flex-end" }}>
                <button style={btn(false)} disabled={phase === "migrating"} onClick={onDeferred}>稍后</button>
                <button style={btn(true, !chosenId || phase === "migrating")} disabled={!chosenId || phase === "migrating"} onClick={() => void doMigrate()}>
                  {phase === "migrating" ? "迁移中…" : "迁移到该对局"}
                </button>
              </div>
            </div>
          )}

          {phase === "done" && doneCounts && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#10b981", marginBottom: "12px" }}>
                <CheckCircle2 size={20} /> 迁移完成
              </div>
              <p style={{ fontSize: "14px", lineHeight: 1.7, color: "#e5e7eb", margin: "0 0 16px" }}>
                已迁移 <b>{doneCounts.memories}</b> 张记忆卡、<b>{doneCounts.emotions}</b> 张情感卡到所选对局。原数据仍保留，可放心。
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button style={btn(true)} onClick={onDeferred}>完成</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
