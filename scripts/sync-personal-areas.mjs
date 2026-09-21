// Sincroniza las áreas del mapa (.tmj) con el archivo .wam del map-storage de
// WorkAdventure.
//
// Contexto:
//   - Algunas propiedades de área NO existen en el .tmj (Tiled). Son conceptos
//     del Map Editor de WA y viven en el .wam. WA no las deriva del .tmj, así
//     que hay que escribir el .wam nosotros.
//   - Este script refleja en el .wam TODAS las áreas de Tiled (objetos
//     `type: "area"`), garantizando dos cosas:
//       a) Todas las áreas son "searchable" (propiedad areaDescriptionProperties
//          con searchable: true) para que aparezcan en el buscador de WA.
//       b) Las áreas cuyo nombre empieza por "puesto-" son además áreas
//          personales dinámicas (personalAreaPropertyData).
//
// Estrategia (MERGE, no sobrescritura):
//   1. Lee todas las áreas del .tmj local.
//   2. Descarga el .wam remoto actual (GET con Bearer token).
//   3. Para cada área:
//        - si ya existe un área con ese `name` en el .wam, actualiza su
//          geometría (x/y/width/height) y GARANTIZA sus propiedades, pero
//          CONSERVA lo que ya hubiera (id del área, ownerId de un puesto ya
//          reclamado, description existente, etc.).
//        - si no existe, la crea con las propiedades correspondientes.
//   4. No elimina ninguna otra área ni entidad del .wam.
//   5. Sube el .wam fusionado (PUT con Bearer token).
//
// Requiere en el entorno (normalmente cargados desde .env.secret):
//   - MAP_STORAGE_URL      p. ej. https://<mundo>.map-storage.workadventu.re
//   - MAP_STORAGE_API_KEY  token Bearer del map-storage
//   - UPLOAD_DIRECTORY     carpeta del mundo dentro del map-storage
//
// El nombre del .tmj/.wam se toma de MAP_FILE_NAME o, por defecto, del único
// .tmj del directorio actual.

import fs from "fs";
import path from "path";
import crypto from "crypto";

// --- Configuración ---------------------------------------------------------

/** Prefijo de los nombres de área que se tratan como puestos personales. */
const PERSONAL_AREA_PREFIX = "puesto-";

const MAP_STORAGE_URL = requireEnv("MAP_STORAGE_URL").replace(/\/+$/, "");
const MAP_STORAGE_API_KEY = requireEnv("MAP_STORAGE_API_KEY");
const UPLOAD_DIRECTORY = requireEnv("UPLOAD_DIRECTORY").replace(/^\/+|\/+$/g, "");

const mapBaseName = resolveMapBaseName();
const tmjPath = path.resolve(process.cwd(), `${mapBaseName}.tmj`);
const wamRemotePath = `${UPLOAD_DIRECTORY}/${mapBaseName}.wam`;
const wamUrl = `${MAP_STORAGE_URL}/${wamRemotePath}`;

// --- Utilidades ------------------------------------------------------------

function requireEnv(name) {
    const value = process.env[name];
    if (!value || !value.trim()) {
        console.error(`[sync-areas] Falta la variable de entorno ${name}.`);
        console.error("  Asegúrate de cargar .env.secret (p. ej. con dotenv) antes de ejecutar el script.");
        process.exit(1);
    }
    return value.trim();
}

/** Determina el nombre base del mapa (sin extensión). */
function resolveMapBaseName() {
    if (process.env.MAP_FILE_NAME) {
        return process.env.MAP_FILE_NAME.replace(/\.(tmj|wam)$/i, "");
    }
    const tmjFiles = fs
        .readdirSync(process.cwd())
        .filter((f) => f.toLowerCase().endsWith(".tmj"));
    if (tmjFiles.length === 0) {
        console.error("[sync-areas] No se encontró ningún .tmj en el directorio actual.");
        process.exit(1);
    }
    if (tmjFiles.length > 1) {
        console.error(
            `[sync-areas] Hay varios .tmj (${tmjFiles.join(", ")}). ` +
                "Indica cuál usar con la variable MAP_FILE_NAME."
        );
        process.exit(1);
    }
    return tmjFiles[0].replace(/\.tmj$/i, "");
}

/** ¿Es un área que debe ser personal (puesto)? */
function isPersonalArea(name) {
    return typeof name === "string" && name.startsWith(PERSONAL_AREA_PREFIX);
}

// --- 1) Leer todas las áreas del .tmj --------------------------------------

/**
 * Extrae del .tmj todas las áreas de Tiled (objetos `type: "area"`). Devuelve
 * su geometría y nombre.
 */
function readAreasFromTmj(tmjFilePath) {
    const raw = fs.readFileSync(tmjFilePath, "utf-8");
    const map = JSON.parse(raw);

    const areas = [];
    for (const layer of map.layers ?? []) {
        if (layer.type !== "objectgroup") continue;
        for (const obj of layer.objects ?? []) {
            if (obj?.type === "area" && typeof obj.name === "string" && obj.name) {
                areas.push({
                    name: obj.name,
                    x: obj.x,
                    y: obj.y,
                    width: obj.width,
                    height: obj.height,
                });
            }
        }
    }
    return areas;
}

// --- 2) Descargar el .wam remoto -------------------------------------------

