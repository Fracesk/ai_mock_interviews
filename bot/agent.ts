import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { z } from "zod";
import {
    ServerOptions,
    cli,
    defineAgent,
    llm,
    voice,
    type JobContext,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
// 只为了拿 TrackSource.SOURCE_MICROPHONE 去认用户的麦克风轨道（见 findUserMic）
import { TrackSource } from "@livekit/rtc-node";
const DIR = path.dirname(fileURLToPath(import.meta.url));
/*
 * 直接复用 Next 项目已有的 .env.local。
 * override: true 让 .env.local 优先于系统环境变量 —— dotenv 默认是反过来的
 * （系统变量赢），那样在文件里改了 QWEN_API_KEY 会静默不生效，很难排查。
 */
config({ path: path.join(DIR, "..", ".env.local"), override: true, quiet: true });

const QWEN_MODEL = process.env.QWEN_REALTIME_MODEL ?? "qwen-audio-3.0-realtime-flash";
const QWEN_VOICE = process.env.QWEN_VOICE ?? "longanqian";
/*
 * 判停方式：用户停多久算「这一轮说完了」。
 *
 * 默认 smart_turn —— 千问自己的**语义判停**，声学 + 语义一起判断轮次边界。
 * 用户只是「嗯、啊」这种没有语义的声音不会被当成说完，也不会误打断模型播报。
 *
 * 实测（同一段语音、同一份 session.update，逐个试 turn_detection.type）：
 *   server_vad      → 接受
 *   smart_turn      → 接受
 *   smart_turn_v2   → 接受
 *   semantic_vad    → **明确报错**：Unsupported turn_detection.type: 'semantic_vad'，
 *                     Supported values: server_vad, smart_turn, smart_turn_v2
 *
 * 也就是说插件默认那个 semantic_vad（realtime_model.js:52）是被网关直接拒绝的，
 * 之前观察到的「0 次检出」是拒绝之后的连锁反应，不是「静默忽略」。
 *
 * 想退回纯声学判停（比如语义判停太慢、想自己按耳朵调）：
 *   .env.local 里加 QWEN_TURN_DETECTION=server_vad
 * 下面两个旋钮**只有 server_vad 生效** —— 实测 smart_turn 下把 silence_duration_ms
 * 传 1200 进去，网关回显的仍是它自己的默认 2000，传了也白传。
 */
const VAD_TYPE = process.env.QWEN_TURN_DETECTION ?? "smart_turn";
const VAD_SILENCE_MS = Number(process.env.QWEN_VAD_SILENCE_MS ?? 1200);
const VAD_THRESHOLD = Number(process.env.QWEN_VAD_THRESHOLD ?? 0.5);
/*
 * qwen-audio-3.0-realtime-flash 用的是 OpenAI Realtime 协议，所以直接复用
 * LiveKit 的 OpenAI realtime 插件，把 baseURL 指到千问的网关即可，不需要
 * 自己写 adapter。插件同时认新旧两套事件名（response.audio.delta 与
 * response.output_audio.delta），能对上本模型发出的 beta 风格事件。
 *
 * 网关是 maas.qianwenaiapi.com —— 不是 dashscope.aliyuncs.com，打错了会 401。
 * key 取系统环境变量 QWEN_API_KEY（DASHSCOPE_API_KEY 已废弃）。
 *
 * 路径故意写全到 /realtime：插件的 processBaseURL 只对 ""|/v1|/openai|/openai/v1
 * 做重写，其余原样保留，然后自动追加 ?model=。
 */
const QWEN_BASE_URL =
    process.env.QWEN_BASE_URL ?? "wss://maas.qianwenaiapi.com/api-ws/v1/realtime";
// agent 回调 Next 的接口，走本机
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

// 默认对齐 LiveKit 本地 dev 模式的固定凭据，开箱即用；要连别的服务器就覆盖env
const LIVEKIT_WS_URL = (process.env.LIVEKIT_URL ?? "http://localhost:7880").replace(
    /^http/,
    "ws"
);
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "secret";

/*
 * 派单名。空字符串在 LiveKit 里等于「不点名」—— worker 会加入项目里**每一个**新房间
 * （@livekit/agents/dist/worker.js:194），那样本地调试时云端生产 agent 会一头扎进你的
 * 房间，反过来也一样。所以这个名字绝不允许为空。
 *
 * 本地和线上共用同一个 LiveKit Cloud 项目，隔离完全靠这个名字：本机和 Vercel 各自
 * 建房间时只点名自己那个 agent（见 app/api/livekit/token/route.ts），互不抢单。
 *
 * 名字从 NODE_ENV 推，不要求两个环境去配环境变量：
 *   本地 npm run bot  -> NODE_ENV 未设（@livekit/agents 不碰它）-> dev 名
 *   Vercel / 云上容器 -> NODE_ENV=production（Dockerfile 里写死）-> 生产名
 * LIVEKIT_AGENT_NAME 只留作手动覆盖的逃生口，优先级最高。
 */
const LIVEKIT_AGENT_NAME =
    process.env.LIVEKIT_AGENT_NAME ??
    (process.env.NODE_ENV === "production"
        ? "jsm-interviewer"
        : "jsm-interviewer-dev");

/**
 * 日志前缀：HH:MM:SS.mmm。
 * 「判停早了/晚了」这类问题只能靠看时间差来量——用户停嘴的时刻他知道，网关下判断的时刻
 * 就是下面 [user] 那行打出来的时刻，两者相减才是真正的判停延迟。没有时间戳就只能靠感觉。
 */
const stamp = () => new Date().toISOString().slice(11, 23);

type SessionConfig = {
    type: "generate" | "interview";
    userName?: string;
    userId?: string;
    questions?: string[];
};

/**
 * 只解析，不猜测：拿不到合法的 type 就返回 undefined。
 *
 * 绝不能有默认值 —— "解析失败就按正式面试走" 意味着一个生成页的会话会静默变成
 * 一场真面试，两套流程直接串在一起，而且日志里看不出来。见 resolveConfig。
 */
function parseConfig(raw: string | undefined | null): SessionConfig | undefined {
    if (!raw) return undefined;
    try {
        const cfg = JSON.parse(raw) as Partial<SessionConfig>;
        if (cfg.type === "generate" || cfg.type === "interview") {
            return cfg as SessionConfig;
        }
        console.error(`[config] metadata 里的 type 不认识: ${JSON.stringify(cfg?.type)}`);
    } catch (error) {
        console.error("[config] metadata 不是合法 JSON:", error);
    }
    return undefined;
}

/**
 * 前端在 /api/livekit/token 里把本次会话的配置写进 metadata，agent 在这里取回。
 *
 * 生成 / 面试是两套完全不同的东西（不同提示词、不同工具、不同收尾方式），**不允许
 * 互相退化**。所以这里只做一件事：把模式读准。读不准就返回 undefined，由调用方
 * 放弃整场会话 —— 宁可不开，也不能猜。
 *
 * 三个来源，按可靠性排序：
 * 1. `ctx.job.room.metadata` —— 服务器派单时就带过来了，早于 connect，没有竞态；
 * 2. 参会者 metadata —— 签 token 时就挂在人身上，跟着人一起进房；
 * 3. `ctx.room.metadata` —— 连上之后才同步过来。rtc-node 的 `Room.metadata` 实现是
 *    `return this.info?.metadata`（room.cjs:433），而 `this.info` 要等 roomUpdated
 *    FFI 事件才赋值，`connect()` 返回时不保证已经处理完 —— 所以它只能当兜底。
 *    （当初就是只读它、还把失败吞成"面试模式"，才导致生成页一进房就开始面试。）
 */
async function resolveConfig(ctx: JobContext): Promise<SessionConfig | undefined> {
    // 先等真人进房：开场白得有人听；顺带参会者 metadata 此时一定到位了
    let participant: { metadata?: string } | undefined;
    try {
        participant = await ctx.waitForParticipant();
    } catch (error) {
        console.error("[config] 等待参会者失败:", error);
    }

    for (const [source, raw] of [
        ["job room metadata", ctx.job.room?.metadata],
        ["参会者 metadata", participant?.metadata],
        ["房间 metadata", ctx.room.metadata],
    ] as const) {
        const cfg = parseConfig(raw);
        if (cfg) {
            console.log(`[config] 会话模式 = ${cfg.type}（来自 ${source}）`);
            return cfg;
        }
    }
    return undefined;
}

/**
 * 把用户这一句转写直接发进房间 —— 前端的实时字幕只认这一条路。
 *
 * 为什么不指望框架自己发：
 *
 * 1. SDK 其实**同时**起了两条路发字幕（room_io.js:297-315，两个 sink 包在
 *    ParalellTextOutput 里）：新的走 `lk.transcription` 文本流，旧的走
 *    publishTranscription 的 protobuf 包。
 * 2. **新路前端收不到**。livekit-client 2.22.3 的 bundle 里 "lk.transcription"
 *    出现 0 次，而 RoomEvent.TranscriptionReceived 只从旧版 protobuf 包里解析
 *    （livekit-client.esm.mjs:34269）—— Agent.tsx:134 听的正是它。
 * 3. 旧路前面横着一个 trackId 闸门：拿不到用户的麦克风轨道 SID 就直接 return，
 *    而且是**静默**的（_output.js:277 handleCaptureText、:300 handleFlush、
 *    :308 publishTranscription，三处都是 `if (!trackId) return`）。trackId 由
 *    findMicrophoneTrackId 解析，解析失败是**抛异常**，又被 _output.js:54 那个空
 *    catch 吃掉（`catch (error) {}`）—— 所以现象就是「一片安静，日志什么都没有」。
 *
 * 这里自己找轨道、自己调 publishTranscription，绕开那个闸门。
 *
 * trackSid 必须是**用户的**麦克风轨道的 SID：前端靠 participantIdentity 判断
 * 这句话是谁在说（Agent.tsx:136），给错了 user/assistant 的角色就反了。
 */
function publishUserCaption(
    ctx: JobContext,
    ev: { transcript: string; isFinal: boolean; itemId: string | null }
) {
    if (!ev.transcript) return;

    // 通话里除 agent 外只有一个真人，取第一个带麦克风轨道的远端参会者即可。
    // 每次重新找而不是缓存：缓存到过期的 SID 会让字幕再次静默消失，而这个循环
    // 只有一个参会者、几条轨道，代价可以忽略。
    let mic: { identity: string; trackSid: string } | null = null;
    for (const participant of ctx.room.remoteParticipants.values()) {
        for (const track of participant.trackPublications.values()) {
            if (track.source === TrackSource.SOURCE_MICROPHONE && track.sid) {
                mic = { identity: participant.identity, trackSid: track.sid };
                break;
            }
        }
        if (mic) break;
    }
    if (!mic) {
        console.warn("[caption] 找不到用户的麦克风轨道，这条字幕发不出去");
        return;
    }

    void ctx.room.localParticipant
        ?.publishTranscription({
            participantIdentity: mic.identity,
            trackSid: mic.trackSid,
            segments: [
                {
                    /*
                     * 前端拿 segment.id 当 key 去重（Agent.tsx:143 的 segmentIndexRef）：
                     * 同一句话 interim→final 用同一个 id 才会被认成一段。网关给的
                     * itemId 正好是这个粒度；没给就退回时间戳，顶多同一句被切成两段，
                     * 不会丢字。
                     */
                    id: ev.itemId ?? `SG_${Date.now()}`,
                    text: ev.transcript,
                    startTime: 0n,
                    endTime: 0n,
                    language: "",
                    final: ev.isFinal,
                },
            ],
        })
        .catch((error) => console.error("[caption] 发布失败:", error));
}

/**
 * 千问网关发回来的原始服务器事件，只列出我们用得上的字段。
 * `stash` 是网关自己的字段名，OpenAI 协议里没有 —— 见下面 QwenRealtimeModel。
 */
type RawServerEvent = {
    type?: string;
    item_id?: string;
    delta?: string;
    text?: string;
    stash?: string;
};

/**
 * 插件给 turn_detection 声明的类型（api_proto.d.ts:44）只装得下 OpenAI 自己那两种
 * semantic_vad / server_vad，而千问认的是 server_vad / smart_turn / smart_turn_v2 ——
 * 类型对不上是必然的，真正的裁判是网关。这个别名只为让 entry 里那一处断言写得清楚。
 */
type RealtimeOptions = NonNullable<
    ConstructorParameters<typeof openai.realtime.RealtimeModel>[0]
>;
type PluginTurnDetection = NonNullable<RealtimeOptions["turnDetection"]>;

/**
 * RealtimeModel 的薄壳，只为一件事：把网关的原始事件捞出来。
 *
 * 为什么要原始事件：千问把「边说边出」的增量转写放在 `stash` 字段里，而插件只读
 * `delta`（realtime_model.js:1281 开头就是 `if (!event.delta) return;`）—— 每一个中间
 * 结果都被丢掉，UserInputTranscribed 只在整句说完时带着全文来一次。表现就是说话
 * 过程中屏幕一动不动，说完的瞬间整句「一闪而过」。
 *
 * 插件本来就把每个原始事件 emit 了出来（realtime_model.js:996
 * `this.emit("openai_server_event_received", event)`），但那事件挂在 **RealtimeSession**
 * 上，而 session 是 `session()` 里 new 出来的、外面拿不到引用 —— 所以这里重写
 * `session()`，借创建时机把监听挂上去。
 *
 * 为什么用实例回调而不是模块级变量：一个 bot 进程会同时接多场面试，模块级变量会被
 * 后一单覆盖掉前一单的房间引用。
 */
class QwenRealtimeModel extends openai.realtime.RealtimeModel {
    onRawServerEvent?: (event: RawServerEvent) => void;

    override session() {
        const inner = super.session();
        (
            inner as unknown as {
                on(ev: string, cb: (event: RawServerEvent) => void): void;
            }
        ).on("openai_server_event_received", (event) => this.onRawServerEvent?.(event));
        // 这一行只在框架真的调到了 session() 时才会打出来。没看到它就说明壳挂空了，
        // 增量字幕不可能工作 —— 排查时先看它。
        console.log("[caption] 原始事件监听已挂上（网关增量转写）");
        return inner;
    }
}

/**
 * 把这一通的对话落到本地 md 里。
 *
 * bot 的 stdout 关掉窗口就没了，而「agent 到底说了什么」恰恰是判断轮次、模式、
 * 挂断这几处有没有出错时唯一的一手证据 —— 没有它就只能靠猜。
 */
function createTranscriptLogger(roomName: string, mode: string) {
    /*
     * 云端容器里既没有 docs/conversations 也留不住文件（容器随时回收），
     * 开着只会每轮刷一条写失败的日志。生产直接关掉，本地照旧。
     */
    if (process.env.NODE_ENV === "production") {
        return () => {};
    }

    const dir = path.join(DIR, "..", "docs", "conversations");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${mode}.md`);
    let header = false;

    return (role: "user" | "assistant", text: string) => {
        try {
            if (!header) {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(
                    file,
                    `# ${mode} 会话记录\n\n- 房间: \`${roomName}\`\n- 开始: ${new Date().toISOString()}\n\n---\n\n`,
                    "utf8"
                );
                header = true;
                console.log(`[transcript] 本次对话记录: ${file}`);
            }
            fs.appendFileSync(file, `**${role}**: ${text}\n\n`, "utf8");
        } catch (error) {
            console.error("[transcript] 写文件失败:", error);
        }
    };
}

