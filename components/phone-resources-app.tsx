"use client";

import { useEffect, useState } from "react";
import { Brain, MoreHorizontal, Sparkles } from "lucide-react";
import { MemoryBankPage } from "./memory/memory-bank-page";
import { VnAssetPage } from "./vn/vn-asset-page";
import { loadCharacters } from "@/lib/character-storage";
import { PageShell } from "./ui/page-shell";
import { FeaturedCard, type FeaturedCardItem } from "./ui/card-grid";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";

export type ResourceSubPage = "main" | "memory" | "vn_assets";
type MemoryView = "list" | "detail" | "settings";

const RESOURCE_MENU: Omit<FeaturedCardItem, "onClick">[] = [
    {
        id: "memory",
        icon: Brain,
        label: "记忆库",
        desc: "角色记忆档案",
        iconColor: BINDING_ACCENTS.memory,
        glassIcon: "memory",
    },
    {
        id: "vn_assets",
        icon: Sparkles,
        label: "漫卷资源",
        desc: "场景与角色立绘",
        iconColor: CONTENT_APP_ACCENTS.vn,
        glassIcon: "vn-assets",
    },
];

export function PhoneResourcesApp({ onClose, onNotice, initialPage }: { onClose: () => void; onNotice?: (msg: string) => void; initialPage?: ResourceSubPage }) {
    const [currentPage, setCurrentPage] = useState<ResourceSubPage>(initialPage ?? "main");
    const [memoryView, setMemoryView] = useState<MemoryView>("list");
    const [prevMemoryView, setPrevMemoryView] = useState<MemoryView>("list");
    const [memoryCharId, setMemoryCharId] = useState<string>("");
    const [memoryCharName, setMemoryCharName] = useState<string>("");

    useEffect(() => {
        if (initialPage) setCurrentPage(initialPage);
    }, [initialPage]);

    const handleBack = () => {
        if (currentPage === "memory") {
            if (memoryView === "settings") {
                setMemoryView(prevMemoryView);
            } else if (memoryView === "detail") {
                setMemoryView("list");
            } else {
                setCurrentPage("main");
                setMemoryView("list");
                setMemoryCharId("");
                setMemoryCharName("");
            }
        } else if (currentPage === "vn_assets") {
            setCurrentPage("main");
        } else if (currentPage !== "main") {
            setCurrentPage("main");
        } else {
            onClose();
        }
    };

    const handleSelectChar = (charId: string) => {
        const chars = loadCharacters();
        const char = chars.find(c => c.id === charId);
        setMemoryCharId(charId);
        setMemoryCharName(char?.name ?? "");
        setMemoryView("detail");
    };

    const title = currentPage === "main" ? "资源库"
        : currentPage === "memory"
            ? (memoryView === "settings" ? "记忆设置"
                : memoryView === "detail" ? (memoryCharName || "记忆详情")
                    : "记忆库")
            : currentPage === "vn_assets" ? "漫卷资源"
                : "资源库";

    const showSettingsIcon = currentPage === "memory" && memoryView !== "settings";

    return (
        <PageShell
            title={title}
            onBack={handleBack}
            className={currentPage === "memory" && memoryView === "detail" ? "mem-detail" : undefined}
            rightAction={showSettingsIcon ? (
                <button
                    onClick={() => { setPrevMemoryView(memoryView); setMemoryView("settings"); }}
                    className="page-back-btn"
                    type="button"
                    aria-label="更多"
                >
                    <MoreHorizontal size={22} strokeWidth={1.5} />
                </button>
            ) : undefined}
        >
            <div
                className="flex-1 relative"
                style={{
                    overflowY: currentPage === "memory" && memoryView === "detail" ? "hidden" : "auto"
                }}
            >
                {currentPage === "main" && (
                    <div className="page-menu">
                        <div>
                            <h3 className="settings-menu-section-title">Resources</h3>
                            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
                                {RESOURCE_MENU.map((item) => (
                                    <FeaturedCard
                                        key={item.id}
                                        item={{
                                            ...item,
                                            onClick: () => setCurrentPage(item.id === "vn_assets" ? "vn_assets" : "memory"),
                                        }}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {currentPage === "vn_assets" && (
                    <VnAssetPage onNotice={onNotice} />
                )}

                {currentPage === "memory" && (
                    <MemoryBankPage
                        view={memoryView}
                        selectedCharId={memoryCharId}
                        onSelectChar={handleSelectChar}
                        onNotice={onNotice}
                    />
                )}
            </div>
        </PageShell>
    );
}
