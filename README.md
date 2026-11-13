# Dice Royale — Cross-Platform Mobile & Multiplayer Server

Cross-platform **Android, iOS, and Web** mobile application (Expo React Native) paired with a **Node.js + Express + Socket.IO + SQLite** backend and **Admin Control Center**.

## 1. Free-Tier Deployment (Recommended for ~1,000 Users)
- **Backend + Admin Panel**: Deploy `backend/` to **Render.com** (Free Web Service using `render.yaml`), **Railway**, or **Fly.io**.
  - Admin Panel URL: `https://<your-backend-url>/admin`
  - Default Admin Login: `admin` / `Admin@12345` (change via `ADMIN_PASSWORD` env var).
- **Mobile App (Android & iOS)**:
  1. Update `API_BASE_URL` and `SOCKET_URL` in `mobile-app/src/config.js` to your backend URL.
  2. Run `cd mobile-app && npm install && npx expo start`.
  3. Scan the QR code with **Expo Go** on Android/iOS, or build standalone APK/IPA via **EAS Build** (`npx eas build -p all`).

## 2. Local Quick Start
```bash
# Terminal 1: Start Backend + Admin Panel
cd backend
npm install
npm test
npm start

# Terminal 2: Start Cross-Platform Mobile App (Android / iOS / Web)
cd mobile-app
npm install
npx expo start
```
