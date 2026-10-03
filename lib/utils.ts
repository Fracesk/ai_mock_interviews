import { interviewCovers, mappings } from "@/constants";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

const techIconBaseURL = "https://cdn.jsdelivr.net/gh/devicons/devicon/icons";

const normalizeTechName = (tech: string) => {
    const key = tech.toLowerCase().replace(/\.js$/, "").replace(/\s+/g, "");
    return mappings[key as keyof typeof mappings];
};

const checkIconExists = async (url: string) => {
    try {
        const response = await fetch(url, { method: "HEAD" });
        return response.ok; // Returns true if the icon exists
    } catch {
        return false;
    }
};

export const getTechLogos = async (techArray: string[]) => {
    const logoURLs = techArray.map((tech) => {
        const normalized = normalizeTechName(tech);
        return {
            tech,
            url: `${techIconBaseURL}/${normalized}/${normalized}-original.svg`,
        };
    });

    const results = await Promise.all(
        logoURLs.map(async ({ tech, url }) => ({
            tech,
            url: (await checkIconExists(url)) ? url : "/tech.svg",
        }))
    );

    return results;
};

/**
 * 按 seed 稳定地挑一张封面 —— **同一个 seed 永远给同一张**。
 *
 * 以前这里叫 getRandomInterviewCover()，每次调用都 Math.random()，而调用点在组件的
 * render 里，于是同一张卡片每刷新一次就换一张图，doc 里存好的 coverImage 压根没人读。
 * 封面必须是「这个面试的封面」，不能是「这次渲染的封面」，所以改成用 id 做 seed。
 */
export const getInterviewCoverFor = (seed: string) => {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        // |0 把结果压回 32 位整数，避免长 id 累加溢出成浮点
        hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    return `/covers${interviewCovers[Math.abs(hash) % interviewCovers.length]}`;
};
