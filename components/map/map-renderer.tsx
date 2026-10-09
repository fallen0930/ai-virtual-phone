"use client";
import { useState, useRef, useCallback } from "react";
import type { MapGenerationOutput } from "@/lib/map-engine";

type Props = {
  data: MapGenerationOutput;
  currentNodeId?: string;
  selectedNodeId?: string | null;
  discoveredNodes?: string[];
  visitedNodes?: string[];
  agentPositions?: { nodeId: string; name: string; avatar?: string }[];
  playerAvatar?: string; // user avatar URL
  playerName?: string;
  onNodeClick?: (nodeId: string) => void;
};

export default function MapRenderer({ data, currentNodeId, selectedNodeId, discoveredNodes, visitedNodes, agentPositions, playerAvatar, playerName, onNodeClick }: Props) {
  const vw = data.gridWidth * data.scale;
  const vh = data.gridHeight * data.scale;

  // Pan & zoom via viewBox manipulation (works with SVG filters)
  const [zoom, setZoom] = useState(2.5); // higher = more zoomed in
  const [viewCenter, setViewCenter] = useState({ x: vw * 0.5, y: vh * 0.4 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const lastDist = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute viewBox from zoom + center
  const viewW = vw / zoom, viewH = vh / zoom;
  const vbX = viewCenter.x - viewW / 2;
  const vbY = viewCenter.y - viewH / 2;
  const viewBox = `${vbX.toFixed(0)} ${vbY.toFixed(0)} ${viewW.toFixed(0)} ${viewH.toFixed(0)}`;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    // Convert screen pixels to SVG units
    const svgPerPxX = viewW / rect.width;
    const svgPerPxY = viewH / rect.height;
    setViewCenter(c => ({ x: c.x - dx * svgPerPxX, y: c.y - dy * svgPerPxY }));
  }, [viewW, viewH]);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Pinch zoom
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (lastDist.current > 0) {
        const delta = dist / lastDist.current;
        setZoom(z => Math.max(0.8, Math.min(6, z * delta)));
      }
      lastDist.current = dist;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    lastDist.current = 0;
  }, []);

  // Scroll wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.8, Math.min(6, z * delta)));
  }, []);

  return (
    <div style={{
      position: "absolute", inset: 0,
      background: "#6e8d8f",
      overflow: "hidden", touchAction: "none",
      fontFamily: "'Noto Serif SC', 'Cinzel', serif",
      color: "#2c2522",
    }}
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onWheel={handleWheel}
    >
      {/* Grid overlay */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
        backgroundSize: "100px 100px",
      }} />

      {/* Header */}
      <div style={{
        position: "absolute", top: 20, left: 20, zIndex: 20,
        fontSize: "calc(10px*var(--app-text-scale,1))", letterSpacing: "0.3em",
        color: "rgba(255,255,255,0.6)",
        fontFamily: "monospace",
      }}>
        {data.header}
      </div>

      {/* Title */}
      <div style={{
        position: "absolute", bottom: 20, left: 20, zIndex: 20,
        fontSize: "calc(14px*var(--app-text-scale,1))", letterSpacing: "0.3em",
        color: "#e0e0ce",
        borderBottom: "1px solid rgba(255,255,255,0.3)",
        paddingBottom: 4,
      }}>
        {data.title}
      </div>

      {/* Map SVG — viewBox controls zoom & pan */}
      <svg
        viewBox={viewBox}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 2 }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Lightweight glow only — no heavy feMorphology/feTurbulence */}
          <filter id="glow-soft">
            <feGaussianBlur stdDeviation="2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Map layer */}
        <g>
          {/* Outer contour (continent shape) */}
          {data.outerContourPath && (
            <path d={data.outerContourPath} fill="#e0e0ce" stroke="none" />
          )}

          {/* Region fills */}
          {data.regionPaths.map((r, i) => (
            <path key={i} d={r.path} fill={r.color}
              stroke="rgba(101,91,84,0.4)" strokeWidth="1.2" strokeDasharray="6 4"
              opacity="0.9" style={{ cursor: "pointer" }}
            />
          ))}

          {/* Topo heightmap dots — disabled for mobile performance */}

          {/* Contour lines */}
          {data.contourPath && (
            <path d={data.contourPath} fill="none"
              stroke="rgba(0,0,0,0.08)" strokeWidth="1.2"
              style={{ mixBlendMode: "multiply", pointerEvents: "none" }}
            />
          )}

          {/* Lakes */}
          {data.lakes.map((l, i) => (
            <path key={i} d={l.path} fill="#74b9ff" stroke="#0984e3" strokeWidth="1" />
          ))}

          {/* Rivers */}
          {data.rivers.map((r, i) => (
            <path key={i} d={r.path} fill="none" stroke="#74b9ff"
              strokeWidth={r.width} strokeLinecap="round" strokeLinejoin="round"
            />
          ))}
        </g>

        {/* Lines layer (outside filter) */}
        <g>
          {/* Trunk routes (L1-L1) */}
          {data.trunkRoutes.map((r, i) => (
            <path key={`trunk-${i}`} d={r.path} fill="none"
              stroke="#5a3e2c" strokeWidth="2" strokeDasharray="6 4"
              opacity="0.6" strokeLinecap="round" strokeLinejoin="round"
            />
          ))}
          {/* Branch L2 */}
          {data.branchL2Routes.map((r, i) => (
            <path key={`l2-${i}`} d={r.path} fill="none"
              stroke="#7b5840" strokeWidth="1.2" strokeDasharray="3 4"
              opacity="0.5" strokeLinecap="round"
            />
          ))}
          {/* Branch L3 */}
          {data.branchL3Routes.map((r, i) => (
            <path key={`l3-${i}`} d={r.path} fill="none"
              stroke="#997860" strokeWidth="0.8" strokeDasharray="2 3"
              opacity="0.4"
            />
          ))}
        </g>

        {/* Nodes layer */}
        <g>
          {data.l1Nodes.map((n, i) => {
            const id = n.id;
            const visible = !discoveredNodes || discoveredNodes.includes(id);
            if (!visible) return null;
            const isCurrent = currentNodeId === id;
            const isSelected = selectedNodeId === id;
            return (
              <g key={`l1-${i}`} onClick={() => onNodeClick?.(id)} style={{ cursor: onNodeClick ? "pointer" : undefined }}>
                {/* Invisible hit area for easier tapping */}
                <circle cx={n.x} cy={n.y} r="20" fill="transparent" />
                {isCurrent && <circle cx={n.x} cy={n.y} r="14" fill="none" stroke="#e8d0a0" strokeWidth="1.5" opacity="0.6">
                  <animate attributeName="opacity" values="0.6;0.2;0.6" dur="2s" repeatCount="indefinite" />
                </circle>}
                {isSelected && !isCurrent && <circle cx={n.x} cy={n.y} r="13" fill="none" stroke="rgba(255,220,150,0.5)" strokeWidth="1" strokeDasharray="3 3" />}
                <circle cx={n.x} cy={n.y} r="7" fill="#222" stroke="#eee" strokeWidth="2" />
                <circle cx={n.x} cy={n.y} r="2.5" fill="#eed" />
              </g>
            );
          })}
          {data.l2Nodes.map((n, i) => {
            const id = `l2_${i}`;
            const visible = !discoveredNodes || discoveredNodes.includes(id);
            if (!visible) return null;
            const isSelected = selectedNodeId === id;
            return (
              <g key={`l2-${i}`} onClick={() => onNodeClick?.(id)} style={{ cursor: onNodeClick ? "pointer" : undefined }}>
                <circle cx={n.x} cy={n.y} r="15" fill="transparent" />
                {isSelected && <circle cx={n.x} cy={n.y} r="9" fill="none" stroke="rgba(255,220,150,0.5)" strokeWidth="1" strokeDasharray="2 3" />}
                <circle cx={n.x} cy={n.y} r="4.5" fill="#333" stroke="#eee" strokeWidth="1.2" />
              </g>
            );
          })}
          {data.l3Nodes.map((n, i) => {
            const id = `l3_${i}`;
            const visible = !discoveredNodes || discoveredNodes.includes(id);
            if (!visible) return null;
            return (
              <g key={`l3-${i}`} onClick={() => onNodeClick?.(id)} style={{ cursor: onNodeClick ? "pointer" : undefined }}>
                <circle cx={n.x} cy={n.y} r="12" fill="transparent" />
                <circle cx={n.x} cy={n.y} r="2.5" fill="#555" />
              </g>
            );
          })}
        </g>
        {/* Player avatar marker */}
        {currentNodeId && (() => {
          const l1 = data.l1Nodes.find(n => n.id === currentNodeId);
          const l2Idx = currentNodeId.startsWith("l2_") ? parseInt(currentNodeId.slice(3)) : -1;
          const l3Idx = currentNodeId.startsWith("l3_") ? parseInt(currentNodeId.slice(3)) : -1;
          const l2 = l2Idx >= 0 ? data.l2Nodes[l2Idx] : null;
          const l3 = l3Idx >= 0 ? data.l3Nodes[l3Idx] : null;
          const x = l1?.x ?? l2?.x ?? l3?.x;
          const y = l1?.y ?? l2?.y ?? l3?.y;
          if (x == null || y == null) return null;
          const px = x, py = y - 20; // above the node
          return (
            <g>
              {/* Pulse ring */}
              <circle cx={px} cy={py} r="14" fill="none" stroke="#e8d0a0" strokeWidth="1" opacity="0.4">
                <animate attributeName="r" values="14;20;14" dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.4;0.1;0.4" dur="2s" repeatCount="indefinite" />
              </circle>
              {/* Avatar circle */}
              <clipPath id="player-avatar-clip">
                <circle cx={px} cy={py} r="10" />
              </clipPath>
              {playerAvatar ? (
                <image href={playerAvatar} x={px - 10} y={py - 10} width="20" height="20" clipPath="url(#player-avatar-clip)" />
              ) : (
                <circle cx={px} cy={py} r="10" fill="#e8d0a0" />
              )}
              <circle cx={px} cy={py} r="10" fill="none" stroke="#e8d0a0" strokeWidth="1.5" />
              {/* Name */}
              <text x={px} y={py + 18} textAnchor="middle" fontSize="8" fill="#e8d0a0" fontWeight="600">
                {playerName || "我"}
              </text>
            </g>
          );
        })()}

        {/* Agent position markers */}
        {agentPositions && agentPositions.length > 0 && (
          <g>
            {agentPositions.map((ap, i) => {
              // Find node coordinates
              const l1 = data.l1Nodes.find(n => n.id === ap.nodeId);
              const l2Idx = ap.nodeId.startsWith("l2_") ? parseInt(ap.nodeId.slice(3)) : -1;
              const l3Idx = ap.nodeId.startsWith("l3_") ? parseInt(ap.nodeId.slice(3)) : -1;
              const l2 = l2Idx >= 0 ? data.l2Nodes[l2Idx] : null;
              const l3 = l3Idx >= 0 ? data.l3Nodes[l3Idx] : null;
              const x = l1?.x ?? l2?.x ?? l3?.x ?? 0;
              const y = l1?.y ?? l2?.y ?? l3?.y ?? 0;
              if (!x && !y) return null;
              // Offset slightly so multiple agents don't overlap
              const ox = (i % 3 - 1) * 12;
              const oy = -18 + Math.floor(i / 3) * -10;
              const r = 10;
              return (
                <g key={`agent-${i}`}>
                  {ap.avatar ? (
                    <>
                      <defs>
                        <clipPath id={`agent-clip-${i}`}>
                          <circle cx={x + ox} cy={y + oy} r={r} />
                        </clipPath>
                      </defs>
                      <image
                        href={ap.avatar}
                        x={x + ox - r} y={y + oy - r}
                        width={r * 2} height={r * 2}
                        clipPath={`url(#agent-clip-${i})`}
                        preserveAspectRatio="xMidYMid slice"
                      />
                      <circle cx={x + ox} cy={y + oy} r={r} fill="none" stroke="#e8d0a0" strokeWidth="1.5" />
                    </>
                  ) : (
                    <>
                      <circle cx={x + ox} cy={y + oy} r={r} fill="#e8d0a0" stroke="#0a0a0f" strokeWidth="1.5" />
                      <text x={x + ox} y={y + oy + 3} textAnchor="middle" fontSize="8" fill="#0a0a0f" fontWeight="700">
                        {ap.name.charAt(0)}
                      </text>
                    </>
                  )}
                  <text x={x + ox + r + 3} y={y + oy + 3} fontSize="8" fill="rgba(232,208,160,0.7)" fontWeight="500">
                    {ap.name}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {/* Labels layer (inside SVG so coordinates match) — no pointer events */}
        <g pointerEvents="none">
          {/* L1 labels */}
          {data.l1Nodes.map((n, i) => (
            <g key={`l1-label-${i}`}>
              <text x={n.x} y={n.y + 26} textAnchor="middle"
                fontSize="16" fontWeight="600" fill="#2c2522" letterSpacing="2"
                fontFamily="'Cinzel', 'Noto Serif SC', serif"
              >{n.nameCn}</text>
              <text x={n.x} y={n.y + 38} textAnchor="middle"
                fontSize="9" fill="#4a413d" letterSpacing="1"
                fontFamily="'Noto Serif SC', serif"
              >{n.nameEn}</text>
            </g>
          ))}
          {/* L2 labels */}
          {data.l2Nodes.map((n, i) => (
            <text key={`l2-label-${i}`} x={n.x + 10} y={n.y - 8}
              fontSize="10" fill="#4a413d" fontStyle="italic" letterSpacing="2"
              stroke="rgba(255,255,255,0.8)" strokeWidth="2" paintOrder="stroke"
              fontFamily="'Noto Serif SC', serif"
            >{n.name}</text>
          ))}
          {/* L3 labels */}
          {data.l3Nodes.map((n, i) => (
            <text key={`l3-label-${i}`} x={n.x + 6} y={n.y - 6}
              fontSize="9" fill="#665" letterSpacing="1"
              fontFamily="monospace"
            >{n.name}</text>
          ))}
          {/* Sub-zone labels */}
          {data.subLabels.map((s, i) => (
            <text key={`sub-${i}`} x={s.x} y={s.y}
              fontSize="12" fill="rgba(0,0,0,0.3)" fontWeight="bold" letterSpacing="3"
              transform={`rotate(-15 ${s.x} ${s.y})`}
              fontFamily="'Cinzel', serif"
            >{s.name}</text>
          ))}
        </g>
      </svg>
    </div>
  );
}
