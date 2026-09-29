import type { NextConfig } from "next";

if (process.env.NODE_ENV === "development") {
    process.env.HTTP_PROXY = "http://127.0.0.1:7897";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
    // NO_PROXY 是逗号分隔的“不代理”名单，本地回环不要塞进代理
    process.env.NO_PROXY = "localhost,127.0.0.1";
    // 让 Node 原生 http/https/http2 也认上面的代理变量
    // （firebase-admin 的 Auth 请求走的是原生 https，不认 HTTP_PROXY）
    process.env.NODE_USE_ENV_PROXY = "1";
}

const nextConfig: NextConfig = {
    /* config options here */
    typescript: {
        ignoreBuildErrors: true,
    },
    eslint: {
        ignoreDuringBuilds: true,
    },
    serverExternalPackages: ["firebase-admin", "jwks-rsa"],
} as any;

export default nextConfig;
