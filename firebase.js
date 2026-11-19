// firebase.js
// Khởi tạo Firebase (SDK v10 qua CDN) cho Authentication và Firestore.
// Gói Spark miễn phí: không dùng Storage.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Cấu hình công khai của web (không phải khóa bí mật)
const firebaseConfig = {
  apiKey: "AIzaSyDMoEZ0mZu2OMdh73NwPM9TFtSbROEtvB4",
  authDomain: "thpt-quiz-app-phong.firebaseapp.com",
  projectId: "thpt-quiz-app-phong",
  storageBucket: "thpt-quiz-app-phong.firebasestorage.app",
  messagingSenderId: "116564713414",
  appId: "1:116564713414:web:583dcdbf614cf5df539cc7",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const db = getFirestore(app);

async function loginGoogle() {
  const credential = await signInWithPopup(auth, googleProvider);
  return credential.user;
}

async function loginEmail(email, pass) {
  const credential = await signInWithEmailAndPassword(auth, email, pass);
  return credential.user;
}

async function registerEmail(email, pass) {
  const credential = await createUserWithEmailAndPassword(auth, email, pass);
  return credential.user;
}

async function logout() {
  await signOut(auth);
}

function onUser(callback) {
  return onAuthStateChanged(auth, callback);
}

export {
  app,
  auth,
  db,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  deleteDoc,
  loginGoogle,
  loginEmail,
  registerEmail,
  logout,
  onUser,
};