async function fetchRemoteWam() {
    const res = await fetch(wamUrl, {
        headers: { Authorization: `Bearer ${MAP_STORAGE_API_KEY}` },
    });
    if (res.status === 404) {
        console.error(
            `[sync-areas] El .wam remoto no existe todavía (${wamRemotePath}). ` +
                "Sube el mapa una primera vez (npm run upload) para que WA cree el .wam, y vuelve a ejecutar."
        );
        process.exit(1);
    }
    if (!res.ok) {
        throw new Error(`GET ${wamUrl} devolvió ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`El .wam remoto no es JSON válido: ${e.message}`);
    }
}

// --- 3) Merge de áreas ------------------------------------------------------

/** Crea una propiedad personalAreaPropertyData nueva (puesto sin dueño). */
function newPersonalAreaProperty() {
    return {
        id: crypto.randomUUID(),
        type: "personalAreaPropertyData",
        accessClaimMode: "dynamic",
        allowedTags: [],
        ownerId: null,
    };
}

/** Crea una propiedad areaDescriptionProperties nueva con searchable: true. */
function newDescriptionProperty() {
    return {
        id: crypto.randomUUID(),
        type: "areaDescriptionProperties",
        description: "",
        searchable: true,
    };
}

/**
 * Garantiza en el array de propiedades:
 *   - areaDescriptionProperties con searchable: true (para todas las áreas).
 *   - personalAreaPropertyData (solo para puestos).
 * Conserva las propiedades existentes y sus valores (id, ownerId, description).
 */
function ensureProperties(properties, { personal }) {
    const result = Array.isArray(properties) ? [...properties] : [];

    // a) searchable para todas las áreas.
    const desc = result.find((p) => p?.type === "areaDescriptionProperties");
    if (desc) {
        // Conserva id y description; solo asegura searchable: true.
        desc.searchable = true;
    } else {
        result.push(newDescriptionProperty());
    }

    // b) área personal solo para puestos.
    if (personal) {
        const hasPersonal = result.some((p) => p?.type === "personalAreaPropertyData");
        if (!hasPersonal) {
            result.push(newPersonalAreaProperty());
        }
    }

    return result;
}

/**
 * Devuelve el objeto área (formato .wam) para un área del .tmj, reutilizando el
 * área existente si ya está en el .wam (para conservar id, ownerId, etc.).
 */
function buildWamArea(tmjArea, existingArea) {
    const personal = isPersonalArea(tmjArea.name);

    if (existingArea) {
        return {
            ...existingArea,
            name: tmjArea.name,
            x: tmjArea.x,
            y: tmjArea.y,
            width: tmjArea.width,
            height: tmjArea.height,
            visible: existingArea.visible ?? true,
            properties: ensureProperties(existingArea.properties, { personal }),
        };
    }

    return {
        id: crypto.randomUUID(),
        name: tmjArea.name,
        x: tmjArea.x,
        y: tmjArea.y,
        width: tmjArea.width,
        height: tmjArea.height,
        visible: true,
        properties: ensureProperties([], { personal }),
    };
}

function mergeAreas(wam, tmjAreas) {
    if (!Array.isArray(wam.areas)) wam.areas = [];

    // Indexa las áreas existentes por nombre para el merge.
    const existingByName = new Map();
    for (const area of wam.areas) {
        if (area && typeof area.name === "string") {
            existingByName.set(area.name, area);
        }
    }

    let created = 0;
    let updated = 0;

    for (const tmjArea of tmjAreas) {
        const existing = existingByName.get(tmjArea.name);
        const merged = buildWamArea(tmjArea, existing);
        if (existing) {
            const idx = wam.areas.indexOf(existing);
            wam.areas[idx] = merged;
            updated++;
        } else {
            wam.areas.push(merged);
            created++;
        }
    }

    return { created, updated };
}

// --- 4) Subir el .wam -------------------------------------------------------

async function putRemoteWam(wam) {
    const res = await fetch(wamUrl, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${MAP_STORAGE_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(wam, null, 2),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`PUT ${wamUrl} devolvió ${res.status} ${res.statusText}. ${body}`);
    }
}

// --- Orquestación -----------------------------------------------------------

async function main() {
    console.info(`[sync-areas] Mapa: ${mapBaseName}`);
    console.info(`[sync-areas] .wam remoto: ${wamUrl}`);

    const tmjAreas = readAreasFromTmj(tmjPath);
    const personalCount = tmjAreas.filter((a) => isPersonalArea(a.name)).length;
    console.info(
        `[sync-areas] Áreas encontradas en el .tmj: ${tmjAreas.length} ` +
            `(de ellas ${personalCount} puesto(s) personal(es)).`
    );
    if (tmjAreas.length === 0) {
        console.warn("[sync-areas] No hay áreas que sincronizar. Nada que hacer.");
        return;
    }

    const wam = await fetchRemoteWam();
    const { created, updated } = mergeAreas(wam, tmjAreas);

    await putRemoteWam(wam);

    console.info(
        `[sync-areas] Hecho: ${created} área(s) creada(s), ${updated} actualizada(s). ` +
            "Todas quedan searchable; los puestos siguen siendo personales. " +
            "Se conservaron el resto de áreas y los propietarios ya asignados."
    );
}

main().catch((err) => {
    console.error(`[sync-areas] Error: ${err.message}`);
    process.exit(1);
});
