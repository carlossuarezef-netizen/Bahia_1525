// ============================================================
//  CONFIGURACIÓN DE FIREBASE
//  Reemplaza estos valores con los de tu propio proyecto:
//  Firebase Console → Configuración del proyecto → General →
//  "Tus apps" → App web → SDK setup and configuration → Config
//
//  Estos valores NO son secretos: es normal y seguro que sean
//  públicos en un sitio estático. La seguridad real la dan las
//  Reglas de Firestore (firestore.rules), no este archivo.
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyB-B9xca4EQ4l4dzVcME7wnXYJRWyuM3FA",
  authDomain: "bahia1525.firebaseapp.com",
  projectId: "bahia1525",
  storageBucket: "bahia1525.firebasestorage.app",
  messagingSenderId: "188787530717",
  appId: "1:188787530717:web:26cd2643781cc1d34e7434",
};

// Identificador de la organización dentro de Firestore.
// Todo el sistema vive bajo /organizations/{ORG_ID}/...
export const ORG_ID = "bahia1525";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore-lite.js";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// NOTA: La persistencia offline (enableIndexedDbPersistence) se
// desactivó porque mantiene un canal de sincronización constante
// en segundo plano (verás peticiones repetidas tipo "channel?VER=8..."
// en la pestaña Network) que puede sumar lentitud si la conexión
// a internet no es muy estable. Si más adelante quieres recuperar
// el modo offline, se puede reactivar aquí, evaluando ese costo.
//
// import { enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
// enableIndexedDbPersistence(db).catch((err) => console.warn("Persistencia offline no disponible:", err.code));
