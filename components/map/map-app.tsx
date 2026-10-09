"use client";
import { useState, useCallback } from "react";
import MapLobby from "./map-lobby";
import MapView from "./map-view";
import type { MapWorld, GameSave } from "@/lib/map-types";

type View = "lobby" | "playing";

export default function MapApp({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>("lobby");
  const [activeWorld, setActiveWorld] = useState<MapWorld | null>(null);
  const [activeSave, setActiveSave] = useState<GameSave | null>(null);

  const handleStartGame = useCallback((world: MapWorld, save: GameSave) => {
    setActiveWorld(world);
    setActiveSave(save);
    setView("playing");
  }, []);

  const handleBackToLobby = useCallback(() => {
    setView("lobby");
    setActiveWorld(null);
    setActiveSave(null);
  }, []);

  if (view === "playing" && activeWorld && activeSave) {
    return (
      <MapView
        world={activeWorld}
        save={activeSave}
        onSaveUpdate={setActiveSave}
        onBack={handleBackToLobby}
      />
    );
  }

  return <MapLobby onClose={onClose} onStartGame={handleStartGame} />;
}
