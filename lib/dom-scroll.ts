type ScrollBlock = "start" | "center" | "end" | "nearest";

type ScrollWithinContainerOptions = {
    behavior?: ScrollBehavior;
    block?: ScrollBlock;
    offsetTop?: number;
};

export function scrollElementWithinContainer(
    container: HTMLElement | null | undefined,
    target: HTMLElement | null | undefined,
    options: ScrollWithinContainerOptions = {},
) {
    if (!container || !target) return;

    const behavior = options.behavior ?? "auto";
    const block = options.block ?? "nearest";
    const offsetTop = options.offsetTop ?? 0;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const currentTop = container.scrollTop;
    const visibleBottom = currentTop + container.clientHeight;
    const targetTop = currentTop + targetRect.top - containerRect.top;
    const targetBottom = targetTop + targetRect.height;

    let nextTop = targetTop;
    if (block === "center") {
        nextTop = targetTop - (container.clientHeight - targetRect.height) / 2;
    } else if (block === "end") {
        nextTop = targetBottom - container.clientHeight;
    } else if (block === "nearest") {
        if (targetTop >= currentTop && targetBottom <= visibleBottom) return;
        const distanceToTop = Math.abs(targetTop - currentTop);
        const distanceToBottom = Math.abs(targetBottom - visibleBottom);
        nextTop = distanceToTop <= distanceToBottom ? targetTop : targetBottom - container.clientHeight;
    }

    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const clampedTop = Math.min(maxTop, Math.max(0, nextTop - offsetTop));
    container.scrollTo({ top: clampedTop, behavior });
}
