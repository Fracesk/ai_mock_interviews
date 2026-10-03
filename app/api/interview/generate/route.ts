import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { getInterviewCoverFor } from "@/lib/utils";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { db } from "@/firebase/admin";

export async function GET() {
    return Response.json(
        { success: true, data: "THANK YOU!" },
        { status: 200 }
    );
}

export async function POST(request: Request) {
    const { type, role, level, techstack, amount, userid } =
        await request.json();

    /*
     * 归属人（userId）必须是**创建这场面试的那个登录用户** —— 首页的
     * "Your Interviews" 就是按它过滤的，写错或者写成 undefined，生成的面试
     * 就再也不会出现在任何人的列表里。
     *
     * 优先从会话 cookie 里取，取不到才用调用方传来的：bot 是服务端调用、没有
     * cookie，所以正常路径走的就是 userid 这个回退分支；但 userid 本身也是
     * /api/livekit/token 里从会话派生的（见那边的注释），不是前端随便填的。
     */
    const user = await getCurrentUser();
    const ownerId = user?.id ?? userid;

    if (!ownerId) {
        console.error("[generate] 拿不到创建者 userId，拒绝写入");
        return Response.json(
            { success: false, error: "missing userId" },
            { status: 400 }
        );
    }

    try {
        const { text: questions } = await generateText({
            model: google("gemini-3.1-flash-lite"), //看看有没有更多免费额度的模型
            prompt: `Prepare questions for a job interview.
        The job role is ${role}.
        The job experience level is ${level}.
        The tech stack used in the job is: ${techstack}.
        The focus between behavioural and technical questions should lean towards: ${type}.
        The amount of questions required is: ${amount}.
        Please return only the questions, without any additional text.
        The questions are going to be read by a voice assistant so do not use "/" or "*" or any other special characters which might break the voice assistant.
        Return the questions formatted like this:
        ["Question 1", "Question 2", "Question 3"]
        
        Thank you! <3
    `,
        });

        // 先拿到 id，再用它挑封面：coverImage 落库时就是定死的，之后任何一次渲染
        // 读到的都是同一张（老数据没有这个字段才会回退到按 id 现算，见 InterviewCard）
        const docRef = db.collection("interviews").doc();

        const interview = {
            role,
            type,
            level,
            techstack: techstack.split(","),
            questions: JSON.parse(questions),
            userId: ownerId,
            coverImage: getInterviewCoverFor(docRef.id),
            createdAt: new Date().toISOString(),
            // getLatestInterviews 靠这个字段筛选（general.action.ts:101），
            // 新生成的面试就是"可以被别人拿来练"的状态，所以直接置 true
            finalized: true,
        };

        await docRef.set(interview);

        return Response.json({ success: true }, { status: 200 });
    } catch (error) {
        console.error(error);
        return Response.json({ success: false, error }, { status: 500 });
    }
}
