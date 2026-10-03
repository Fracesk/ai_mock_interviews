import {
    AccessToken,
    RoomAgentDispatch,
    RoomServiceClient,
} from "livekit-server-sdk";

import { getCurrentUser } from "@/lib/actions/auth.action";

// LiveKit 本地 dev 模式（--dev）的固定凭据，所以开箱即用、不用配 env。
// 要连自建/云端服务器，覆盖这三个环境变量即可。
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "http://localhost:7880";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "secret";
const LIVEKIT_WS_URL = LIVEKIT_URL.replace(/^http/, "ws");

/*
 * 建房时点名要哪个 agent 进来（显式派单），跟 bot/agent.ts 里那个常量是同一个推导逻辑，
 * 两边必须一致：
 *   本地 next dev      -> NODE_ENV=development -> jsm-interviewer-dev
 *   Vercel 生产构建     -> NODE_ENV=production  -> jsm-interviewer
 *
 * 为什么非要有这一行：agent 一旦有名字，LiveKit 就不再自动把它塞进新房间了，改成
 * 「谁点名谁来」。本地和线上共用同一个 LiveKit Cloud 项目，隔离正是靠这个名字 ——
 * 各自只派自己那个 agent，互不抢单。省略掉的话房间照建、人照进，但 agent 不会来。
 */
const LIVEKIT_AGENT_NAME =
    process.env.LIVEKIT_AGENT_NAME ??
    (process.env.NODE_ENV === "production"
        ? "jsm-interviewer"
        : "jsm-interviewer-dev");

export async function POST(request: Request) {
    const body = await request.json();
    const { type, questions } = body;

    /*
     * 归属人从会话 cookie 里取，不信前端传的 userid。
     *
     * 这个 userId 会被 agent 一路带进 /api/interview/generate，最终写成面试文档的
     * userId —— 也就是首页 "Your Interviews" 的过滤条件。让前端说了算的话，生成的
     * 面试会挂到别人名下，或者压根挂不上（userId 为空时哪里都不会显示）。
     *
     * 取不到会话（本地没登录调试）才回退到请求体，并且打一条日志说明走了回退。
     */
    const user = await getCurrentUser();
    if (!user) {
        console.warn("[token] 没有会话，userId/userName 退回用请求体里的值");
    }
    const userId = user?.id ?? body.userId;
    const userName = user?.name ?? body.userName;

    // 一次面试一个房间
    const roomName = `interview-${userId ?? "anon"}-${Date.now()}`;
    // agent 从这里读走本次会话的配置
    const metadata = JSON.stringify({ type, questions, userName, userId });

    try {
        const rooms = new RoomServiceClient(
            LIVEKIT_URL,
            LIVEKIT_API_KEY,
            LIVEKIT_API_SECRET
        );
        await rooms.createRoom({
            name: roomName,
            metadata,
            emptyTimeout: 300,
            // 必须用 fromJson：agents 的元素类型是 protobuf 的 RoomAgentDispatch，
            // 对象字面量过不了类型检查（RoomServiceClient.d.ts:53）
            agents: [
                RoomAgentDispatch.fromJson({ agentName: LIVEKIT_AGENT_NAME }),
            ],
        });
    } catch (error) {
        console.error("createRoom failed:", error);
        return Response.json(
            { error: "无法创建房间，LiveKit server 起了吗？" },
            { status: 502 }
        );
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: userId || `user-${Date.now()}`,
        name: userName,
        // 同一份配置也挂在参会者身上。房间 metadata 要等 roomUpdated 事件才到 agent 手上，
        // 参会者 metadata 是跟着人一起进房的，一定在 —— agent 优先读这一份。
        metadata,
    });
    token.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
    });

    return Response.json({
        token: await token.toJwt(),
        serverUrl: LIVEKIT_WS_URL,
        roomName,
    });
}
