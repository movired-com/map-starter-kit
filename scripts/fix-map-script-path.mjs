// Normaliza los separadores de ruta de la propiedad `script` de los mapas
// optimizados en `dist`.
//
// Por qué: en Windows, wa-map-optimizer-vite escribe la propiedad `script` del
// mapa con separadores de Windows (p. ej. "assets\src-main-XXXX.html"). Esa
// ruta no es una URL válida: al servir el mapa por HTTP el navegador no
// interpreta "\" como separador de carpetas, el script del mapa no se carga y
// NINGÚN evento (ni join/exit ni entradas/salidas de áreas) llega al backend.
//
// Este script corre DESPUÉS de `vite build`, cuando el optimizador ya ha
// escrito el .tmj final, y reemplaza "\" por "/" en la propiedad `script`.

import fs from "fs";
import path from "path";

const distDir = path.resolve(process.cwd(), "dist");

if (!fs.existsSync(distDir)) {
    console.warn(`[fix-map-script] No existe la carpeta ${distDir}; nada que hacer.`);
    process.exit(0);
}

/** Devuelve todas las rutas .tmj bajo un directorio, de forma recursiva. */
function findTmjFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return findTmjFiles(full);
        return entry.name.endsWith(".tmj") ? [full] : [];
    });
}

let fixedFiles = 0;

for (const tmjPath of findTmjFiles(distDir)) {
    const raw = fs.readFileSync(tmjPath, "utf-8");

    let map;
    try {
        map = JSON.parse(raw);
    } catch {
        console.warn(`[fix-map-script] ${path.basename(tmjPath)} no es JSON válido; se omite.`);
        continue;
    }

    if (!Array.isArray(map.properties)) continue;

    let changed = false;
    for (const property of map.properties) {
        if (
            property?.name === "script" &&
            typeof property.value === "string" &&
            property.value.includes("\\")
        ) {
            property.value = property.value.replace(/\\/g, "/");
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(tmjPath, JSON.stringify(map));
        fixedFiles++;
        console.info(`[fix-map-script] Ruta del script normalizada en ${path.basename(tmjPath)}`);
    }
}

if (fixedFiles === 0) {
    console.info("[fix-map-script] No hizo falta normalizar ninguna ruta (ya usaban '/').");
}
