// 在每个测试文件求值之前注入内存版 IndexedDB。
// kv-db 在模块顶层就 `new Dexie("AiPhoneKvDB")`，因此这个 import 必须先于
// 任何 @/lib/kv-db 的引用执行；vitest 会先跑 setupFiles，再载入测试文件。
// 它是纯内存实现，与浏览器里的真实库完全隔离，进程结束即消失。
import "fake-indexeddb/auto";
