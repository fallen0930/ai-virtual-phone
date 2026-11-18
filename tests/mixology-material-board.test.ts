import { beforeEach, describe, expect, it } from "vitest";

// 重点材料内容常驻板（2026-11-12）
//
// 工具回执 >900 字就会被 compactToolHistory 折叠成 160 字摘要。
// 材料正文动辄 2000~8000 字，读完一轮下一轮就只剩摘要，模型想改第二段就得重读——
// 重读又是新一轮 LLM 调用。34 次调用里至少一半是这么来的。
//
// 现在读取/创建/更新材料时，把正文 pin 进这块板，引擎每轮注入系统提示词：
// 不折叠、不占历史窗口。板有总预算，超了按 LRU 淘汰最旧。

import {
    buildMixMaterialBoardPrompt,
    listPinnedMaterialIds,
    MIX_MATERIAL_BOARD_BUDGET,
    pinMixMaterial,
    resetMixMaterialBoard,
    unpinMixMaterial,
} from "@/lib/mixology/material-board";

describe("重点材料内容常驻板", () => {
    beforeEach(() => {
        resetMixMaterialBoard();
    });

    it("空板不生成任何提示词", () => {
        expect(buildMixMaterialBoardPrompt()).toBe("");
        expect(listPinnedMaterialIds()).toEqual([]);
    });

    it("pin 一件材料后，提示词包含该材料的完整内容", () => {
        const content = "这是一段很长的正文，".repeat(100);
        pinMixMaterial("mixmat_abc", "base", "纯白造物", content);

        const prompt = buildMixMaterialBoardPrompt();
        expect(prompt).toContain("纯白造物");
        expect(prompt).toContain("mixmat_abc");
        expect(prompt).toContain(content);
        expect(prompt).toContain("本轮正在编辑的材料");
        expect(listPinnedMaterialIds()).toEqual(["mixmat_abc"]);
    });

    it("pin 多件材料，提示词按插入顺序排列", () => {
        pinMixMaterial("mixmat_1", "base", "基底一", "内容一");
        pinMixMaterial("mixmat_2", "character", "角色二", "内容二");

        const prompt = buildMixMaterialBoardPrompt();
        const pos1 = prompt.indexOf("基底一");
        const pos2 = prompt.indexOf("角色二");
        expect(pos1).toBeGreaterThan(-1);
        expect(pos2).toBeGreaterThan(pos1);
        expect(listPinnedMaterialIds()).toEqual(["mixmat_1", "mixmat_2"]);
    });

    it("重读同一件材料会续期（移到队尾），不重复添加", () => {
        pinMixMaterial("mixmat_1", "base", "基底一", "内容一");
        pinMixMaterial("mixmat_2", "character", "角色二", "内容二");
        // 重读第一件，应该续期到队尾
        pinMixMaterial("mixmat_1", "base", "基底一", "内容一（更新）");

        const ids = listPinnedMaterialIds();
        expect(ids).toEqual(["mixmat_2", "mixmat_1"]);
        // 内容也更新了
        expect(buildMixMaterialBoardPrompt()).toContain("内容一（更新）");
    });

    it("超预算时按 LRU 淘汰最旧的材料", () => {
        // 预算 25000 字，每件 10000 字，第三件进来时（总 30000）第一件应该被淘汰
        const longContent = "字".repeat(10000);
        pinMixMaterial("mixmat_1", "base", "基底一", longContent);
        pinMixMaterial("mixmat_2", "character", "角色二", longContent);
        expect(listPinnedMaterialIds()).toEqual(["mixmat_1", "mixmat_2"]);

        const result = pinMixMaterial("mixmat_3", "flavor", "风味三", longContent);
        expect(result.evicted).toContain("基底「基底一」");
        expect(listPinnedMaterialIds()).toEqual(["mixmat_2", "mixmat_3"]);
    });

    it("至少保留一件材料，即使单件超预算", () => {
        const hugeContent = "字".repeat(MIX_MATERIAL_BOARD_BUDGET + 1000);
        const result = pinMixMaterial("mixmat_huge", "base", "超大材料", hugeContent);

        expect(result.pinned).toBe(true);
        expect(listPinnedMaterialIds()).toEqual(["mixmat_huge"]);
        expect(buildMixMaterialBoardPrompt()).toContain("超大材料");
    });

    it("unpin 可以主动移除指定材料", () => {
        pinMixMaterial("mixmat_1", "base", "基底一", "内容一");
        pinMixMaterial("mixmat_2", "character", "角色二", "内容二");
        unpinMixMaterial("mixmat_1");

        expect(listPinnedMaterialIds()).toEqual(["mixmat_2"]);
        expect(buildMixMaterialBoardPrompt()).not.toContain("基底一");
    });

    it("reset 清空整块板", () => {
        pinMixMaterial("mixmat_1", "base", "基底一", "内容一");
        pinMixMaterial("mixmat_2", "character", "角色二", "内容二");
        resetMixMaterialBoard();

        expect(listPinnedMaterialIds()).toEqual([]);
        expect(buildMixMaterialBoardPrompt()).toBe("");
    });

    it("空 id 不 pin", () => {
        const result = pinMixMaterial("", "base", "无名", "内容");
        expect(result.pinned).toBe(false);
        expect(listPinnedMaterialIds()).toEqual([]);
    });
});
