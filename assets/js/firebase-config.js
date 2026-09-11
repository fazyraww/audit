/* ============================================================
   FinAudit Firebase Config
   CARA ISI (5 menit, sekali saja):
   1. Buka https://console.firebase.google.com → Add project
      (nama bebas, mis. "finaudit"; Analytics boleh OFF).
   2. Build → Authentication → Sign-in method → Enable
      "Email/Password" DAN "Google".
   3. Authentication → Settings → Authorized domains → Add domain:
      audit-ebon-sigma.vercel.app
   4. Build → Firestore Database → Create database → Start in
      production mode (region bebas, mis. asia-southeast1) →
      tab Rules → tempel rules dari chat/panduan → Publish.
   5. Project Overview → Add app (ikon </>) → Register app →
      salin object firebaseConfig → tempel di bawah menggantikan null.
   6. Commit + push → Vercel redeploy otomatis.

   apiKey di bawah AMAN untuk publik (bukan rahasia).
   Yang menjaga keamanan adalah Firestore Rules (per-user).
   ============================================================ */
// Your web app's Firebase configuration (project: audit-19624)
window.FINAUDIT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAZvUdFJnr5Efa-3qqsP4t_uZrLQeRGLY8",
  authDomain: "audit-19624.firebaseapp.com",
  projectId: "audit-19624",
  storageBucket: "audit-19624.firebasestorage.app",
  messagingSenderId: "63111198726",
  appId: "1:63111198726:web:ed6d3d3ca2c451620beb87"
};

/* Batasi akun Google yang boleh masuk & mengakses data cloud.
   - Terisi (seperti di bawah) = HANYA email itu yang bisa login.
   - Kosongkan menjadi [] = semua akun Google boleh masuk
     (masing-masing tetap punya vault cloud sendiri, tidak saling lihat). */
window.FINAUDIT_ALLOWED_EMAILS = ['fahmifahrezy823@gmail.com'];

/* Client ID OAuth Web (PUBLIK, bukan rahasia — tampil di setiap URL login
   Google). Dipakai jalur login tahan-ITP khusus iOS/Safari (token GIS +
   signInWithCredential, memintas handler redirect yang digunting ITP).
   Diambil dari: Firebase Console → Authentication → Sign-in method →
   Google → Web SDK configuration, atau endpoint getProjectConfig. */
window.FINAUDIT_GOOGLE_CLIENT_ID = '63111198726-03kv11agremej04panr23krkq2skg7df.apps.googleusercontent.com';
