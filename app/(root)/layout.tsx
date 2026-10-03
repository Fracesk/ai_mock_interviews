import Link from "next/link";
import { ReactNode } from "react";
import Image from "next/image";
import { isAuthenticated } from "@/lib/actions/auth.action";
import { redirect } from "next/navigation";

const RootLayout = async ({ children }: { children: ReactNode }) => {
    /*
     * (root) 分组 = 已登录才能进的应用。子页面普遍写 user?.id!（断言 user 非空），
     * 未登录时那个 undefined 会被原样塞进 Firestore 查询并直接抛错，整页 500。
     * 2026-10-03 线上就是这么挂的：未登录访问 / 和 /interview/[id] 都是 500。
     * 在这一处挡住即可；(auth) 分组在 (root) 之外，不会打到 /sign-in，也不会循环。
     */
    const isUserAuthenticated = await isAuthenticated(); 
    if (!isUserAuthenticated) redirect("/sign-in"); 
    return (
        <div className="root-layout">
            <nav>
                <Link
                    href="/"
                    className="flex items-center gap-2"
                >
                    <Image
                        src="/logo.svg"
                        alt="Logo"
                        width={38}
                        height={32}
                    />
                    <h2 className="text-primary-100 text-lg font-bold">
                        PrepWise
                    </h2>
                </Link>
            </nav>
            {children}
        </div>
    );
};

export default RootLayout;
