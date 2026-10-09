// lib/moments-db.ts
// IndexedDB persistence layer for Moments (朋友圈) posts & comments via Dexie.js.
// Per-record rows behind the synchronous in-memory cache in moments-storage.ts,
// replacing the previous monolithic kv JSON blobs (which rewrote the whole
// array on every like/comment). Same pattern as chat-db.ts.

import Dexie from "dexie";
import type { MomentPost, MomentComment } from "./moments-types";

class MomentsDatabase extends Dexie {
    posts!: Dexie.Table<MomentPost, string>;
    comments!: Dexie.Table<MomentComment, string>;

    constructor() {
        super("AiPhoneMomentsDB");
        this.version(1).stores({
            posts: "id, authorId, createdAt",
            comments: "id, postId, createdAt",
        });
    }
}

export const momentsDb = new MomentsDatabase();

/** Load all posts & comments for the in-memory caches. No legacy migration. */
export async function initMomentsDb(): Promise<{ posts: MomentPost[]; comments: MomentComment[] }> {
    if (typeof window === "undefined") return { posts: [], comments: [] };
    try {
        const [posts, comments] = await Promise.all([
            // Newest-first, to match the runtime invariant: addMomentPost unshifts,
            // and the feed / action-parser assume loadMomentPosts() is newest-first.
            // Plain toArray() would return primary-key (id) order = oldest-first.
            momentsDb.posts.orderBy("createdAt").reverse().toArray(),
            momentsDb.comments.toArray(),
        ]);
        return { posts, comments };
    } catch (err) {
        console.warn("[MomentsDB] load failed:", err);
        return { posts: [], comments: [] };
    }
}

// ── Per-record persistence (fire-and-forget) ──

export function dbPutPost(post: MomentPost): void {
    momentsDb.posts.put(post).catch(err => console.warn("[MomentsDB] put post failed:", err));
}

export function dbDeletePost(id: string): void {
    momentsDb.posts.delete(id).catch(err => console.warn("[MomentsDB] delete post failed:", err));
}

export function dbPutComment(comment: MomentComment): void {
    momentsDb.comments.put(comment).catch(err => console.warn("[MomentsDB] put comment failed:", err));
}

export function dbDeleteComment(id: string): void {
    momentsDb.comments.delete(id).catch(err => console.warn("[MomentsDB] delete comment failed:", err));
}

export function dbDeleteCommentsByPost(postId: string): void {
    momentsDb.comments.where("postId").equals(postId).delete()
        .catch(err => console.warn("[MomentsDB] delete post comments failed:", err));
}

// ── Whole-collection replace (for the array-level save APIs) ──

export function dbReplacePosts(posts: MomentPost[]): void {
    momentsDb.transaction("rw", momentsDb.posts, async () => {
        await momentsDb.posts.clear();
        await momentsDb.posts.bulkPut(posts);
    }).catch(err => console.warn("[MomentsDB] replace posts failed:", err));
}
