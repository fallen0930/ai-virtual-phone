import http from "node:http";
import path from "node:path";

import next from "next";

// 代理环境(典型:本地 WSL——所有外网强制走 127.0.0.1 的 Clash/Mihomo,直连被掐)下,
// Node 的 fetch(undici)默认不读 HTTP(S)_PROXY,会尝试直连而失败,表现为 Supabase
// 「fetch failed / 无法连接」。这里让全局 dispatcher 自动读取环境里的
// HTTP_PROXY/HTTPS_PROXY/NO_PROXY;没有设代理变量时等价于默认直连,生产环境不受影响。
if (
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy
) {
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log("[local-next-server] 检测到代理环境,已让服务端 fetch 走 HTTP(S)_PROXY");
  } catch (err) {
    console.warn("[local-next-server] 代理 dispatcher 安装失败,fetch 仍走直连:", err?.message || err);
  }
}

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  return value ?? fallback;
}

function readArgOrEnv(name, envName, fallback) {
  const envValue = process.env[envName];
  return readArg(name, envValue ?? fallback);
}

const isDev = process.argv.includes("--dev");
const defaultPort = "3001";
const port = Number(readArgOrEnv("--port", "PORT", defaultPort));
const hostname = readArgOrEnv("--host", "HOST", isDev ? "0.0.0.0" : "127.0.0.1");
const dir = process.cwd();

const app = next({
  dev: isDev,
  dir,
  hostname,
  port
});

const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = http.createServer(async (request, response) => {
      try {
        await handle(request, response);
      } catch (error) {
        console.error("[server] request error:", error);
        response.statusCode = 500;
        response.end("Internal Server Error");
      }
    });

    server.listen(port, hostname, () => {
      const mode = isDev ? "dev" : "prod";
      const shownHost = hostname === "127.0.0.1" ? "localhost" : hostname;
      console.log(`[server] ${mode} ready at http://${shownHost}:${port}`);
      console.log(`[server] project root: ${path.resolve(dir)}`);
    });
  })
  .catch((error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(
        `[server] port ${port} is already in use. Set PORT to another value, for example: PORT=3003 npm run dev`
      );
    }
    console.error("[server] failed to boot:", error);
    process.exit(1);
  });
