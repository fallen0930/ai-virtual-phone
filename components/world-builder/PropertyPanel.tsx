"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import * as THREE from "three";
import { Trash2 } from "lucide-react";
import type { SceneObject, LightData } from "./scene-store";
import { getModelSize } from "./scene-store";

interface Props {
  selected: SceneObject | null;
  onUpdate: (id: string, changes: Partial<SceneObject>) => void;
  onDelete: (id: string) => void;
  onArray: (id: string, axis: 0 | 1 | 2, count: number, spacing: number) => void;
}

export default function PropertyPanel({ selected, onUpdate, onDelete, onArray }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [arrayAxis, setArrayAxis] = useState<0 | 1 | 2>(0);
  const [arrayCount, setArrayCount] = useState(3);
  const [arraySpacing, setArraySpacing] = useState(1.0);
  const [spacingInput, setSpacingInput] = useState("1.00");
  const spacingEditedRef = useRef(false);
  const [scaleLocked, setScaleLocked] = useState(true);
  const [showArray, setShowArray] = useState(false);
  const [modelSize, setModelSize] = useState<[number, number, number] | null>(null);
  const dragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // 加载模型尺寸（考虑旋转后的世界空间包围盒）
  useEffect(() => {
    if (!selected) { setModelSize(null); return; }
    let cancelled = false;
    getModelSize(selected.modelUrl).then((rawSize) => {
      if (cancelled) return;
      const s = selected.scale;
      const local: [number, number, number] = [
        rawSize[0] * s[0],
        rawSize[1] * s[1],
        rawSize[2] * s[2],
      ];
      setModelSize(local);
      if (!spacingEditedRef.current) {
        setArraySpacing(local[arrayAxis]);
        setSpacingInput(local[arrayAxis].toFixed(2));
      }
    });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.modelUrl, selected?.scale?.join(","), selected?.rotation]);

  // 切轴时更新默认间距（仅用户没手动改过时）
  useEffect(() => {
    if (modelSize) {
      spacingEditedRef.current = false;
      setArraySpacing(modelSize[arrayAxis]);
      setSpacingInput(modelSize[arrayAxis].toFixed(2));
    }
  }, [arrayAxis]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    startPos.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [offset]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    setOffset({
      x: startPos.current.ox + (e.clientX - startPos.current.x),
      y: startPos.current.oy + (e.clientY - startPos.current.y),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (!selected) return null;

  const { id, name, rotation, scale } = selected;
  const axisLabels = ["X", "Y", "Z"] as const;

  return (
    <div
      ref={panelRef}
      className="wb-float-panel"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <div
        className="wb-float-header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: "grab", touchAction: "none" }}
      >
        <span>{name}</span>
        <button className="wb-float-close wb-float-delete" onClick={() => onDelete(id)} title="删除" aria-label="删除模型">
          <Trash2 size={14} strokeWidth={2} />
        </button>
      </div>

      {/* 尺寸信息 */}
      {modelSize && (
        <div className="wb-float-section wb-size-row">
          {([
            [0, "#e55"],
            [1, "#5b5"],
            [2, "#55e"],
          ] as const).map(([i, color]) => (
            <span key={i} className="wb-size-tag" style={{ color }}>
              {axisLabels[i]} {modelSize[i].toFixed(2)}
            </span>
          ))}
        </div>
      )}

      <div className="wb-float-section">
        <span className="wb-float-label">旋转</span>
        <div className="wb-rotate-grid">
          {([
            [new THREE.Vector3(1, 0, 0), "X", "#e55"],
            [new THREE.Vector3(0, 1, 0), "Y", "#5b5"],
            [new THREE.Vector3(0, 0, 1), "Z", "#55e"],
          ] as const).map(([axisVec, label, color]) => {
            const localRotate = (angle: number) => {
              const cur = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation));
              const delta = new THREE.Quaternion().setFromAxisAngle(axisVec as THREE.Vector3, angle);
              cur.multiply(delta);
              const euler = new THREE.Euler().setFromQuaternion(cur);
              onUpdate(id, { rotation: [euler.x, euler.y, euler.z] });
            };
            return (
              <div key={label} className="wb-rotate-row">
                <span className="wb-rotate-label" style={{ color }}>{label}</span>
                <button
                  className="wb-rotate-btn"
                  onClick={() => localRotate(-Math.PI / 4)}
                >↺</button>
                <button
                  className="wb-rotate-btn"
                  onClick={() => localRotate(Math.PI / 4)}
                >↻</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="wb-float-section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <span className="wb-float-label" style={{ margin: 0 }}>缩放</span>
          <button
            className="wb-scale-lock"
            onClick={() => setScaleLocked(!scaleLocked)}
            title={scaleLocked ? "展开单轴缩放" : "收起"}
          >
            {scaleLocked ? "▾" : "▴"}
          </button>
        </div>
        {scaleLocked ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              className="wb-scale-slider"
              type="range"
              min={0.1}
              max={5}
              step="any"
              value={scale[0]}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                onUpdate(id, { scale: [v, v, v] });
              }}
            />
            <span className="wb-scale-value">{scale[0].toFixed(1)}</span>
          </div>
        ) : (
          <>
            {([
              [0, "X", "#e55"],
              [1, "Y", "#5b5"],
              [2, "Z", "#55e"],
            ] as const).map(([axis, label, color]) => (
              <div key={axis} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                <span style={{ color, fontSize: "calc(11px*var(--app-text-scale,1))", width: 14, textAlign: "center" }}>{label}</span>
                <input
                  className="wb-scale-slider"
                  type="range"
                  min={0.05}
                  max={5}
                  step="any"
                  value={scale[axis]}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    const s: [number, number, number] = [...scale];
                    s[axis] = v;
                    onUpdate(id, { scale: s });
                  }}
                />
                <span className="wb-scale-value">{scale[axis].toFixed(2)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* 灯光参数 */}
      {selected.light && (
        <div className="wb-float-section">
          <span className="wb-float-label">灯光</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)" }}>颜色</span>
            <input
              type="color"
              value={selected.light.color}
              onChange={(e) => onUpdate(id, { light: { ...selected.light!, color: e.target.value } })}
              style={{ width: 28, height: 20, border: "none", background: "none", cursor: "pointer" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", width: 28 }}>强度</span>
            <input className="wb-scale-slider" type="range" min={0} max={50} step="any"
              value={selected.light.intensity}
              onChange={(e) => onUpdate(id, { light: { ...selected.light!, intensity: parseFloat(e.target.value) } })}
            />
            <span className="wb-scale-value">{selected.light.intensity}</span>
          </div>
          {(selected.light.type === "point" || selected.light.type === "spot") && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", width: 28 }}>范围</span>
              <input className="wb-scale-slider" type="range" min={1} max={50} step={1}
                value={selected.light.range}
                onChange={(e) => onUpdate(id, { light: { ...selected.light!, range: parseInt(e.target.value) } })}
              />
              <span className="wb-scale-value">{selected.light.range}</span>
            </div>
          )}
          {selected.light.type === "spot" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", width: 28 }}>锥角</span>
                <input className="wb-scale-slider" type="range" min={5} max={90} step={5}
                  value={Math.round(selected.light.angle / Math.PI * 180)}
                  onChange={(e) => onUpdate(id, { light: { ...selected.light!, angle: parseInt(e.target.value) / 180 * Math.PI } })}
                />
                <span className="wb-scale-value">{Math.round(selected.light.angle / Math.PI * 180)}°</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", width: 28 }}>柔和</span>
                <input className="wb-scale-slider" type="range" min={0} max={100} step={5}
                  value={Math.round(selected.light.penumbra * 100)}
                  onChange={(e) => onUpdate(id, { light: { ...selected.light!, penumbra: parseInt(e.target.value) / 100 } })}
                />
                <span className="wb-scale-value">{Math.round(selected.light.penumbra * 100)}%</span>
              </div>
            </>
          )}
          {selected.light.type === "area" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", width: 28 }}>宽</span>
                <input className="wb-scale-slider" type="range" min={0.5} max={10} step="any"
                  value={selected.light.width}
                  onChange={(e) => onUpdate(id, { light: { ...selected.light!, width: parseFloat(e.target.value) } })}
                />
                <span className="wb-scale-value">{selected.light.width}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", width: 28 }}>高</span>
                <input className="wb-scale-slider" type="range" min={0.5} max={10} step="any"
                  value={selected.light.height}
                  onChange={(e) => onUpdate(id, { light: { ...selected.light!, height: parseFloat(e.target.value) } })}
                />
                <span className="wb-scale-value">{selected.light.height}</span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="wb-float-section">
        <button
          className="wb-array-toggle"
          onClick={() => setShowArray(!showArray)}
        >
          阵列 {showArray ? "▴" : "▾"}
        </button>
        {showArray && (
          <div className="wb-array-panel">
            <div className="wb-array-row">
              <span className="wb-float-label">轴向</span>
              <div className="wb-array-axis">
                {([
                  [0, "X", "#e55"],
                  [1, "Y", "#5b5"],
                  [2, "Z", "#55e"],
                ] as const).map(([a, label, color]) => (
                  <button
                    key={a}
                    className={`wb-axis-btn ${arrayAxis === a ? "active" : ""}`}
                    style={arrayAxis === a ? { borderColor: color, color } : {}}
                    onClick={() => setArrayAxis(a)}
                  >{label}</button>
                ))}
              </div>
            </div>
            <div className="wb-array-row">
              <span className="wb-float-label">数量</span>
              <input
                type="range"
                className="wb-scale-slider"
                min={2}
                max={20}
                step={1}
                value={arrayCount}
                onChange={(e) => setArrayCount(parseInt(e.target.value))}
              />
              <span className="wb-scale-value">{arrayCount}</span>
            </div>
            <div className="wb-array-row">
              <span className="wb-float-label">间距</span>
              <input
                type="number"
                className="wb-spacing-input"
                value={spacingInput}
                onChange={(e) => {
                  spacingEditedRef.current = true;
                  setSpacingInput(e.target.value);
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v)) setArraySpacing(v);
                }}
              />
            </div>
            <button
              className="wb-array-apply"
              onClick={() => {
                onArray(id, arrayAxis, arrayCount, arraySpacing);
                setShowArray(false);
              }}
            >
              生成阵列
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
