import { describe, it, expect, afterAll } from "vitest";
import { listMemoryCards, purgeNarrativeSessionData, saveMemoryCard } from "@/lib/narrative-writer/storage";
import type { ConfidenceLevel, MemoryCard } from "@/lib/narrative-writer/types";

// 冒烟：证明 Dexie + fake-indexeddb 在 Node 里能跑通一条真实的写入/读回链路。
// 注意：本测试只证明“Dexie 能写进 fake IDB 并被读回”，不代表浏览器的
// hydrate / 跨刷新持久化被覆盖——那条在 Node 里被 typeof window 守卫短路了。

const SID = "testsmoke_session_01";

function makeCard(id: string): MemoryCard {
  const now = Date.now();
  return {
    id,
    kind: "memory",
    主体: "角色",
    主类型: "经历节点",
    内容: "冒烟测试：图书馆初见",
    作用域: "戏内层",
    置信档: "高" as ConfidenceLevel,
    置信度: 0.9,
    状态: "生效",
    证据: "冒烟测试：图书馆初见",
    来源轮次: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** 绕过 kv-db 的内存缓存，直接读底层 IndexedDB，证明数据真的经过 Dexie 落库。 */
function readRawFromIdb(key: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("AiPhoneKvDB");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("entries", "readonly");
      const get = tx.objectStore("entries").get(key);
      get.onsuccess = () => {
        const row = get.result as { key: string; value: string } | undefined;
        resolve(row ? row.value : null);
      };
      get.onerror = () => reject(get.error);
    };
  });
}

afterAll(async () => {
  purgeNarrativeSessionData(SID);
  // 让 kv-db 的 fire-and-forget 删除落定，避免进程退出时留下未完成事务的告警
  await new Promise((r) => setTimeout(r, 20));
});

describe("smoke: Dexie + fake-indexeddb 在 Node 下可用", () => {
  it("写入一张记忆卡：内存缓存可读回，且底层 IndexedDB 确有该键", async () => {
    await saveMemoryCard(SID, makeCard("testsmoke_m1"));

    const list = await listMemoryCards(SID);
    expect(list.map((c) => c.id)).toContain("testsmoke_m1");
    expect(list[0]?.内容).toBe("冒烟测试：图书馆初见");

    const raw = await readRawFromIdb(`narrative:${SID}:memory:testsmoke_m1`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).id).toBe("testsmoke_m1");
  });
});
