/// <reference types="@workadventure/iframe-api-typings" />

import { bootstrapExtra } from "@workadventure/scripting-api-extra";

/**
 * Script del mapa para GatherControl.
 *
 * Envía eventos de presencia (entrar/salir del mapa) y de estancia en las
 * áreas/salas del mapa al backend, que los traduce a horas trabajadas y, para
 * la Cafetería/COMEDOR, al descuento de comida (sustituye a Gather).
 *
 * IMPORTANTE — áreas del Map Editor de WorkAdventure:
 *   Las áreas creadas con el Map Editor visual de WA usan el namespace
 *   `WA.mapEditor.area.*` (NO `WA.room.area.*`, que es para áreas de Tiled).
 */

// --- Configuración ---------------------------------------------------------
// URL pública del backend (túnel ngrok -> http://localhost:3001).
// Si reinicias ngrok y cambia el subdominio, actualiza esta URL.
const BACKEND_URL = "https://gather.movired.com/api/wa/events";
// Debe coincidir con WA_INGEST_TOKEN del backend (.env.dev).
const INGEST_TOKEN = "4e7be2e8f5d8562929a4d830b96f724c2a1dbe26635ebf2140d000abb8859db8";
// ---------------------------------------------------------------------------

console.info("Script started successfully");

let currentPopup: any = undefined;

// --- Aviso de conexión -----------------------------------------------------
// El backend está en una MV de AWS con un grupo de seguridad que solo admite
// ciertas IPs públicas. Si la IP del usuario no está autorizada, el fetch da
// timeout y su fichaje NO se registra. Como no podemos avisar desde el backend
// (la petición ni llega), detectamos el fallo aquí y mostramos un banner.
const CONNECTION_BANNER_ID = "gathercontrol-connection-error";
const FETCH_TIMEOUT_MS = 8000; // corte rápido en vez del timeout largo del navegador
let connectionBannerShown = false;

function showConnectionBanner(): void {
    if (connectionBannerShown) return; // mostrar una sola vez
    connectionBannerShown = true;
    try {
        WA.ui.banner.openBanner({
            id: CONNECTION_BANNER_ID,
            text:
                "No se está registrando tu fichaje: no hay conexión con el sistema. " +
                "Puede que tu IP no esté autorizada. Cambia tu IP si puedes, o contacta " +
                "con alguien que tenga acceso para autorizarla.",
            bgColor: "#b00020",
            textColor: "#ffffff",
            closable: true,
            timeToClose: 0, // no se cierra solo
        });
    } catch (e) {
        console.warn("[WA-script] No se pudo mostrar el banner de conexión:", e);
    }
}

function hideConnectionBanner(): void {
    if (!connectionBannerShown) return;
    connectionBannerShown = false;
    try {
        WA.ui.banner.closeBanner();
    } catch {
        // Si la API no está disponible, no pasa nada.
    }
}

/**
 * Envía un evento al backend. `keepalive` permite que la petición sobreviva al
 * cierre de la pestaña (para el evento de salida).
 *
 * Si la conexión falla (timeout por IP no autorizada, red caída, etc.), muestra
 * un banner de aviso al usuario. Si una petición vuelve a funcionar, lo retira.
 */
function sendEvent(
    payload: Record<string, unknown>,
    keepalive = false
): void {
    // Timeout corto para no quedarnos colgados esperando el timeout del navegador.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(BACKEND_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-wa-token": INGEST_TOKEN,
        },
        body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
        keepalive,
        credentials: "omit",
        signal: controller.signal,
    })
        .then(() => {
            // La petición llegó al servidor: la conexión funciona.
            hideConnectionBanner();
        })
        .catch((err) => {
            console.error("[WA-script] Error enviando evento:", err);
            showConnectionBanner();
        })
        .finally(() => clearTimeout(timeoutId));
}