const INTERVIEW_RULES = `You are a professional job interviewer conducting a real-time voice interview with a candidate. Your goal is to assess their qualifications, motivation, and fit for the role.

Interview Guidelines:
Listen actively to responses and acknowledge them before moving forward.
Ask brief follow-up questions if a response is vague or requires more detail.
Keep the conversation flowing smoothly while maintaining control.

Be professional, yet warm and welcoming:
Use official yet friendly language.
Answer the candidate's questions professionally. If unsure, redirect them to HR.

Conclude the interview properly:
Thank the candidate for their time and tell them the company will reach out soon with feedback.
Once you have no more questions to ask, call the endInterview tool to wrap up.

- Keep all your responses short and simple.
- This is a voice conversation, so keep your responses short, like in a real conversation. Don't ramble.`;

const GENERATE_RULES = `You are a friendly assistant that sets up a mock interview for the user.

You MUST collect all FIVE of these before an interview can be generated:
1. Role - the job they are targeting (for example "Frontend Developer").
2. Level - Junior, Mid or Senior.
3. Focus - Technical, Behavioral or Mixed.
4. Tech stack - as a comma separated list.
5. Question count - how many interview questions they want, as a number.

How to collect them:
- Ask about exactly ONE of the five, then stop and wait for the answer.
- Go through them in order, 1 to 5.
- NEVER guess or assume a value on the user's behalf. In particular you MUST ask how many
  questions they want - never pick a number yourself, and never skip item 5.
- Do not call saveInterviewConfig until the user has answered all five.
- If an answer is vague, ask one short follow-up before moving on.

Once all five are answered, call saveInterviewConfig, then tell the user their interview is ready.

- Keep all your responses short and conversational. This is a voice conversation, don't ramble.`;

