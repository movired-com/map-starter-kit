// Script de un solo uso: quita TODAS las propiedades (Jitsi, silent, etc.) de
// las áreas "puesto-*" en el .tmj, dejándolas como áreas simples. La condición
// de "área personal" no vive en el .tmj sino en el .wam, así que vaciar estas
// propiedades no afecta a que sigan siendo personales.
import fs from "fs";

const file = "moviredmapv2026.tmj";
const raw = fs.readFileSync(file, "utf-8");
const map = JSON.parse(raw);

let changed = 0;
for (const layer of map.layers ?? []) {
    if (layer.type !== "objectgroup") continue;
    for (const obj of layer.objects ?? []) {
        if (
            obj?.type === "area" &&
            typeof obj.name === "string" &&
            obj.name.startsWith("puesto-") &&
            Array.isArray(obj.properties) &&
            obj.properties.length > 0
        ) {
            obj.properties = [];
            changed++;
        }
    }
}

// Mantiene el formato "pretty" con 1 espacio de indentación, similar al que
// usa Tiled al exportar.
fs.writeFileSync(file, JSON.stringify(map, null, 1));
console.log(`Propiedades vaciadas en ${changed} puesto(s).`);
