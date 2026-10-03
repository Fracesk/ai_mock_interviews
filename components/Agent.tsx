"use client";

import Image from "next/image";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type TranscriptionSegment,
} from "livekit-client";

import { cn } from "@/lib/utils";
import { createFeedback } from "@/lib/actions/general.action";

enum CallStatus {
  INACTIVE = "INACTIVE",
  CONNECTING = "CONNECTING",
  ACTIVE = "ACTIVE",
  FINISHED = "FINISHED",
}

interface SavedMessage {
  role: "user" | "system" | "assistant";
  content: string;
}

const Agent = ({
  userName,
  userId,
  interviewId,
  feedbackId,
  type,
  questions,
}: AgentProps) => {
  const router = useRouter();
  const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.INACTIVE);
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [lastMessage, setLastMessage] = useState<string>("");
  // 还没定稿的那半句（服务端持续推的 interim 转写），用来做实时字幕
  const [liveText, setLiveText] = useState<string>("");

  const roomRef = useRef<Room | null>(null);
  // agent 的语音轨要自己挂到 <audio> 上才会出声（见 TrackSubscribed 的处理）
  const audioContainerRef = useRef<HTMLDivElement>(null);
  // LiveKit 的转写是按 id 流式更新的（同一句话先来 partial，再来 final）。
  // 一条消息 = 一个 id，同一说话人**连着的**几段会合并成一条（见下），
  // 这样中间停顿被切出来的碎段不会把前面的话顶掉。
  const transcriptRef = useRef<SavedMessage[]>([]);
  const segmentIndexRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return () => {
      // 卸载时必须断开，否则麦克风指示灯不会灭
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      setLastMessage(messages[messages.length - 1].content);
    }

    const handleGenerateFeedback = async (messages: SavedMessage[]) => {
      console.log("handleGenerateFeedback");

      const { success, feedbackId: id } = await createFeedback({
        interviewId: interviewId!,
        userId: userId!,
        transcript: messages,
        feedbackId,
      });

      if (success && id) {
        router.push(`/interview/${interviewId}/feedback`);
      } else {
        console.log("Error saving feedback");
        router.push("/");
      }
    };

    if (callStatus === CallStatus.FINISHED) {
      if (type === "generate") {
        router.push("/");
      } else {
        handleGenerateFeedback(messages);
      }
    }
  }, [messages, callStatus, feedbackId, interviewId, router, type, userId]);

  const handleCall = async () => {
    setCallStatus(CallStatus.CONNECTING);

    try {
      // 房间由后端创建，本次会话的配置（type/questions/userName/userId）写在房间 metadata 里
      const res = await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName, userId, type, questions }),
      });
      if (!res.ok) {
        throw new Error(`token endpoint returned ${res.status}`);
      }
      const { token, serverUrl } = (await res.json()) as {
        token: string;
        serverUrl: string;
      };

      const room = new Room();
      roomRef.current = room;

      room
        .on(RoomEvent.Connected, () => {
          setCallStatus(CallStatus.ACTIVE);
        })
        .on(RoomEvent.Disconnected, () => {
          setCallStatus(CallStatus.FINISHED);
        })
        .on(RoomEvent.TrackSubscribed, (track) => {
          // livekit-client 不会自动播放远端音轨 —— 必须自己挂一个 <audio> 出来，
          // 否则 agent 说话就只有字幕、听不到声音。
          if (track.kind !== Track.Kind.Audio) return;
          const element = track.attach();
          element.autoplay = true;
          audioContainerRef.current?.appendChild(element);
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          for (const element of track.detach()) element.remove();
        })
        .on(
          RoomEvent.TranscriptionReceived,
          (segments: TranscriptionSegment[], participant?: Participant) => {
            // 用户和 AI 的转写都走这个事件，靠 participantIdentity 区分是谁在说
            const isUser = participant?.identity === room.localParticipant.identity;
            const role: SavedMessage["role"] = isUser ? "user" : "assistant";

            let interim: string | null = null;
            for (const segment of segments) {
              if (!segment.final) {
                // 定稿前的 interim 转写：这就是实时字幕，不显示的话要等整段说完才上屏
                interim = segment.text;
                continue;
              }

              const known = segmentIndexRef.current.get(segment.id);
              if (known !== undefined) {
                transcriptRef.current[known] = { role, content: segment.text };
                continue;
              }

              const last = transcriptRef.current[transcriptRef.current.length - 1];
              if (last && last.role === role) {
                // 同一个人这一轮里被停顿切出来的后续分段：接在后面，别把前面顶掉
                last.content = `${last.content} ${segment.text}`.trim();
                segmentIndexRef.current.set(segment.id, transcriptRef.current.length - 1);
              } else {
                segmentIndexRef.current.set(segment.id, transcriptRef.current.length);
                transcriptRef.current.push({ role, content: segment.text });
              }
            }
            setLiveText(interim ?? "");
            setMessages([...transcriptRef.current]);
          }
        )
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          setIsSpeaking(
            speakers.some((s) => s.identity !== room.localParticipant.identity)
          );
        })
        .on(RoomEvent.ParticipantDisconnected, () => {
          // agent 说完收尾语就退房，此时房间里只剩自己 —— 这就是通话结束的信号
          if (room.remoteParticipants.size === 0) {
            setCallStatus(CallStatus.FINISHED);
            room.disconnect();
          }
        });

      await room.connect(serverUrl, token);
      // 浏览器的自动播放策略：远端音频要在这里「解锁」才能出声。
      // handleCall 是点按钮触发的，正好还在用户手势的窗口里。
      await room.startAudio().catch((error) => {
        console.log("startAudio failed:", error);
      });
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (error) {
      console.log("Error:", error);
      roomRef.current?.disconnect();
      roomRef.current = null;
      setCallStatus(CallStatus.INACTIVE);
    }
  };

  const handleDisconnect = () => {
    setCallStatus(CallStatus.FINISHED);
    roomRef.current?.disconnect();
  };

  return (
    <>
      {/* agent 的语音轨挂在这里。display:none 不影响 <audio> 播放 */}
      <div ref={audioContainerRef} className="hidden" />

      <div className="call-view">
        {/* AI Interviewer Card */}
        <div className="card-interviewer">
          <div className="avatar">
            <Image
              src="/ai-avatar.png"
              alt="profile-image"
              width={65}
              height={54}
              className="object-cover"
            />
            {isSpeaking && <span className="animate-speak" />}
          </div>
          <h3>AI Interviewer</h3>
        </div>

        {/* User Profile Card */}
        <div className="card-border">
          <div className="card-content">
            <Image
              src="/user-avatar.png"
              alt="profile-image"
              width={539}
              height={539}
              className="rounded-full object-cover size-[120px]"
            />
            <h3>{userName}</h3>
          </div>
        </div>
      </div>

      {(messages.length > 0 || liveText) && (
        <div className="transcript-border">
          <div className="transcript">
            {/* 实时字幕期间 key 保持不变，否则每来一个 delta 都会重放一次淡入动画 */}
            <p
              key={liveText ? "live" : lastMessage}
              className={cn(
                "transition-opacity duration-500 opacity-0",
                "animate-fadeIn opacity-100"
              )}
            >
              {liveText || lastMessage}
            </p>
          </div>
        </div>
      )}

      <div className="w-full flex justify-center">
        {callStatus !== "ACTIVE" ? (
          <button className="relative btn-call" onClick={() => handleCall()}>
            <span
              className={cn(
                "absolute animate-ping rounded-full opacity-75",
                callStatus !== "CONNECTING" && "hidden"
              )}
            />

            <span className="relative">
              {callStatus === "INACTIVE" || callStatus === "FINISHED"
                ? "Call"
                : ". . ."}
            </span>
          </button>
        ) : (
          <button className="btn-disconnect" onClick={() => handleDisconnect()}>
            End
          </button>
        )}
      </div>
    </>
  );
};

export default Agent;
