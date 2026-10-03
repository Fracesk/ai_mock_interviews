# syntax=docker/dockerfile:1
#
# 给 LiveKit Cloud 跑 agent 用。lk agent 以工作目录（bot/）为构建上下文，
# 所以仓库根的 .env.local 根本进不来 —— 这是有意的，密钥一律走 Cloud 的 secrets。

# Node 24、Debian(glibc) 不能换成 Alpine：LiveKit 的原生 Rust 内核和 onnxruntime
# 都是预编译产物，musl 上会加载失败。
# 没有 build stage：项目靠 Node 原生类型剥离直接跑 .ts（bot/package.json 的 start
# 就是 `node agent.ts start`），不存在 tsc/tsx 编译产物。
FROM node:24-bookworm-slim

# slim 镜像不带 CA bundle，而 LiveKit SDK 的原生内核运行时要读系统信任库
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷依赖清单，让这层能跨代码改动复用。用 npm 不是 pnpm：仓库里是 package-lock.json。
# 注意绝不能 COPY 本机的 node_modules —— 那里面是 Windows 专用绑定（*-win32-x64-msvc），
# 会盖掉 Linux 的。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# 容器里没有 .env.local（也不该有：agent.ts 的 dotenv 带 override:true，
# 一旦存在会反过来盖掉 Cloud 注入的 secrets）。所以：
#   LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET —— Cloud 运行时自动注入
#   QWEN_API_KEY、APP_URL —— 必须自己在 agent 的 secrets 里配。缺 QWEN_API_KEY
#   实时模型起不来；APP_URL 缺了会退回 http://localhost:3000，面试写不进库。
#
# 这个 NODE_ENV 同时决定 agent 的派单名（agent.ts 里推 jsm-interviewer），
# 是容器唯一需要它的地方，也正好是生产容器该有的值。
ENV NODE_ENV=production

# node:24 镜像自带 uid 1000 的非 root 用户 node
USER node

# 等同 bot/package.json 的 start，跳过 npm 少一层信号转发
CMD ["node", "agent.ts", "start"]
