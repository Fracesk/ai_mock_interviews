// Import the functions you need from the SDKs you need
import { initializeApp, getApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// import { getAnalytics } from "firebase/analytics";

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDX_ZKjlvhVcjHUmvWIpGgczzQXRX5xoJ8",
  authDomain: "prepwise-23825.firebaseapp.com",
  projectId: "prepwise-23825",
  storageBucket: "prepwise-23825.firebasestorage.app",
  messagingSenderId: "450484969907",
  appId: "1:450484969907:web:715031054002ae575babc6",
  measurementId: "G-6QTRRQN0Z0"
};

// Initialize Firebase
const app = !getApps.length ? initializeApp(firebaseConfig) : getApp();
// const analytics = getAnalytics(app);

export const auth = getAuth(app);
export const db = getFirestore(app);