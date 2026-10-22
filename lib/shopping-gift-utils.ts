import { loadChatMessages, loadChatSessions } from "./chat-storage";
import { loadShoppingState } from "./shopping-storage";
import type { ShoppingOrder } from "./shopping-types";
import type { CheckPhoneShoppingTone } from "./checkphone-config";

export type ShoppingGiftCandidate = {
  id: string;
  orderId: string;
  itemId: string;
  unitIndex: number;
  productName: string;
  merchantLabel: string;
  priceLabel: string;
  quantityLabel: string;
  subtitle: string;
  detail: string;
  previewIcon: string;
  tone: CheckPhoneShoppingTone;
  deliveredAt?: string;
  deliveredTimeLabel?: string;
  orderTimeLabel: string;
};

type LoadShoppingGiftOptions = {
  includeSent?: boolean;
  nowMs?: number;
};

function parseGiftQuantity(label?: string): number {
  const match = String(label ?? "").match(/\d+/);
  const amount = match ? Number(match[0]) : 1;
  if (!Number.isFinite(amount)) return 1;
  return Math.min(50, Math.max(1, Math.round(amount)));
}

function parseTimestamp(value?: string): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getDeliveredEvent(order: ShoppingOrder) {
  return order.shippingTimeline?.find(event => event.status === "delivered");
}

function isOrderDelivered(order: ShoppingOrder, nowMs: number): boolean {
  const deliveredEvent = getDeliveredEvent(order);
  if (deliveredEvent) {
    const deliveredMs = parseTimestamp(deliveredEvent.timestamp);
    return deliveredMs > 0 && deliveredMs <= nowMs;
  }
  return /已到货|已签收|已完成/.test(order.statusLabel);
}

export function loadSentShoppingGiftIds(): Set<string> {
  const sentIds = new Set<string>();
  for (const session of loadChatSessions()) {
    for (const message of loadChatMessages(session.id)) {
      if (message.mediaType !== "gift") continue;
      const giftId = message.mediaData?.shoppingGiftId;
      if (giftId) sentIds.add(giftId);
    }
  }
  return sentIds;
}

export function loadDeliveredShoppingGifts(options: LoadShoppingGiftOptions = {}): ShoppingGiftCandidate[] {
  const nowMs = options.nowMs ?? Date.now();
  const sentIds = options.includeSent ? new Set<string>() : loadSentShoppingGiftIds();
  const state = loadShoppingState();
  const gifts: ShoppingGiftCandidate[] = [];

  for (const order of state.orders) {
    if (!isOrderDelivered(order, nowMs)) continue;
    const deliveredEvent = getDeliveredEvent(order);

    order.items.forEach((item, itemIndex) => {
      const quantity = parseGiftQuantity(item.quantityLabel);
      for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
        const giftId = `${order.id}::${item.id || itemIndex}::${unitIndex}`;
        if (sentIds.has(giftId)) continue;
        gifts.push({
          id: giftId,
          orderId: order.id,
          itemId: item.id || `${itemIndex}`,
          unitIndex,
          productName: item.title,
          merchantLabel: item.merchantLabel || order.merchantLabel,
          priceLabel: item.priceLabel,
          quantityLabel: quantity > 1 ? `第 ${unitIndex}/${quantity} 件` : item.quantityLabel || "x 1",
          subtitle: item.subtitle,
          detail: item.detail,
          previewIcon: item.previewIcon,
          tone: item.tone,
          deliveredAt: deliveredEvent?.timestamp,
          deliveredTimeLabel: deliveredEvent?.timeLabel,
          orderTimeLabel: order.timeLabel,
        });
      }
    });
  }

  return gifts.sort((a, b) => {
    const timeDiff = parseTimestamp(b.deliveredAt) - parseTimestamp(a.deliveredAt);
    if (timeDiff !== 0) return timeDiff;
    return b.orderId.localeCompare(a.orderId);
  });
}
