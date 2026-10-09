"use client";

// 画布拉线的两个纸片风弹窗：
// RelationLinkDialog —— 点照片A→照片B后输入关系标签
// RelationPairSheet —— 点线上标签，逐条查看/删除两人之间的关系

import { useState } from "react";
import type { CharacterWorldRelation } from "@/lib/character-world-storage";

export function RelationLinkDialog({
  fromName,
  toName,
  onConfirm,
  onCancel,
}: {
  fromName: string;
  toName: string;
  onConfirm: (label: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const submit = () => {
    if (!label.trim()) return;
    onConfirm(label.trim());
  };
  return (
    <div className="wt-modal" onClick={onCancel}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">RED STRING</div>
        <div className="wt-relation-row">
          <strong>{fromName}</strong>
          <span className="wt-relation-dash">是</span>
          <strong>{toName}</strong>
          <span className="wt-relation-dash">的…</span>
        </div>
        <input
          className="wt-paper-input"
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="如：哥哥 / 宿敌 / 上司"
        />
        <div className="wt-paper-actions">
          <button type="button" className="wt-btn" onClick={onCancel}>取消</button>
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" disabled={!label.trim()} onClick={submit}>牵线</button>
        </div>
      </div>
    </div>
  );
}

export function RelationPairSheet({
  relations,
  nameById,
  onDelete,
  onClose,
}: {
  /** 这对角色之间的全部关系（两个方向都算） */
  relations: CharacterWorldRelation[];
  nameById: Map<string, string>;
  onDelete: (relationId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="wt-modal" onClick={onClose}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">RELATIONS</div>
        {relations.length === 0 ? (
          <p className="wt-paper-hint">这两人之间已经没有关系线了。</p>
        ) : (
          <ul className="wt-relation-list">
            {relations.map(relation => (
              <li key={relation.id} className="wt-relation-item">
                <span className="wt-relation-text">
                  {nameById.get(relation.fromCharacterId) ?? "?"}
                  是{nameById.get(relation.toCharacterId) ?? "?"}的
                  「{relation.label}」
                </span>
                <button
                  type="button"
                  className="wt-btn wt-btn-danger wt-btn-small"
                  onClick={() => onDelete(relation.id)}
                  aria-label="删除这条关系"
                >
                  剪断
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="wt-paper-actions">
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