function buildInstructions(cfg: SessionConfig) {
    const who = `The candidate's name is ${cfg.userName || "the candidate"}.`;

    if (cfg.type === "generate") {
        return `${GENERATE_RULES}\n\n${who}`;
    }

    const questions = cfg.questions ?? [];
    if (questions.length === 0) {
        return `${INTERVIEW_RULES}\n\n${who}`;
    }

    return `${INTERVIEW_RULES}\n\n${who}\n\nFollow this question flow, one question at a time:\n${questions
        .map((q) => `- ${q}`)
        .join("\n")}`;
}

/**
 * 两种会话各有一个「收尾」tool：
 * - generate：收集齐五个字段后写库，然后道别退房；
 * - interview：答完最后一题后道别退房。
 *
 * onFinished 只负责安排挂断（等道别的话真的说完再执行）。前端监听到 agent 离开房间
 * 就会自己走下一步 —— generate 回主页，interview 去 feedback 页。
 */
function buildTools(cfg: SessionConfig, onFinished: () => void) {
    if (cfg.type !== "generate") {
        return {
            endInterview: llm.tool({
                description:
                    "Call this once the candidate has answered the final question and the interview is over.",
                parameters: z.object({}),
                execute: async () => {
                    onFinished();
                    return (
                        "Wrap up now: thank the candidate for their time, tell them the company " +
                        "will reach out with feedback, and say goodbye. Do not ask any more " +
                        "questions and do not call any more tools."
                    );
                },
            }),
        };
    }

    return {
        saveInterviewConfig: llm.tool({
            description:
                "Save the mock interview configuration. Call this ONLY once the user has answered all five: role, level, focus type, tech stack, and how many questions they want. Do not call it while any of the five is still unknown.",
            parameters: z.object({
                role: z.string().describe("The job role, e.g. Frontend Developer"),
                level: z
                    .string()
                    .describe("Seniority level: Junior, Mid or Senior"),
                type: z
                    .string()
                    .describe("Focus of the interview: Technical, Behavioral or Mixed"),
                techstack: z
                    .string()
                    .describe("Comma separated tech stack, e.g. react, node.js"),
                amount: z.number().describe("How many questions the user wants"),
            }),
            execute: async (args) => {
                // 模型自己汇报它收集到了什么。它跳过某一项时，这里是唯一能看见的地方
                console.log("[generate] 收集到的配置:", args);

                // 题量是"模型可能自己瞎填一个"的典型字段，挡掉不可能的取值
                if (
                    !Number.isInteger(args.amount) ||
                    args.amount < 1 ||
                    args.amount > 20
                ) {
                    return "The number of questions must be a whole number between 1 and 20. Ask the user how many questions they want, then try again.";
                }

                try {
                    const res = await fetch(`${APP_URL}/api/interview/generate`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ ...args, userid: cfg.userId }),
                    });
                    const data = (await res.json()) as { success?: boolean };
                    if (!data.success) {
                        return "Saving failed. Apologise and ask the user to try again.";
                    }
                } catch {
                    return "Saving failed. Apologise and ask the user to try again.";
                }

                // 写库成功了：安排挂断，并让模型把收尾话说完（见 requestHangup）
                onFinished();
                return (
                    "Saved. Tell the user the interview is ready and that they can find it on the " +
                    'home page under "Your Interviews". Then say goodbye warmly. ' +
                    "Do not ask any further questions and do not call any more tools."
                );
            },
        }),
    };
}

