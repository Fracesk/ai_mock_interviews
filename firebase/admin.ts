// import { getAuth } from "firebase-admin/auth";
// import { getFirestore } from "firebase-admin/firestore";
// import { getApps, initializeApp, cert } from "firebase-admin/app";



// const initFirebaseAdmin = () => {
//     const apps = getApps();

//     if (!apps.length) {
//         initializeApp({
//             credential: cert({
//                 projectId: process.env.FIREBASE_PROJECT_ID,
//                 clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
//                 privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(
//                     /\\n/g,
//                     "\n"
//                 ),
//             })
//         });
//     }

//     return {
//         auth: getAuth(),
//         db: getFirestore(),
//     };
// };

// export const { auth, db } = initFirebaseAdmin();

import { createRequire } from "module";

const require = createRequire(import.meta.url);

// 1. 使用 createRequire 绕过 Next.js/Turbopack 的打包静态分析
const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

// 2. 初始化 Firebase Admin App
function getAdminApp() {
  const apps = getApps();
  if (apps.length > 0) {
    return apps[0];
  }

  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
}

// 3. 核心关键：导出 Getter 函数（按需延迟调用），绝对不要在顶层直接执行！
export const getAdminAuth = () => {
  getAdminApp();
  return getAuth();
};

export const getAdminDb = () => {
  getAdminApp();
  return getFirestore();
};