// Waiting for the API to be ready
WA.onInit().then(async () => {
    console.info("Scripting API ready");

    // Identidad del usuario: usamos el userRoomToken de WorkAdventure, que
    // contiene el email del usuario logueado (claim `user`). El backend lo
    // decodifica y casa con la tabla de usuarios. Requiere que el usuario
    // haya iniciado sesión en WorkAdventure (SSO Teams en producción).
    const waToken = WA.player.userRoomToken || null;
    const playerName = WA.player.name || "Unknown Player";

    if (!waToken) {
        console.warn(
            "[WA-script] No hay userRoomToken (¿usuario anónimo?). Los eventos no " +
                "se podrán casar con un usuario. El usuario debe iniciar sesión."
        );
    }

    const base = { waToken, playerName };

    // --- Control de presencia (join/exit) ----------------------------------
    // PROBLEMA que resuelve este bloque:
    //   El navegador dispara `pagehide`/`beforeunload` en MUCHAS situaciones que
    //   NO son un cierre de pestaña: cambiar de pestaña, minimizar, bloquear el
    //   equipo, o cuando el navegador congela/aparca la pestaña (bfcache). Si
    //   enviamos un `exit` en cada uno de esos casos, el backend cierra la
    //   jornada y, al volver el usuario, se emite otro `join`. Ese hueco entre
    //   el `exit` falso y el `join` siguiente se PIERDE en el cómputo de horas
    //   (el backend solo suma el tiempo dentro de pares join→exit). Además,
    //   `pagehide` y `beforeunload` suelen dispararse juntos → `exit` duplicados.
    //
    // SOLUCIÓN:
    //   - Un único punto de envío con deduplicación de estado (`presenceState`),
    //     para no mandar dos `join` ni dos `exit` seguidos.
    //   - `exit` SOLO en un cierre real: `pagehide` con `event.persisted === false`.
    //     Si `persisted === true`, la página va al bfcache (sigue "viva"): NO es
    //     salida.
    //   - `visibilitychange` NO envía `exit` (ocultar la pestaña no es irse); solo
    //     se usa para re-anunciar presencia al volver si hiciera falta.
    //   - `pageshow` (restauración desde bfcache) re-anuncia `join` si el estado
    //     había quedado como "fuera".
    type PresenceState = "in" | "out";
    let presenceState: PresenceState = "out";

    const sendJoin = (wokaPicture?: string): void => {
        if (presenceState === "in") return; // ya dentro: no duplicar
        presenceState = "in";
        sendEvent({ ...base, type: "join", ...(wokaPicture ? { wokaPicture } : {}) });
    };

    const sendExit = (): void => {
        if (presenceState === "out") return; // ya fuera: no duplicar
        presenceState = "out";
        sendEvent({ ...base, type: "exit" }, true);
    };

    // 1) JOIN: el jugador ha entrado al mapa. Adjuntamos la imagen del Woka
    //    (data-URI PNG base64) para que el backend la use como avatar del
    //    usuario. getWokaPicture es asíncrono; si falla, enviamos el join igual.
    let wokaPicture: string | undefined;
    try {
        wokaPicture = await WA.player.getWokaPicture();
    } catch (e) {
        console.warn("[WA-script] No se pudo obtener el Woka:", e);
    }
    sendJoin(wokaPicture);

    // 2) EXIT: SOLO en un cierre/descarga real de la página.
    //    `pagehide` con `persisted === true` significa que la página se guarda en
    //    el bfcache (cambio de pestaña, navegación atrás/adelante, congelado):
    //    NO es una salida, así que la ignoramos. Solo `persisted === false` es
    //    una descarga real de la pestaña.
    //    NO usamos `beforeunload`: se dispara junto con `pagehide` (exit doble) y
    //    también en falsos positivos.
    window.addEventListener("pagehide", (event: PageTransitionEvent) => {
        if (event.persisted) {
            // Va al bfcache: la página sigue viva. No es salida.
            console.info("[WA-script] pagehide (bfcache) ignorado: no es salida.");
            return;
        }
        sendExit();
    });

    // 3) Ocultar/mostrar pestaña: NO cuenta como salida. Al volver a estar
    //    visible, re-aseguramos que el backend nos tiene como presentes (por si
    //    algún `exit` se coló o el iframe se recargó). `sendJoin` es idempotente.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            sendJoin();
        }
    });

    // 4) Restauración desde bfcache: si volvemos y el estado había quedado como
    //    "fuera", re-anunciar presencia. Si seguíamos "dentro", no hace nada.
    window.addEventListener("pageshow", (event: PageTransitionEvent) => {
        if (event.persisted) {
            sendJoin();
        }
    });

    // 3) SALAS: nos suscribimos a TODAS las áreas del mapa. Cada entrada/salida
    //    se envía al backend con el nombre del área. El backend decide qué hacer
    //    con cada una (la que coincida con una Room en BD se registra; la
    //    Cafetería/COMEDOR aplica además el descuento de comida). Así, añadir una
    //    sala nueva solo requiere crear el área en el mapa: no hay que tocar este
    //    script.
    //
    //    Las áreas de ESTE mapa están definidas como objetos de Tiled
    //    (`type: "area"` en la capa de objetos `zonas`), NO con el Map Editor
    //    visual de WA. Por eso se detectan con `WA.room.area.*` y no con
    //    `WA.mapEditor.area.*`. Además, cubrimos también las áreas del Map Editor
    //    por si en el futuro se crean desde el editor visual.
    const subscribeArea = (areaName: string) => {
        WA.room.area.onEnter(areaName).subscribe(() => {
            sendEvent({ ...base, type: "enterArea", area: areaName });
            console.info(`[WA-script] Entró en ${areaName}`);
        });
        WA.room.area.onLeave(areaName).subscribe(() => {
            sendEvent({ ...base, type: "leaveArea", area: areaName });
            console.info(`[WA-script] Salió de ${areaName}`);
        });
    };

    // 3a) Áreas de Tiled: las extraemos del propio mapa para no tener que
    //     mantener una lista de nombres a mano.
    try {
        const tiledMap = await WA.room.getTiledMap();
        const tiledAreaNames = new Set<string>();
        for (const layer of tiledMap.layers ?? []) {
            if (layer.type !== "objectgroup") continue;
            for (const obj of (layer as any).objects ?? []) {
                if (obj?.type === "area" && typeof obj.name === "string" && obj.name) {
                    tiledAreaNames.add(obj.name);
                }
            }
        }
        console.info("[WA-script] Áreas de Tiled:", [...tiledAreaNames]);
        for (const areaName of tiledAreaNames) {
            subscribeArea(areaName);
        }
    } catch (e) {
        console.warn("[WA-script] No se pudieron leer las áreas de Tiled del mapa:", e);
    }

    // 3b) Áreas del Map Editor visual de WA (si las hubiera).
    try {
        const areas = await WA.mapEditor.area.list();
        console.info(
            "[WA-script] Áreas del Map Editor:",
            areas.map((a) => a.name)
        );
        for (const area of areas) {
            const areaName = area.name;
            WA.mapEditor.area.onEnter(areaName).subscribe(({ reason }) => {
                if (reason === "initial") return;
                sendEvent({ ...base, type: "enterArea", area: areaName });
                console.info(`[WA-script] Entró en ${areaName}`);
            });
            WA.mapEditor.area.onLeave(areaName).subscribe(({ reason }) => {
                if (reason === "initial") return;
                sendEvent({ ...base, type: "leaveArea", area: areaName });
                console.info(`[WA-script] Salió de ${areaName}`);
            });
        }
    } catch (e) {
        console.warn("[WA-script] No se pudieron listar/suscribir las áreas del Map Editor:", e);
    }

    console.info(
        `[WA-script] Inicializado para ${playerName} (${waToken ? "con token" : "sin sesión"}).`
    );

    // Ejemplo original del starter kit (área 'clock' de Tiled). Se deja por si
    // el mapa aún la tiene; no molesta si no existe.
    WA.room.area.onEnter("clock").subscribe(() => {
        const today = new Date();
        const time = today.getHours() + ":" + today.getMinutes();
        currentPopup = WA.ui.openPopup("clockPopup", "It's " + time, []);
    });
    WA.room.area.onLeave("clock").subscribe(closePopup);

    // Bootstrap de la librería de features avanzadas del starter kit.
    bootstrapExtra()
        .then(() => {
            console.info("Scripting API Extra ready");
        })
        .catch((e) => console.error(e));
}).catch((e) => console.error(e));

function closePopup() {
    if (currentPopup !== undefined) {
        currentPopup.close();
        currentPopup = undefined;
    }
}

export {};
