type ThreadableComment = {
  id: string;
  createdAt: string;
  replyToCommentId?: string;
};

export type TwoLevelMomentThread<T extends ThreadableComment> = {
  root: T;
  replies: T[];
};

function findThreadRootId<T extends ThreadableComment>(
  comment: T,
  commentMap: Map<string, T>,
): string {
  if (!comment.replyToCommentId) return comment.id;

  let current = comment;
  const seen = new Set<string>([comment.id]);

  while (current.replyToCommentId) {
    const parent = commentMap.get(current.replyToCommentId);
    if (!parent || seen.has(parent.id)) return comment.id;
    if (!parent.replyToCommentId) return parent.id;
    seen.add(parent.id);
    current = parent;
  }

  return current.id;
}

function isAncestorComment<T extends ThreadableComment>(
  ancestor: T,
  comment: T,
  commentMap: Map<string, T>,
): boolean {
  let current = comment;
  const seen = new Set<string>([comment.id]);

  while (current.replyToCommentId) {
    const parent = commentMap.get(current.replyToCommentId);
    if (!parent || seen.has(parent.id)) return false;
    if (parent.id === ancestor.id) return true;
    seen.add(parent.id);
    current = parent;
  }

  return false;
}

export function buildTwoLevelMomentThreads<T extends ThreadableComment>(
  comments: T[],
): TwoLevelMomentThread<T>[] {
  const commentMap = new Map(comments.map((comment) => [comment.id, comment]));
  const originalIndex = new Map(comments.map((comment, index) => [comment.id, index]));
  const sorted = [...comments].sort((a, b) => {
    const timeOrder = a.createdAt.localeCompare(b.createdAt);
    if (timeOrder !== 0) return timeOrder;
    if (isAncestorComment(a, b, commentMap)) return -1;
    if (isAncestorComment(b, a, commentMap)) return 1;
    return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
  });
  const roots: T[] = [];
  const repliesByRoot = new Map<string, T[]>();

  for (const comment of sorted) {
    const rootId = findThreadRootId(comment, commentMap);
    if (rootId === comment.id) {
      roots.push(comment);
      continue;
    }
    const replies = repliesByRoot.get(rootId);
    if (replies) {
      replies.push(comment);
    } else {
      repliesByRoot.set(rootId, [comment]);
    }
  }

  return roots.map((root) => ({
    root,
    replies: repliesByRoot.get(root.id) ?? [],
  }));
}
