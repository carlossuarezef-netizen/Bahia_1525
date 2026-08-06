# Bahía 1525 — Sistema POS
### Del amanecer al brindis

Sistema de punto de venta, inventario y caja para Bahía 1525. Es una app web estática (HTML + CSS + JavaScript, sin paso de compilación) que usa **Firebase Firestore** como base de datos. Esto significa que puedes alojar el sitio gratis en **GitHub Pages** y toda la lógica de datos vive en Firebase.

```
bahia-pos/
├── index.html
├── css/style.css
├── js/firebase-config.js   ← aquí van tus credenciales de Firebase
├── js/app.js                ← toda la lógica del sistema
├── firestore.rules
└── firestore.indexes.json
```

---

## 1. Cómo funciona la relación GitHub Pages ↔ Firebase

Es un punto importante para no confundirse:

- **GitHub Pages** solo sirve archivos estáticos (HTML/CSS/JS). Ahí vive el *frontend*: lo que ves y usas en el navegador (POS, mesas, caja, admin).
- **Firebase Firestore** es la base de datos en la nube. El navegador se conecta directo a Firestore desde el JavaScript de la página — no necesitas un servidor propio.
- **Firebase Cloud Functions** (para la facturación electrónica DIAN) es un tercer componente que **no puede vivir en GitHub Pages** porque requiere ejecutar código en un servidor. Esa parte se despliega aparte, directamente en Firebase, usando el plan Blaze (pago por uso, tiene capa gratuita generosa). El resto del sistema (POS, inventario, caja, egresos) funciona igual sin necesidad de activar Functions todavía.

En resumen: **GitHub Pages = dónde vive la página. Firebase = dónde viven los datos (y, más adelante, la facturación DIAN).**

---

## 2. Crear el proyecto de Firebase

1. Ve a [console.firebase.google.com](https://console.firebase.google.com) → **Crear proyecto** → nómbralo `bahia-1525` (o el que prefieras).
2. Dentro del proyecto: **Compilación → Firestore Database → Crear base de datos** → modo producción → elige la región más cercana (ej. `southamerica-east1`).
3. Ve a **Configuración del proyecto (⚙️) → General → Tus apps → Agregar app → Web (</>)**. Ponle un nombre y **NO** marques Firebase Hosting (usaremos GitHub Pages).
4. Copia el objeto `firebaseConfig` que te muestra y pégalo en `js/firebase-config.js`, reemplazando los valores `"TU_..."`.

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "bahia-1525.firebaseapp.com",
  projectId: "bahia-1525",
  storageBucket: "bahia-1525.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef",
};
```

> Estos valores no son secretos — es normal que estén visibles en el código de una app web. Lo que realmente protege tus datos son las **reglas de Firestore** (paso siguiente).

---

## 3. Publicar las reglas de seguridad

Necesitas el CLI de Firebase (una sola vez):

```bash
npm install -g firebase-tools
firebase login
```

Dentro de la carpeta `bahia-pos`:

```bash
firebase init firestore
# Elige "usar un proyecto existente" → selecciona bahia-1525
# Cuando pregunte por el archivo de reglas, usa el firestore.rules que ya está en esta carpeta
# Cuando pregunte por índices, usa firestore.indexes.json que ya está en esta carpeta

firebase deploy --only firestore:rules,firestore:indexes
```

Esto sube las reglas y los índices compuestos que las consultas del sistema necesitan (por ejemplo, filtrar ventas por turno).

---

## 4. Crear tu primer usuario administrador

El sistema no tiene una pantalla de "crear cuenta": los usuarios (meseros, cajeros, administrador) se crean como documentos en Firestore. Para el primer ingreso:

1. En Firebase Console → Firestore Database → **Iniciar colección**.
2. Ruta: `organizations/bahia1525/users`
3. Crea un documento con estos campos:

| Campo | Tipo | Valor de ejemplo |
|---|---|---|
| name | string | Administrador |
| role | string | admin_contador |
| pin | string | 1234 |
| active | boolean | true |

Con ese PIN ya puedes entrar al sistema y crear desde ahí (o desde la misma consola) al resto del equipo: meseros y cajeros con `role: "mesero"` o `role: "cajero"`.

> El campo `orgId` usado en todo el sistema es `bahia1525` (definido en `js/firebase-config.js`, constante `ORG_ID`). Si prefieres otro nombre, cámbialo ahí antes de crear los datos.

---

## 5. Publicar el sitio en GitHub Pages

1. Crea un repositorio nuevo en GitHub (público o privado con GitHub Pro/Team, ya que Pages en repos privados requiere plan de pago).
2. Sube el contenido de esta carpeta (`bahia-pos/`) a la raíz del repositorio:

```bash
cd bahia-pos
git init
git add .
git commit -m "Sistema POS Bahía 1525"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/bahia-pos.git
git push -u origin main
```

3. En GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"** → Branch: `main` / carpeta `/ (root)` → **Save**.
4. En un par de minutos tu sistema estará disponible en `https://TU_USUARIO.github.io/bahia-pos/`.

Desde ese momento, cada vez que hagas `git push`, GitHub Pages actualiza el sitio automáticamente.

---

## 6. Autorizar el dominio en Firebase

Para que Firestore acepte conexiones desde tu sitio de GitHub Pages:

1. Firebase Console → **Authentication → Settings → Authorized domains** → agrega `TU_USUARIO.github.io`.
2. (Si más adelante activas Firebase Auth real en vez del PIN simple, este paso es obligatorio; con Firestore solo, es una buena práctica de todas formas.)

---

## 7. Facturación electrónica DIAN (paso posterior, vía Cloud Functions)

Esta parte **no va en GitHub Pages** — se despliega directo en Firebase:

```bash
firebase init functions   # elige JavaScript
cd functions
npm install axios
```

Pega la función `emitInvoice` del documento de arquitectura (`bahia-1525-arquitectura.md`) en `functions/index.js`, configura las credenciales de tu proveedor tecnológico autorizado (Factus, Siigo, etc.) como variables de entorno:

```bash
firebase functions:config:set factus.token="TU_TOKEN" factus.range_id="TU_RANGO"
firebase deploy --only functions
```

Esto requiere el plan **Blaze** de Firebase (pago por uso — las Functions no están en el plan gratuito Spark), pero tiene una capa gratuita mensual amplia que normalmente cubre el volumen de un solo restaurante.

---

## 8. Primeros pasos dentro del sistema ya desplegado

1. Entra con el PIN del administrador que creaste.
2. Ve a **Administración** → crea tus categorías reales (si quieres otras distintas a las 3 por defecto) y tus productos con precio y, si aplica, stock inicial.
3. Ve a **Caja** → abre el turno con la base inicial en efectivo.
4. Ve a **Salón** → las 10 mesas se crean automáticamente la primera vez; empieza a tomar pedidos.
5. Al final del turno, vuelve a **Caja** → **Cerrar caja** (pide PIN de administrador) para ver el cuadre del día.

---

## 9. Lo que queda como siguiente iteración

- Editor visual de **recetas** (ingrediente + cantidad por producto) — hoy se maneja creando documentos en `/recipes` desde la consola de Firestore; es sencillo pero conviene una pantalla propia.
- Exportar cierres de caja a Excel/PDF con formato ejecutivo.
- Migrar el login de PIN-en-Firestore a **Firebase Authentication** para mayor seguridad en producción real (hoy el PIN se valida contra un documento legible, funcional para operar pero no es el estándar más robusto a largo plazo).
- División de cuentas entre varios comensales dentro de una misma mesa.
