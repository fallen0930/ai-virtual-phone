// Tripo 出网请求的代理感知 fetch。
// 本地 dev 时开发机常靠系统代理才能访问 api.tripo3d.ai，而 Node 的 fetch
// 不读代理环境变量（curl 读，所以「curl 通、route 超时」）。这里检测到
// HTTPS_PROXY/HTTP_PROXY 就挂 undici ProxyAgent；线上（Netlify）无代理
// 环境变量，行为与原生 fetch 完全一致。

import { ProxyAgent, type Dispatcher } from "undici";

let dispatcher: Dispatcher | null | undefined;

function getProxyDispatcher(): Dispatcher | null {
  if (dispatcher !== undefined) return dispatcher;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  try {
    dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  } catch {
    dispatcher = null;
  }
  return dispatcher;
}

export function tripoFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxy = getProxyDispatcher();
  if (!proxy) return fetch(url, init);
  return fetch(url, { ...init, dispatcher: proxy } as RequestInit);
}