/**
 * 开场白必须由 agent 先开口，而且不能静默失败。
 *
 * 必须带 userInput：千问 realtime 服务端在会话里一条 user 消息都没有时，会直接拒绝
 * response.create —— invalid_value: "Cannot create response: conversation has no messages
 * or no user message."。实测 system 消息不算数，只有 user 角色能过。带 userInput 时
 * LiveKit 会先把这条作为 user 消息同步过去再触发生成（agent_activity.js:3788-3800），
 * 正好满足这个前置条件。
 *
 * 为什么要重试：插件给「主动发起的 response」设了 10 秒硬超时
 * （agents-plugin-openai/dist/realtime/realtime_model.js 的 createResponse，
 * 里面的 setTimeout(..., 1e4)）。超时后这次 response 会被标成 discarded，
 * 服务端迟到的 response.created 到达时还会被反过来 response.cancel 掉。
 * 首次连千问网关是冷启动，很容易吃满这 10 秒 —— 表现就是 agent 一声不吭，
 * 等用户自己开口了才像没事人一样接话。
 */
async function speakGreeting(session: voice.AgentSession, cfg: SessionConfig) {
    const isGenerate = cfg.type === "generate";
    const userInput = isGenerate
        ? "(通话已接通，用户刚加入房间。)"
        : "(通话已接通，候选人已就位。)";
    const instructions = isGenerate
        ? "Greet the user warmly and ask what role they want to practise for."
        : "Greet the candidate warmly and begin the interview with the first question.";

    for (let attempt = 1; attempt <= 3; attempt++) {
        // 用户自己先开口了，让正常轮次接手，别抢话
        if (session.userState === "speaking") {
            console.log("[greeting] 用户已先说话，跳过开场白");
            return;
        }
        // agent 正在思考/说话，说明这一次其实已经成功了
        if (session.agentState === "thinking" || session.agentState === "speaking") {
            return;
        }

        try {
            const handle = session.generateReply({ userInput, instructions });
            let timedOut = false;
            // waitForPlayout 会等到这段语音真的播完；加超时是为了失败时还能重试
            await Promise.race([
                handle.waitForPlayout(),
                new Promise<void>((resolve) =>
                    setTimeout(() => {
                        timedOut = true;
                        resolve();
                    }, 12_000)
                ),
            ]);
            if (!timedOut) {
                console.log("[greeting] 开场白已播出");
                return;
            }
            console.warn(`[greeting] 第 ${attempt}/3 次等待超时，检查是否真的开口了`);
        } catch (error) {
            console.error(`[greeting] 第 ${attempt}/3 次开场白失败:`, error);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.error("[greeting] 三次都没能把开场白说出去");
}

export default defineAgent({
    entry: async (ctx: JobContext) => {
        // 这一单是哪个名字接的。排查「本地和云上串了」时第一眼要看的就是它
        console.log(`[agent] 派单名 = ${LIVEKIT_AGENT_NAME}`);
        // 尽量早连，减少用户等待
        await ctx.connect();

        // 读不到配置就什么都不做 —— 见 resolveConfig：猜错模式比不开会话糟得多
        const cfg = await resolveConfig(ctx);
        if (!cfg) {
            console.error(
                "[config] 三个来源都没读到合法的会话配置，本次不开会话。\n" +
                    "         检查 /api/livekit/token 有没有把 { type } 写进房间和参会者的 metadata。"
            );
            await ctx.shutdown("missing session config");
            return;
        }

        const roomName = ctx.job.room?.name ?? "unknown-room";
        const instructions = buildInstructions(cfg);

        // 模式只有这两种，走到这里说明已经读准了。vad 打出来是为了确认环境变量真的生效了
        console.log(`[${stamp()}] [session] 本次会话:`, {
            type: cfg.type,
            room: roomName,
            userName: cfg.userName,
            questions: cfg.questions?.length ?? 0,
            vadSilenceMs: VAD_SILENCE_MS,
        });

        /*
         * 保存成功后要收尾挂断：先让模型把道别的话说完，再退房。
         * 用「说话 → 回到 listening」这个状态变化当信号，避免和模型自己的
         * tool 结果回复抢话（如果在 tool 里直接 generateReply，会多出一段语音）。
         */
        let pendingHangup = false;
        let spokeAfterHangupRequest = false;
        const requestHangup = () => {
            pendingHangup = true;
            spokeAfterHangupRequest = false;
            // 兜底：万一模型保存完就不出声了，也别把用户干晾在通话里
            setTimeout(() => {
                if (pendingHangup) {
                    pendingHangup = false;
                    ctx.shutdown("hangup fallback timeout");
                }
            }, 25_000);
        };

        /*
         * 判停配置。断言只在这一处出现：见 PluginTurnDetection 别名的注释。
         * 默认走 smart_turn（语义判停），退回纯声学判停用 QWEN_TURN_DETECTION=server_vad。
         */
        const turnDetection = (
            VAD_TYPE === "server_vad"
                ? {
                      type: "server_vad",
                      threshold: VAD_THRESHOLD,
                      prefix_padding_ms: 300,
                      silence_duration_ms: VAD_SILENCE_MS,
                      create_response: true,
                      interrupt_response: true,
                  }
                : {
                      type: VAD_TYPE,
                      create_response: true,
                      interrupt_response: true,
                  }
        ) as unknown as PluginTurnDetection;

        const realtimeModel = new QwenRealtimeModel({
            model: QWEN_MODEL,
            voice: QWEN_VOICE,
            apiKey: process.env.QWEN_API_KEY,
            baseURL: QWEN_BASE_URL,
            modalities: ["text", "audio"],
            turnDetection,
        });

        /*
         * 用户字幕「边说边出」就靠这一处。
         *
         * 千问把增量转写放在 `stash` 里，而插件只读 `delta`
         * （realtime_model.js:1281 开头就是 `if (!event.delta) return;`）—— 每个中间结果
         * 都被丢掉，UserInputTranscribed 只在整句说完时带着全文来一次。所以说话过程中
         * 屏幕上什么都不动，说完的瞬间整句「一闪而过」。
         *
         * 全文 = text + stash：text 是已经定稿的前缀，stash 是还在变的尾部，任缺其一都会少字。
         * 实测同一条语音：
         *   {"text":"",       "stash":"你好，我叫"}                 → 你好，我叫
         *   {"text":"你好，", "stash":"我叫张伟，我做了5年后端开发"}  → 你好，我叫张伟，我做了5年后端开发
         *
         * `if (event.delta) return` 是有意的：网关哪天真的按 OpenAI 协议发 delta 了，
         * 插件自己就能处理，这里自动变成空操作，不会重复发一遍。
         */
        realtimeModel.onRawServerEvent = (event) => {
            if (event.type !== "conversation.item.input_audio_transcription.delta") return;
            if (event.delta) return;
            const full = `${event.text ?? ""}${event.stash ?? ""}`;
            if (!full) return;
            publishUserCaption(ctx, {
                transcript: full,
                isFinal: false,
                itemId: event.item_id ?? null,
            });
        };

        const session = new voice.AgentSession({
            /*
             * AEC 预热期（默认 3 秒）内，框架会把用户音频整段替换成静音
             * （agent_activity.js:1229-1248 的 silenceDiscardedAudio）。若 agent 状态卡在
             * "speaking"，或首条 speech 始终没被标记完成，这个静音替换就会一直生效 ——
             * 表现为服务端收不到任何可识别语音：VAD 不触发、没转写、缓冲区被静音灌满
             * 到 30 秒后反复报 "Input audio buffer exceeded maximum duration"。
             * 我们这里没有回声消除链路，需求也要求随时能打断，所以直接关掉。
             */
            aecWarmupDuration: null,
            llm: realtimeModel,
        });

        /*
         * 会话里的错误默认只是一个事件，没人监听就无声无息地消失了。
         * 这一路排查里最耗时间的就是「什么都没发生」，所以这里统一留痕。
         */
        session.on(voice.AgentSessionEventTypes.Error, (ev) => {
            console.error("[session error]", ev.error);
        });

        /*
         * 轮次是否正常推进，全看这两条状态线。之前「用户说完了但 agent 不动」
         * 这类问题只能靠猜，打出来一目了然：user 从 speaking 回到 listening 说明
         * 服务端的语音活动检测认了这个轮次结束；agent 走到 speaking 说明它真的开口了。
         */
        session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
            // final 的那一行 = 网关判定"这一轮说完了"的时刻，判停实验就看它
            if (ev.isFinal) console.log(`[${stamp()}] [user]`, ev.transcript);

            /*
             * 这里只负责**定稿**那一份（整句全文、final=true）。
             * 说话过程中的增量字幕走 realtimeModel.onRawServerEvent —— 因为插件会把
             * 千问的增量事件整个丢掉，isFinal=false 这一支实际上永远不带字。
             * 两条路发的 itemId 是同一个，前端按 id 去重后正好接成一段。
             */
            publishUserCaption(ctx, ev);
        });

        /*
         * 一边打日志一边落盘。ConversationItemAdded 是两侧都带的（user 和 assistant），
         * 比只记用户转写完整 —— 事后要复盘"agent 到底说了什么"靠的就是它。
         */
        const logTurn = createTranscriptLogger(roomName, cfg.type);
        session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
            const item = ev.item as { role?: string; textContent?: string };
            if (item.role !== "user" && item.role !== "assistant") return;
            if (!item.textContent) return;
            logTurn(item.role, item.textContent);
        });

        session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
            console.log(`[${stamp()}] [agent] ${ev.oldState} → ${ev.newState}`);
            if (ev.newState === "speaking") spokeAfterHangupRequest = true;
            if (pendingHangup && spokeAfterHangupRequest && ev.newState === "listening") {
                pendingHangup = false;
                console.log("[hangup] 收尾语已说完，结束通话");
                ctx.shutdown("interview done");
            }
        });

        ctx.addShutdownCallback(async () => {
            await session.close();
        });

        await session.start({
            agent: new voice.Agent({
                instructions,
                tools: buildTools(cfg, requestHangup),
            }),
            room: ctx.room,
        });

        // 开场白交给模型自己说，音色才一致（resolveConfig 里已经等过参会者了）
        void speakGreeting(session, cfg);
    },
});

cli.runApp(
    new ServerOptions({
        agent: fileURLToPath(import.meta.url),
        wsURL: LIVEKIT_WS_URL,
        apiKey: LIVEKIT_API_KEY,
        apiSecret: LIVEKIT_API_SECRET,
        // 非空 = 显式派单：只接建房时点了这个名字的房间（worker.js:183-196）
        agentName: LIVEKIT_AGENT_NAME,
    })
);
