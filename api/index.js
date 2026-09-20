const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 1. INICIALIZACIONES Y VARIABLES GLOBALES (Redespliegue de caché)

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos de /public y la ruta principal /
app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/estado', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/devices', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/devices.html'));
});

const { Redis } = require('@upstash/redis');

// Inicializar cliente de Redis (Upstash) con fallback seguro
let redis = null;
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || 'https://composed-heron-94035.upstash.io';
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAW9TAAIgcDJjOWY1YjBiMDg1NDE0NTU5OGM2MTJhMjllZjc4MGY0Yw';

if (redisUrl && redisToken) {
    try {
        redis = new Redis({
            url: redisUrl,
            token: redisToken,
        });
        console.log('[REDIS] Cliente Upstash Redis inicializado correctamente.');
    } catch (e) {
        console.error('[REDIS ERROR] Error inicializando Redis:', e.message);
    }
}

// Memoria compartida en Vercel
global.devices = global.devices || {};
global.persistentStore = global.persistentStore || {};
global.aliases = global.aliases || {};
global.guestNames = global.guestNames || {};
global.pendingStates = global.pendingStates || {};

const BOT_TOKEN = "8541967821:AAGaTrOzPG9s_hRn2VnIOyq7-d21_XwJZ38";
const TMP_FILE = '/tmp/monitor-luz-devices.json';
const ALIAS_FILE = '/tmp/monitor-luz-aliases.json';
const GUEST_FILE = '/tmp/monitor-luz-guest-names.json';

// UMBRAL UNIFICADO DE DESCONEXIÓN: 8.5 minutos (510 segundos)
// Proporciona margen sólido contra micro-cortes de internet (Telemic/Inter/CANTV) y cold-starts de Vercel
const OFFLINE_THRESHOLD_MS = 510000;

// Guardar datos del dispositivo, alias y familiares en archivos /tmp y Redis en la nube
function saveToDisk() {
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(global.persistentStore), 'utf8');
        fs.writeFileSync(ALIAS_FILE, JSON.stringify(global.aliases), 'utf8');
        fs.writeFileSync(GUEST_FILE, JSON.stringify(global.guestNames), 'utf8');
    } catch (e) {
        console.error('Error guardando en /tmp:', e.message);
    }

    if (redis) {
        try {
            redis.set('global_aliases', JSON.stringify(global.aliases)).catch(err => console.error('[REDIS ALIAS SAVE ERROR]:', err.message));
            redis.set('global_persistent_store', JSON.stringify(global.persistentStore)).catch(err => console.error('[REDIS STORE SAVE ERROR]:', err.message));
            redis.set('global_guest_names', JSON.stringify(global.guestNames)).catch(err => console.error('[REDIS GUESTS SAVE ERROR]:', err.message));
        } catch (e) {
            console.error('[REDIS SAVE ERROR]:', e.message);
        }
    }
}

// Guardar en la nube de forma asíncrona garantizada con fusión multi-servidor inteligente
async function saveToCloud() {
    saveToDisk();
    if (redis) {
        try {
            // Fusión inteligente: antes de guardar en Redis, verificar si otro servidor recibió pings más recientes
            const cloudStoreRaw = await redis.get('global_persistent_store').catch(() => null);
            if (cloudStoreRaw) {
                const cloudStore = typeof cloudStoreRaw === 'string' ? JSON.parse(cloudStoreRaw) : cloudStoreRaw;
                if (cloudStore && typeof cloudStore === 'object') {
                    Object.keys(cloudStore).forEach(id => {
                        const localDev = global.persistentStore[id];
                        const cloudDev = cloudStore[id];
                        if (!localDev) {
                            global.persistentStore[id] = cloudDev;
                        } else {
                            const cloudTime = Math.max(cloudDev.lastSeen || 0, cloudDev.updatedAt || 0);
                            const localTime = Math.max(localDev.lastSeen || 0, localDev.updatedAt || 0);
                            if (cloudTime > localTime) {
                                global.persistentStore[id] = {
                                    ...localDev,
                                    ...cloudDev,
                                    guestNames: { ...(cloudDev.guestNames || {}), ...(localDev.guestNames || {}) }
                                };
                            }
                        }
                    });
                    global.devices = { ...global.persistentStore };
                }
            }

            await Promise.all([
                redis.set('global_aliases', JSON.stringify(global.aliases)),
                redis.set('global_persistent_store', JSON.stringify(global.persistentStore)),
                redis.set('global_guest_names', JSON.stringify(global.guestNames))
            ]);
        } catch (e) {
            console.error('[REDIS SYNC ERROR]:', e.message);
        }
    }
}

// Obtener geolocalización de una IP de forma asíncrona y no-bloqueante
async function updateDeviceLocation(deviceId, ip) {
    const cleanIp = String(ip || '').split(',')[0].trim();
    if (!cleanIp || cleanIp === '0.0.0.0' || cleanIp === '127.0.0.1') return;
    try {
        const url = `http://ip-api.com/json/${cleanIp}?fields=status,regionName,city,isp`;
        const http = require('http');
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200 && json.status === 'success') {
                        const device = getDevice(deviceId);
                        if (device) {
                            device.city = json.city || '';
                            device.region = json.regionName || '';
                            device.isp = json.isp || '';
                            device.ip = cleanIp;
                            persistDevice(deviceId, device);
                            await saveToCloud();
                            console.log(`[GEO] Geolocalización exitosa para ${deviceId}: ${json.city}, ${json.regionName} (${json.isp})`);
                        }
                    }
                } catch(e) {}
            });
        }).on('error', () => {});
    } catch (e) {
        console.error('[GEO ERROR]:', e.message);
    }
}

// Cargar datos del archivo /tmp y de Redis en la nube al iniciar
function loadFromDisk() {
    try {
        if (fs.existsSync(ALIAS_FILE)) {
            const rawAlias = fs.readFileSync(ALIAS_FILE, 'utf8');
            const dataAlias = JSON.parse(rawAlias);
            if (dataAlias) {
                global.aliases = { ...global.aliases, ...dataAlias };
            }
        }
        if (fs.existsSync(GUEST_FILE)) {
            const rawGuests = fs.readFileSync(GUEST_FILE, 'utf8');
            const dataGuests = JSON.parse(rawGuests);
            if (dataGuests) {
                global.guestNames = { ...global.guestNames, ...dataGuests };
            }
        }
        if (fs.existsSync(TMP_FILE)) {
            const raw = fs.readFileSync(TMP_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data && Object.keys(data).length > 0) {
                Object.keys(data).forEach(id => {
                    const savedAlias = global.aliases[id] || data[id].alias;
                    const memoryAlias = global.persistentStore[id] ? global.persistentStore[id].alias : null;
                    const validAlias = (savedAlias && savedAlias !== id) ? savedAlias : ((memoryAlias && memoryAlias !== id) ? memoryAlias : (savedAlias || memoryAlias || id));
                    
                    if (validAlias && validAlias !== id) {
                        global.aliases[id] = validAlias;
                    }

                    if (data[id].guestNames) {
                        global.guestNames = { ...global.guestNames, ...data[id].guestNames };
                    }

                    global.persistentStore[id] = {
                        ...(global.persistentStore[id] || {}),
                        ...data[id],
                        alias: global.aliases[id] || validAlias,
                        guestNames: { ...(data[id].guestNames || {}), ...(global.persistentStore[id]?.guestNames || {}) }
                    };
                });
                global.devices = { ...global.persistentStore };
            }
        }
    } catch (e) {
        console.error('Error leyendo /tmp:', e.message);
    }
}

// Cargar datos de la nube (Upstash Redis) al arrancar la lambda
let isCloudLoaded = false;
async function loadFromCloud() {
    if (!redis) return;
    try {
        const [cloudAliasesRaw, cloudStoreRaw, cloudGuestsRaw] = await Promise.all([
            redis.get('global_aliases'),
            redis.get('global_persistent_store'),
            redis.get('global_guest_names')
        ]);

        if (cloudAliasesRaw) {
            const cloudAliases = typeof cloudAliasesRaw === 'string' ? JSON.parse(cloudAliasesRaw) : cloudAliasesRaw;
            if (cloudAliases && typeof cloudAliases === 'object') {
                global.aliases = { ...global.aliases, ...cloudAliases };
            }
        }

        if (cloudGuestsRaw) {
            const cloudGuests = typeof cloudGuestsRaw === 'string' ? JSON.parse(cloudGuestsRaw) : cloudGuestsRaw;
            if (cloudGuests && typeof cloudGuests === 'object') {
                global.guestNames = { ...global.guestNames, ...cloudGuests };
            }
        }

        if (cloudStoreRaw) {
            const cloudStore = typeof cloudStoreRaw === 'string' ? JSON.parse(cloudStoreRaw) : cloudStoreRaw;
            if (cloudStore && typeof cloudStore === 'object') {
                Object.keys(cloudStore).forEach(id => {
                    const aliasName = global.aliases[id] || cloudStore[id].alias || id;
                    if (cloudStore[id].guestNames) {
                        global.guestNames = { ...global.guestNames, ...cloudStore[id].guestNames };
                    }
                    const localDev = global.persistentStore[id];
                    const cloudDev = cloudStore[id];
                    const localUpdated = (typeof localDev?.updatedAt === 'string' ? new Date(localDev.updatedAt).getTime() : localDev?.updatedAt) || 0;
                    const cloudUpdated = (typeof cloudDev?.updatedAt === 'string' ? new Date(cloudDev.updatedAt).getTime() : cloudDev?.updatedAt) || 0;

                    // Si la nube tiene configuración administrativa más reciente o igual, la nube manda
                    const useCloudConfig = !localDev || cloudUpdated >= localUpdated;
                    const activeGuests = useCloudConfig ? (cloudDev.guestChatIds || []) : (localDev.guestChatIds || []);
                    const activeGuestNames = useCloudConfig ? (cloudDev.guestNames || {}) : (localDev.guestNames || {});
                    const activeChatId = useCloudConfig ? (cloudDev.chatId || '') : (localDev.chatId || cloudDev.chatId || '');
                    const activeConfigTime = Math.max(cloudUpdated, localUpdated);

                    // Para telemetría viva de la placa (lastSeen, onlineSince, history, ip)
                    const localLastSeen = localDev?.lastSeen || 0;
                    const cloudLastSeen = cloudDev?.lastSeen || 0;
                    const useLocalTelemetry = localLastSeen > cloudLastSeen;

                    global.persistentStore[id] = {
                        ...(localDev || {}),
                        ...(cloudDev || {}),
                        alias: aliasName,
                        chatId: activeChatId,
                        city: cloudDev.city || localDev?.city || '',
                        region: cloudDev.region || localDev?.region || '',
                        isp: cloudDev.isp || localDev?.isp || '',
                        guestChatIds: Array.from(new Set(activeGuests.map(String))).filter(Boolean),
                        guestNames: activeGuestNames,
                        updatedAt: activeConfigTime,
                        lastSeen: Math.max(localLastSeen, cloudLastSeen),
                        onlineSince: useLocalTelemetry ? (localDev.onlineSince || cloudDev.onlineSince) : (cloudDev.onlineSince || localDev?.onlineSince),
                        history: useLocalTelemetry ? (localDev.history || cloudDev.history) : (cloudDev.history || localDev?.history),
                        ip: cloudDev.ip || localDev?.ip || '',
                        status: useLocalTelemetry ? (localDev.status || cloudDev.status) : (cloudDev.status || localDev?.status),
                        blackoutNotified: useLocalTelemetry ? localDev.blackoutNotified : cloudDev.blackoutNotified
                    };
                });
                global.devices = { ...global.persistentStore };
            }
        }
        isCloudLoaded = true;
    } catch (e) {
        console.error('[REDIS LOAD ERROR]:', e.message);
    }
}

// Cargar datos al arrancar
loadFromDisk();
loadFromCloud().catch(err => console.error('Cloud load error:', err));

function persistDevice(deviceId, data) {
    global.persistentStore[deviceId] = {
        ...data,
        updatedAt: data.updatedAt || Date.now()
    };
    global.devices[deviceId] = global.persistentStore[deviceId];
    saveToDisk();
}

function getDevice(deviceId) {
    if (!deviceId) return null;
    if (global.persistentStore[deviceId]) return global.persistentStore[deviceId];
    if (global.devices[deviceId]) return global.devices[deviceId];
    const lower = String(deviceId).toLowerCase().trim();
    const found = Object.keys(global.persistentStore).find(k => k.toLowerCase().trim() === lower);
    if (found) return global.persistentStore[found];
    return null;
}

// Helper: Obtener nombre de un familiar registrado (con fallback a lookup global)
function getGuestName(device, guestChatId) {
    const cid = String(guestChatId || '').trim();
    if (!cid) return null;
    if (device && device.guestNames && device.guestNames[cid]) {
        return device.guestNames[cid];
    }
    if (global.guestNames && global.guestNames[cid]) {
        return global.guestNames[cid];
    }
    return null;
}

// Helper: Guardar o renombrar un familiar (persistido en memoria, dispositivo, /tmp y Redis)
function setGuestName(deviceId, guestChatId, name) {
    const cid = String(guestChatId || '').trim();
    const cleanName = String(name || '').trim();
    if (!cid || !cleanName) return;

    global.guestNames = global.guestNames || {};
    global.guestNames[cid] = cleanName;

    const dev = getDevice(deviceId);
    if (dev) {
        dev.guestNames = dev.guestNames || {};
        dev.guestNames[cid] = cleanName;
        persistDevice(deviceId, dev);
    }
    saveToDisk();
}

// Helpers para estados pendientes con persistencia en Redis (resistente a cold starts de Vercel)
async function setPendingState(chatId, state) {
    if (!chatId) return;
    const strId = String(chatId).trim();
    global.pendingStates = global.pendingStates || {};
    global.pendingStates[strId] = { ...state, updatedAt: Date.now() };
    if (redis) {
        try {
            await redis.set(`pending_state:${strId}`, JSON.stringify(global.pendingStates[strId]), { ex: 600 });
        } catch (e) {
            console.error('[REDIS PENDING SET ERROR]:', e.message);
        }
    }
}

async function getPendingState(chatId) {
    if (!chatId) return null;
    const strId = String(chatId).trim();
    if (global.pendingStates && global.pendingStates[strId]) {
        return global.pendingStates[strId];
    }
    if (redis) {
        try {
            const raw = await redis.get(`pending_state:${strId}`);
            if (raw) {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                global.pendingStates = global.pendingStates || {};
                global.pendingStates[strId] = parsed;
                return parsed;
            }
        } catch (e) {
            console.error('[REDIS PENDING GET ERROR]:', e.message);
        }
    }
    return null;
}

async function clearPendingState(chatId) {
    if (!chatId) return;
    const strId = String(chatId).trim();
    if (global.pendingStates) delete global.pendingStates[strId];
    if (redis) {
        try {
            await redis.del(`pending_state:${strId}`);
        } catch (e) {}
    }
}

// Función para enviar mensajes de Telegram garantizada (Promise awaitable para serverless)
function sendTelegramMessage(chatId, text, customButtons = null) {
    if (!chatId) return Promise.resolve({ success: false, messageId: null });
    return new Promise((resolve) => {
        try {
            const buttons = customButtons || [
                [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }]
            ];

            const payload = JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: buttons
                }
            });

            const options = {
                hostname: 'api.telegram.org',
                path: `/bot${BOT_TOKEN}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };

            const request = https.request(options, (response) => {
                let resData = '';
                response.on('data', (chunk) => { resData += chunk; });
                response.on('end', () => {
                    console.log(`[TELEGRAM] Enviado con éxito a ${chatId}. Status: ${response.statusCode}`);
                    try {
                        const parsed = JSON.parse(resData);
                        const msgId = parsed?.result?.message_id || null;
                        resolve({ success: true, messageId: msgId });
                    } catch (e) {
                        resolve({ success: true, messageId: null });
                    }
                });
            });

            request.setTimeout(4000, () => {
                request.destroy();
                resolve({ success: false, messageId: null });
            });

            request.on('error', (err) => {
                console.error('[TELEGRAM ERROR]:', err.message);
                resolve({ success: false, messageId: null });
            });

            request.write(payload);
            request.end();
        } catch (e) {
            console.error('Error enviando Telegram:', e);
            resolve({ success: false, messageId: null });
        }
    });
}

// Función para eliminar un mensaje de Telegram (ej. si fue falsa alarma de Vercel)
function deleteTelegramMessage(chatId, messageId) {
    if (!chatId || !messageId) return Promise.resolve(false);
    return new Promise((resolve) => {
        try {
            const payload = JSON.stringify({
                chat_id: chatId,
                message_id: messageId
            });

            const options = {
                hostname: 'api.telegram.org',
                path: `/bot${BOT_TOKEN}/deleteMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };

            const request = https.request(options, (response) => {
                response.on('data', () => {});
                response.on('end', () => {
                    console.log(`[TELEGRAM] Mensaje falso ${messageId} eliminado de Telegram para ${chatId}`);
                    resolve(true);
                });
            });

            request.setTimeout(3000, () => {
                request.destroy();
                resolve(false);
            });

            request.on('error', () => resolve(false));
            request.write(payload);
            request.end();
        } catch (e) {
            resolve(false);
        }
    });
}

// Función para confirmar a Telegram que un botón fue presionado (quita el relojito de carga)
function answerCallbackQuery(callbackQueryId) {
    if (!callbackQueryId) return Promise.resolve(false);
    return new Promise((resolve) => {
        try {
            const payload = JSON.stringify({ callback_query_id: callbackQueryId });
            const options = {
                hostname: 'api.telegram.org',
                path: `/bot${BOT_TOKEN}/answerCallbackQuery`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };
            const request = https.request(options, () => resolve(true));
            request.setTimeout(2000, () => { request.destroy(); resolve(false); });
            request.on('error', () => resolve(false));
            request.write(payload);
            request.end();
        } catch (e) {
            resolve(false);
        }
    });
}

// Configurar el Menú Oficial de Comandos de Telegram (Botón Menú en la esquina)
// Configurar el Menú Oficial de Comandos de Telegram (Botón Menú en la esquina)
function setupTelegramCommands() {
    try {
        const commandsPayload = JSON.stringify({
            commands: [
                { command: "estado", description: "📊 Ver si hay luz en tiempo real" },
                { command: "invitar", description: "👥 Agregar o gestionar familiares" },
                { command: "renombrar", description: "✏️ Asignar o Renombrar Casas" },
                { command: "casas", description: "🏠 Mis Casas / Monitores" },
                { command: "reporte", description: "📈 Reporte semanal de estabilidad" },
                { command: "historial", description: "📜 Ver lista y duración de cortes" },
                { command: "chatid", description: "🆔 Ver mi Chat ID de Telegram" },
                { command: "reiniciar", description: "🔄 Reiniciar WiFi de la placa" }
            ]
        });

        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/setMyCommands`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(commandsPayload)
            }
        };

        const req = https.request(options);
        req.write(commandsPayload);
        req.end();
    } catch(e) {}
}
setupTelegramCommands();

// AUTO-PROTECCIÓN DEL WEBHOOK: Verificar y corregir allowed_updates en cada cold start
// Esto GARANTIZA que callback_query siempre esté habilitado (los botones inline siempre funcionen)
const WEBHOOK_URL = 'https://monitor-luz-vercel-six.vercel.app/api/telegram-webhook';
const REQUIRED_UPDATES = ['message', 'callback_query', 'edited_message', 'channel_post', 'edited_channel_post'];

function ensureWebhookConfig() {
    // Si estamos corriendo en Render, no interferir con el webhook de Telegram (Vercel es el master)
    if (process.env.RENDER) {
        console.log('[WEBHOOK-GUARD] Entorno Render detectado: Webhook delegado exclusivamente a Vercel.');
        return;
    }
    try {
        const getOptions = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/getWebhookInfo`,
            method: 'GET'
        };

        const req = https.request(getOptions, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    if (!info.ok || !info.result) return;

                    const current = info.result.allowed_updates || [];
                    const urlOk = info.result.url === WEBHOOK_URL;
                    const hasCallback = current.includes('callback_query');

                    if (urlOk && hasCallback) {
                        console.log('[WEBHOOK-GUARD] ✅ Webhook OK: URL correcta y callback_query habilitado.');
                        return;
                    }

                    // Falta callback_query o la URL es incorrecta → corregir automáticamente
                    console.warn(`[WEBHOOK-GUARD] ⚠️ Webhook INCORRECTO — URL ok: ${urlOk}, callback_query: ${hasCallback}. Reparando...`);

                    const fixPayload = JSON.stringify({
                        url: WEBHOOK_URL,
                        allowed_updates: REQUIRED_UPDATES
                    });

                    const fixOptions = {
                        hostname: 'api.telegram.org',
                        path: `/bot${BOT_TOKEN}/setWebhook`,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(fixPayload)
                        }
                    };

                    const fixReq = https.request(fixOptions, (fixRes) => {
                        let fixData = '';
                        fixRes.on('data', (chunk) => { fixData += chunk; });
                        fixRes.on('end', () => {
                            console.log(`[WEBHOOK-GUARD] 🔧 Webhook reparado automáticamente. Respuesta: ${fixData}`);
                        });
                    });
                    fixReq.setTimeout(5000, () => { fixReq.destroy(); });
                    fixReq.on('error', (err) => console.error('[WEBHOOK-GUARD] Error reparando:', err.message));
                    fixReq.write(fixPayload);
                    fixReq.end();

                } catch (e) {
                    console.error('[WEBHOOK-GUARD] Error parseando respuesta:', e.message);
                }
            });
        });

        req.setTimeout(5000, () => { req.destroy(); });
        req.on('error', (err) => console.error('[WEBHOOK-GUARD] Error consultando:', err.message));
        req.end();
    } catch (e) {
        console.error('[WEBHOOK-GUARD] Error general:', e.message);
    }
}
ensureWebhookConfig();

// Helper: generar URL web con chatId para control de permisos (Titular vs Invitado)
function getWebUrl(devId, chatId = '') {
    const cid = (chatId || '').toString().trim();
    const cidParam = cid ? `&chatId=${encodeURIComponent(cid)}` : '';
    return `https://monitor-luz-vercel-six.vercel.app/?id=${devId}${cidParam}`;
}

// 5. HELPER: CONSTRUIR REPORTE SEMANAL
function buildWeeklyReport(device, targetChatId = '') {
    if (!device) return null;
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const history = device.history || [];

    const weekEvents = history.filter(h => (h.start && h.start >= oneWeekAgo) || (h.end && h.end >= oneWeekAgo));

    let totalBlackoutMs = 0;
    let longCutsCount = 0;
    let microCutsCount = 0;
    let longestCutMs = 0;

    weekEvents.forEach(e => {
        const dur = e.durationMs || (e.end ? (e.end - e.start) : 0);
        totalBlackoutMs += dur;
        if (dur >= 300000) {
            longCutsCount++;
        } else if (dur > 0) {
            microCutsCount++;
        }
        if (dur > longestCutMs) longestCutMs = dur;
    });

    const totalWeekMs = 7 * 24 * 60 * 60 * 1000;
    const blackoutHours = (totalBlackoutMs / 3600000).toFixed(1);
    const lightHours = ((totalWeekMs - totalBlackoutMs) / 3600000).toFixed(1);
    const stabilityPct = Math.max(0, Math.min(100, ((totalWeekMs - totalBlackoutMs) / totalWeekMs * 100).toFixed(1)));

    let diagnostic = "🌟 <b>Excelente:</b> Suministro eléctrico continuo sin cortes significativos.";
    if (stabilityPct < 80) {
        diagnostic = "🚨 <b>Crítico:</b> Frecuencia severa de cortes eléctricos esta semana.";
    } else if (stabilityPct < 95) {
        diagnostic = "⚠️ <b>Inestable:</b> Se registraron varias interrupciones en el servicio.";
    }

    const longestHours = Math.floor(longestCutMs / 3600000);
    const longestMins = Math.floor((longestCutMs % 3600000) / 60000);
    const longestCutStr = longestHours > 0 ? `${longestHours}h ${longestMins}m` : `${longestMins}m`;

    return `📊 <b>REPORTE SEMANAL DE ENERGÍA ELÉCTRICA</b>\n` +
           `📅 <i>Últimos 7 días</i>\n\n` +
           `📍 <b>Ubicación:</b> <b>${device.alias || device.deviceId}</b>\n` +
           `📱 <b>Dispositivo:</b> <code>${device.deviceId}</code>\n` +
           `━━━━━━━━━━━━━━━━━━━━\n\n` +
           `🟢 <b>Tiempo con Luz:</b> ${lightHours}h (<code>${stabilityPct}%</code>)\n` +
           `🔴 <b>Tiempo sin Luz:</b> ${blackoutHours}h\n\n` +
           `📈 <b>Desglose de la Semana:</b>\n` +
           `• 🔌 <b>Cortes Eléctricos (>5m):</b> ${longCutsCount}\n` +
           `• ⏱️ <b>Corte más largo:</b> ${longestCutStr}\n` +
           `• 〽️ <b>Fluctuaciones / Bajones:</b> ${microCutsCount}\n\n` +
           `💡 <b>Diagnóstico:</b>\n${diagnostic}\n\n` +
           `🔗 <b>Ver Monitor Web:</b>\n${getWebUrl(device.deviceId, targetChatId || device.chatId)}`;
}

// 5.1 HELPER: CONSTRUIR REPORTE DIARIO
function buildDailyReport(device, targetChatId = '') {
    if (!device) return null;
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const history = device.history || [];

    // Filtrar eventos de las últimas 24 horas
    const dayEvents = history.filter(h => (h.start && h.start >= oneDayAgo) || (h.end && h.end >= oneDayAgo));

    let totalBlackoutMs = 0;
    const eventsSummary = [];

    dayEvents.forEach(e => {
        const dur = e.durationMs || (e.end ? (e.end - e.start) : 0);
        const type = e.type || 'power_outage';
        
        if (type === 'power_outage') {
            totalBlackoutMs += dur;
            eventsSummary.push(`• 🔴 <b>Corte de Luz</b> a las ${e.startTimeStr || ''} (duró ${e.durationStr || 'N/A'})`);
        } else if (type === 'internet_drop') {
            eventsSummary.push(`• 🌐 <b>Caída de Internet</b> a las ${e.startTimeStr || ''} (duró ${e.durationStr || 'N/A'})`);
        } else if (type === 'fluctuation') {
            eventsSummary.push(`• 〽️ <b>Fluctuación / Bajón</b> a las ${e.startTimeStr || ''} (duró ${e.durationStr || 'N/A'})`);
        }
    });

    const totalDayMs = 24 * 60 * 60 * 1000;
    const stabilityPct = Math.max(0, Math.min(100, (((totalDayMs - totalBlackoutMs) / totalDayMs) * 100).toFixed(1)));

    let statusLine = '';
    if (eventsSummary.length === 0) {
        statusLine = `✨ ¡Excelente! El servicio eléctrico y de internet estuvo 100% estable todo el día.`;
    } else {
        statusLine = `📊 <b>Desglose de hoy:</b>\n` + eventsSummary.join('\n');
    }

    return `📊 <b>REPORTE DIARIO DE ESTABILIDAD</b> 🔌\n` +
           `📅 <i>Últimas 24 horas</i>\n\n` +
           `📍 <b>Ubicación:</b> <b>${device.alias || device.deviceId}</b>\n` +
           `⚡ <b>Estabilidad de luz hoy:</b> <code>${stabilityPct}%</code>\n\n` +
           `${statusLine}\n\n` +
           `🔗 <b>Ver Monitor Web:</b> ${getWebUrl(device.deviceId, targetChatId || device.chatId)}`;
}

// Helper: construir mensaje de estado de un dispositivo
function buildStatusMsg(dev, devId, targetChatId = '') {
    if (!dev) return `⚠️ <b>Dispositivo no encontrado:</b> <code>${devId || 'ESP-DESCONOCIDO'}</code>`;
    const now = Date.now();
    const lastSeen = dev.lastSeen || now;
    const elapsed = now - lastSeen;
    const online = elapsed < OFFLINE_THRESHOLD_MS;
    const name = dev.alias || dev.deviceId || devId;
    const activeDevId = dev.deviceId || devId;
    const webLink = getWebUrl(activeDevId, targetChatId || dev.chatId);

    let devOwnerId = String(dev.chatId || '').trim();
    if (devOwnerId === '3307499449') devOwnerId = '330749449';
    let currentCid = String(targetChatId || '').trim();
    if (currentCid === '3307499449') currentCid = '330749449';
    const isOwner = checkIsOwner(dev, currentCid);
    const roleTag = isOwner ? '👑 Propietario' : '👤 Invitado';

    const geoInfo = (dev.city && dev.isp) ? 
        `🏢 <b>Ciudad:</b> ${dev.city}, ${dev.region || ''}\n` +
        `🌐 <b>Red:</b> ${dev.isp}\n` : '';

    if (online) {
        const up = now - (dev.onlineSince || lastSeen);
        const h = Math.floor(up / 3600000);
        const m = Math.floor((up % 3600000) / 60000);
        const uptimeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
        return `🟢 <b>ESTADO EN VIVO: HAY LUZ ⚡</b>\n\n` +
               `📍 <b>Ubicación:</b> <b>${name}</b> [${roleTag}]\n` +
               `👤 <b>Tu Rol:</b> ${isOwner ? '👑 Propietario (Titular)' : '👤 Familiar Invitado'}\n` +
               geoInfo +
               `📱 <b>ID:</b> <code>${activeDevId}</code>\n` +
               `⏱️ <b>Tiempo continuo con luz:</b> ${uptimeStr}\n` +
               `📡 <b>Último reporte:</b> Hace ${Math.max(0, Math.floor(elapsed / 1000))} segundos\n\n` +
               `🔗 <b>Monitor Web:</b> ${webLink}`;
    } else {
        const mins = Math.floor(elapsed / 60000);
        const t = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h y ${mins % 60}m`;
        const dt = new Date(lastSeen);
        const ts = dt.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Caracas' });
        const ds = dt.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });
        return `🔴 <b>ESTADO EN VIVO: SE FUE LA LUZ 🔌</b>\n\n` +
               `📍 <b>Ubicación:</b> <b>${name}</b> [${roleTag}]\n` +
               `👤 <b>Tu Rol:</b> ${isOwner ? '👑 Propietario (Titular)' : '👤 Familiar Invitado'}\n` +
               geoInfo +
               `📱 <b>ID:</b> <code>${activeDevId}</code>\n` +
               `🕐 <b>Último reporte:</b> ${ts} (${ds})\n` +
               `⏱️ <b>Tiempo sin luz:</b> ${t}\n\n` +
               `🔗 <b>Monitor Web:</b> ${webLink}`;
    }
}

// Helper: construir mensaje de historial
function buildHistoryMsg(dev, targetChatId = '') {
    if (!dev) return '⚠️ <b>Dispositivo no encontrado.</b>';
    const name = dev.alias || dev.deviceId;
    const history = dev.history || [];
    const webLink = getWebUrl(dev.deviceId, targetChatId || dev.chatId);
    const isOwner = checkIsOwner(dev, targetChatId);
    const roleTag = isOwner ? '👑 Propietario' : '👤 Invitado';

    if (history.length === 0) {
        return `📜 <b>HISTORIAL DE CORTES ELÉCTRICOS</b>\n\n` +
               `📍 <b>Ubicación:</b> <b>${name}</b> [${roleTag}]\n` +
               `👤 <b>Tu Rol:</b> ${isOwner ? '👑 Propietario (Titular)' : '👤 Familiar Invitado'}\n` +
               `📱 <b>Dispositivo:</b> <code>${dev.deviceId}</code>\n\n` +
               `✨ <i>No hay registros de cortes de luz almacenados. ¡El suministro ha estado estable!</i>\n\n` +
               `🔗 <b>Ver en Web:</b> ${webLink}`;
    }
    let historyListText = "";
    const maxShow = Math.min(history.length, 5);
    for (let i = 0; i < maxShow; i++) {
        const h = history[i];
        let icon = "⚡";
        let tagLabel = "Corte Eléctrico";
        if (!h.end) {
            icon = "🔴";
            tagLabel = "En Curso";
        } else if (h.type === 'internet_drop') {
            icon = "🌐";
            tagLabel = "Caída de Internet";
        } else if (h.type === 'fluctuation') {
            icon = "〽️";
            tagLabel = "Fluctuación / Bajón";
        }

        historyListText += `${icon} <b>${tagLabel} #${history.length - i}:</b>\n` +
                           `   • <b>Inicio:</b> ${h.startTimeStr || 'N/A'} (${h.startDateStr || 'N/A'})\n` +
                           `   • <b>Fin:</b> ${h.endTimeStr ? `${h.endTimeStr} (${h.endDateStr || ''})` : '<i>En curso...</i>'}\n` +
                           `   • <b>Duración:</b> <code>${h.durationStr || 'N/A'}</code>\n\n`;
    }

    return `📜 <b>HISTORIAL DE EVENTOS</b>\n\n` +
           `📍 <b>Ubicación:</b> <b>${name}</b>\n` +
           `📊 <b>Total de eventos registrados:</b> ${history.length}\n\n` +
           historyListText +
           `🔗 <b>Ver y gestionar en la Web:</b>\n${webLink}`;
}

// Comprobador de cortes de luz automático (Multi-Usuario 100% Genérico para CUALQUIER ESP)
async function checkBlackoutAlerts(excludeDeviceId = null) {
    await loadFromCloud();
    loadFromDisk();
    const now = Date.now();
    const combined = { ...global.persistentStore, ...global.devices };

    for (const dev of Object.values(combined)) {
        if (!dev.lastSeen || !dev.deviceId) continue;
        if (excludeDeviceId && dev.deviceId === excludeDeviceId) continue; // Nunca alertar al que está haciendo ping ahora mismo
        const elapsedMs = now - dev.lastSeen;

        let devChatId = (dev.chatId || '').toString().trim();
        if (devChatId === '3307499449') devChatId = '330749449'; // Sanitizar typo común

        // Si han pasado 510 segundos (8.5 minutos de gracia sólida anti-falsos positivos de red/serverless) y no se ha notificado la ida de luz
        if (elapsedMs >= OFFLINE_THRESHOLD_MS && !dev.blackoutNotified && devChatId) {
            dev.blackoutNotified = true;
            dev.chatId = devChatId;
            dev.blackoutStartTime = dev.lastSeen; // Momento exacto en que se fue la luz / internet
            dev.history = dev.history || [];
            dev.lastAlertMessages = dev.lastAlertMessages || {};

            // Agregar registro de corte pendiente (sin hora de regreso aún)
            const cutoffDate = new Date(dev.lastSeen);
            const cutoffTimeStr = cutoffDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });
            const cutoffDateStr = cutoffDate.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });

            const eventId = `event_${dev.lastSeen}`;
            const exists = dev.history.some(h => h.id === eventId || (h.start === dev.lastSeen && !h.end));
            if (!exists) {
                dev.history.unshift({
                    id: eventId,
                    start: dev.lastSeen,
                    startTimeStr: cutoffTimeStr,
                    startDateStr: cutoffDateStr,
                    end: null,
                    endTimeStr: null,
                    durationStr: 'En curso...',
                    durationMs: 0
                });
            }

            const geoSuffix = (dev.city && dev.isp) ? ` <i>(${dev.city}, ${dev.region || ''} — ${dev.isp} 🌐)</i>` : '';
            const alertMsg = `⚠️ <b>¡ALERTA DE DESCONEXIÓN! 🔌🌐</b>\n\n` +
                             `📍 <b>Ubicación:</b> <code>${dev.alias || dev.deviceId}</code>${geoSuffix}\n` +
                             `⏰ <b>Hora aproximada del evento:</b> ${cutoffTimeStr} (${cutoffDateStr})\n\n` +
                             `Tu dispositivo ha dejado de transmitir señal.\n` +
                             `💡 <i>Esto puede deberse a:</i>\n` +
                             `  1️⃣ <b>Corte de Energía Eléctrica (Falla de luz)</b>\n` +
                             `  2️⃣ <b>Caída del Servicio de Internet (CANTV/Fibra)</b>\n` +
                             `  3️⃣ <b>O ambos eventos simultáneamente</b>\n\n` +
                             `🔍 <i>La causa exacta se determinará y confirmará automáticamente en tu reporte al restablecerse la conexión.</i>\n\n` +
                             `📱 <b>Dispositivo:</b> <code>${dev.deviceId}</code>\n` +
                             `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${dev.deviceId}`;

            console.log(`[ALERTA CORTE] Enviando notificación de ida de luz a chatId ${devChatId} para ${dev.deviceId}`);
            const sendRes = await sendTelegramMessage(devChatId, alertMsg);
            const msgId = sendRes?.messageId || null;
            dev.lastAlertMessageId = msgId;
            if (msgId) dev.lastAlertMessages[devChatId] = msgId;

            // Enviar alerta a todos los invitados/familiares autorizados y registrar sus message_ids individuales
            const guests = dev.guestChatIds || [];
            for (const gId of guests) {
                if (gId && gId !== devChatId) {
                    const gRes = await sendTelegramMessage(gId, alertMsg, [
                        [{ text: "📊 Consultar Estado en Vivo", callback_data: `/estado_${dev.deviceId}` }]
                    ]);
                    if (gRes?.messageId) {
                        dev.lastAlertMessages[gId] = gRes.messageId;
                    }
                }
            }

            persistDevice(dev.deviceId, {
                ...dev,
                blackoutNotified: true,
                chatId: devChatId,
                blackoutStartTime: dev.lastSeen,
                lastAlertMessageId: msgId,
                lastAlertMessages: dev.lastAlertMessages,
                history: dev.history
            });
            await saveToCloud();
        }
    }
}

// 1. ENDPOINT PARA RECIBIR PING DE LA PLACA ESP8266 (POST /api/ping)
app.post('/api/ping', async (req, res) => {
    await loadFromCloud();
    loadFromDisk();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const boardUptimeMs = parseInt(req.body.uptimeMs || 0, 10);
    const chatId = (req.body.chatId || req.body.telegramChatId || '').toString().trim();

    if (!deviceId) {
        return res.status(400).json({ error: 'Falta el parámetro deviceId' });
    }

    const now = Date.now();

    const existing = getDevice(deviceId) || {};
    const shouldReset = existing.resetRequested || false;
    const wasBlackout = existing.blackoutNotified || false;
    let targetChatId = chatId || existing.chatId || '';

    // Sanitizar typo común de chatId
    if (targetChatId === '3307499449') targetChatId = '330749449';

    let history = existing.history || [];

    const offlinePings = parseInt(req.body.offlinePings || req.body.missedPings || 0, 10);
    // Prioridad de alias y lógica especial de desvinculación al reiniciar
    const incomingAlias = (req.body.alias || req.body.name || '').toString().trim();
    const storedAlias = global.aliases[deviceId] || existing.alias;
    let deviceAlias = (storedAlias && storedAlias !== deviceId) ? storedAlias : ((incomingAlias && incomingAlias !== deviceId) ? incomingAlias : deviceId);

    let isUnlinkedNow = existing.unlinked || false;
    if (shouldReset) {
        targetChatId = ''; // Eliminar la relación del Chat ID propietario
        existing.guestChatIds = []; // Eliminar todos los familiares
        existing.guestNames = {};
        deviceAlias = deviceId; // Eliminar el alias del dispositivo
        if (global.aliases[deviceId]) delete global.aliases[deviceId];
        isUnlinkedNow = true;
    } else if (chatId) {
        // Si hace ping con un chatId nuevo o existente (revinculación tras configurar de nuevo)
        isUnlinkedNow = false;
    }

    if (deviceAlias && deviceAlias !== deviceId) {
        global.aliases[deviceId] = deviceAlias;
    }

    const hasOpenCut = history.length > 0 && !history[0].end;

    // Calcular momento aproximado de inicio del evento
    let blackoutStart = null;
    if (hasOpenCut && history[0].start) {
        blackoutStart = history[0].start;
    } else if (existing.blackoutStartTime) {
        blackoutStart = existing.blackoutStartTime;
    } else if (existing.lastSeen) {
        blackoutStart = existing.lastSeen;
    } else {
        blackoutStart = now - OFFLINE_THRESHOLD_MS;
    }
    const computedDurationMs = Math.max(now - blackoutStart, 60000);

    // -------------------------------------------------------------------------
    // DISCRIMINACIÓN INTELIGENTE DE HARDWARE:
    // -------------------------------------------------------------------------
    // 1. Corte de Luz Real: La placa se apagó físicamente (su uptime es menor al tiempo transcurrido desde el corte)
    // 2. Caída de Internet Real: La placa se mantuvo encendida todo el tiempo (su uptime supera la duración del corte).
    //    Esto confirma que en la casa SÍ hubo electricidad en todo momento.
    const chipStayedPoweredOn = boardUptimeMs > (computedDurationMs + 5000);
    const wasAlertSent = wasBlackout || Boolean(existing.blackoutStartTime) || Boolean(existing.lastAlertMessageId);

    // Es un retorno si se había notificado previamente la desconexión O si la duración superó el umbral
    const isReturnFromBlackout = !shouldReset && (wasAlertSent || computedDurationMs >= OFFLINE_THRESHOLD_MS);

    // Determinar la fecha de encendido inicial (onlineSince)
    let onlineSince = existing.onlineSince || (boardUptimeMs > 0 ? (now - boardUptimeMs) : now);
    if (isReturnFromBlackout && !chipStayedPoweredOn) {
        onlineSince = boardUptimeMs > 0 ? (now - boardUptimeMs) : now;
    }

    if (isReturnFromBlackout && (existing.lastSeen || existing.blackoutStartTime || hasOpenCut)) {
        const durationMs = computedDurationMs;
        const totalMins = Math.round(durationMs / 60000);

        let durationFormatted = "";
        if (totalMins <= 1) {
            durationFormatted = "1 min";
        } else if (totalMins < 60) {
            durationFormatted = `${totalMins} min`;
        } else {
            const h = Math.floor(totalMins / 60);
            const m = totalMins % 60;
            durationFormatted = `${h}h ${m}m`;
        }

        const returnDate = new Date(now);
        const returnTimeStr = returnDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });
        const returnDateStr = returnDate.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });

        // Clasificación inteligente del evento:
        let eventType = 'power_outage';
        if (chipStayedPoweredOn) {
            eventType = 'internet_drop';
        } else if (totalMins < 5) {
            eventType = 'fluctuation';
        } else {
            eventType = 'power_outage';
        }

        // Actualizar el último corte en el historial o crear la entrada de regreso
        if (history.length > 0 && !history[0].end) {
            history[0].end = now;
            history[0].endTimeStr = returnTimeStr;
            history[0].endDateStr = returnDateStr;
            history[0].durationStr = durationFormatted;
            history[0].durationMs = durationMs;
            history[0].type = eventType;
        } else {
            const startDate = new Date(blackoutStart);
            history.unshift({
                id: `event_${blackoutStart}`,
                start: blackoutStart,
                startTimeStr: startDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' }),
                startDateStr: startDate.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' }),
                end: now,
                endTimeStr: returnTimeStr,
                endDateStr: returnDateStr,
                durationStr: durationFormatted,
                durationMs: durationMs,
                type: eventType
            });
        }

        // Limitar historial a los últimos 50 eventos
        if (history.length > 50) history = history.slice(0, 50);

        const geoSuffix = (existing.city && existing.isp) ? ` <i>(${existing.city}, ${existing.region || ''} — ${existing.isp} 🌐)</i>` : '';

        let returnMsg = "";
        if (eventType === 'internet_drop') {
            returnMsg = `🌐 <b>¡SERVICIO DE INTERNET RESTABLECIDO!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>${geoSuffix}\n` +
                        `⏰ <b>Hora de reconexión:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo sin conexión:</b> ${durationFormatted}\n\n` +
                        `💡 <i>Confirmado: **En tu casa SÍ hubo luz todo el tiempo**. La placa se mantuvo encendida continuamente; la interrupción fue de tu proveedor de internet / red.</i>\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        } else if (eventType === 'fluctuation') {
            returnMsg = `⚡ <b>¡ENERGÍA / RED NORMALIZADA!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>${geoSuffix}\n` +
                        `⏰ <b>Hora de restablecimiento:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo fuera de línea:</b> ${durationFormatted}\n\n` +
                        `💡 <i>Fue un <b>micro-corte eléctrico</b> (bajón de voltaje) o un reinicio breve de red en tu casa.</i>\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        } else {
            returnMsg = `⚡ <b>¡VOLVIÓ LA LUZ!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>${geoSuffix}\n` +
                        `⏰ <b>Hora de regreso:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo que duró el corte:</b> ${durationFormatted}\n\n` +
                        `La energía eléctrica ha regresado a tu casa.\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        }

        // Si se envió alerta previa de desconexión O si duró al menos el umbral, notificar a Telegram
        if (targetChatId && (wasAlertSent || durationMs >= OFFLINE_THRESHOLD_MS)) {
            console.log(`[NOTIF REGRESO] Enviando aviso a Telegram para ${deviceId} a chatId ${targetChatId}`);
            await sendTelegramMessage(targetChatId, returnMsg);

            // Transmitir mensaje de regreso a todos los invitados/familiares autorizados
            const guests = existing.guestChatIds || [];
            for (const gId of guests) {
                if (gId && gId !== targetChatId) {
                    await sendTelegramMessage(gId, returnMsg, [
                        [{ text: "📊 Consultar Estado en Vivo", callback_data: `/estado_${deviceId}` }]
                    ]);
                }
            }
        }
    }

    const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0';
    const incomingIp = String(rawIp).split(',')[0].trim();

    const devData = {
        deviceId: deviceId,
        alias: deviceAlias,
        lastSeen: now,
        onlineSince: onlineSince,
        chatId: targetChatId,
        guestChatIds: Array.from(new Set([
            ...(existing.guestChatIds || []).map(String),
            ...(global.persistentStore[deviceId]?.guestChatIds || []).map(String)
        ])).filter(Boolean),
        guestNames: {
            ...(existing.guestNames || {}),
            ...(global.persistentStore[deviceId]?.guestNames || {})
        },
        blackoutNotified: false, // Resetear bandera al volver la luz
        blackoutStartTime: null,
        lastAlertMessageId: null,
        lastAlertMessages: {},
        history: history,
        resetRequested: false,
        unlinked: isUnlinkedNow, 
        ip: incomingIp,
        city: existing.city || global.persistentStore[deviceId]?.city || '',
        region: existing.region || global.persistentStore[deviceId]?.region || '',
        isp: existing.isp || global.persistentStore[deviceId]?.isp || '',
        updatedAt: existing.updatedAt || 0
    };

    global.devices[deviceId] = devData;
    persistDevice(deviceId, devData);

    // Si la IP cambió o no tenemos geolocalización guardada, actualizamos en background
    const ipChanged = incomingIp !== existing.ip;
    const hasLocation = existing.city && existing.isp;
    if (incomingIp && incomingIp !== '0.0.0.0' && incomingIp !== '127.0.0.1' && (ipChanged || !hasLocation)) {
        updateDeviceLocation(deviceId, incomingIp).catch(() => {});
    }

    console.log(`[PING] Dispositivo ${deviceId} activo.`);

    await saveToCloud();
    await checkBlackoutAlerts(deviceId);

    return res.json({ 
        success: true, 
        message: 'Ping recibido', 
        deviceId, 
        lastSeen: now, 
        onlineSince,
        action: shouldReset ? 'RESET_WIFI' : 'NONE'
    });
});

// 2. ENDPOINT WEBHOOK TELEGRAM — CORRECTO: procesar y enviar respuesta PRIMERO, luego 200 OK
app.post('/api/telegram-webhook', async (req, res) => {
    await loadFromCloud();
    try {
        const update = req.body;
        if (!update) return res.status(200).send('OK');

        let chatId = null;
        let text = '';
        let senderName = 'Usuario';
        let callbackQueryId = null;

        if (update.callback_query) {
            chatId = String(update.callback_query.message.chat.id || '');
            text = String(update.callback_query.data || '').toLowerCase().trim();
            senderName = (update.callback_query.from && update.callback_query.from.first_name) || 'Usuario';
            callbackQueryId = update.callback_query.id;
            // Quitar relojito de carga inmediatamente esperando confirmación de Telegram
            await answerCallbackQuery(callbackQueryId);
        } else if (update.message && update.message.chat) {
            chatId = String(update.message.chat.id || '');
            text = String(update.message.text || '').toLowerCase().trim();
            senderName = (update.message.from && update.message.from.first_name) || 'Usuario';
        }

        if (!chatId) return res.status(200).send('OK');
        if (chatId === '3307499449') chatId = '330749449';

        // Cargar datos de Redis en tiempo real
        await loadFromCloud();

        const cleanText = (update.message && update.message.text) ? update.message.text.trim() : text;
        const store = global.persistentStore;
        const devs = Object.values(store);

        // --- GESTIÓN DE ESTADOS PENDIENTES PERSISTENTES (RESISTENTE A COLD STARTS) ---
        const pending = await getPendingState(chatId);

        // Si el usuario envía un comando con barra ('/'), cancelar estado pendiente y continuar con el comando
        if (pending && cleanText.startsWith('/') && !cleanText.startsWith('/skip_guest_name_')) {
            await clearPendingState(chatId);
        }

        // --- PENDIENTE: AGREGAR FAMILIAR (PASO 1: Ingrese Chat ID) ---
        if (pending && pending.action === 'ADD_GUEST_CHAT_ID' && /^\d+$/.test(cleanText)) {
            const devId = pending.devId;
            const guestChatId = cleanText;
            const existingDev = getDevice(devId) || { deviceId: devId };

            if (!checkIsOwner(existingDev, chatId, true)) {
                await clearPendingState(chatId);
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede agregar familiares.`, []);
                return res.status(200).send('OK');
            }

            existingDev.guestChatIds = existingDev.guestChatIds || [];
            if (!existingDev.guestChatIds.includes(guestChatId)) {
                existingDev.guestChatIds.push(guestChatId);
            }
            persistDevice(devId, existingDev);
            await saveToCloud();

            // Avanzar automáticamente a Paso 2: Pedir Nombre
            await setPendingState(chatId, {
                action: 'SET_GUEST_NAME',
                devId: devId,
                guestChatId: guestChatId
            });

            await sendTelegramMessage(chatId,
                `✅ <b>¡Chat ID registrado!</b> (<code>${guestChatId}</code>)\n\n` +
                `📍 <b>Monitor:</b> <b>${existingDev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `✏️ Ahora escribe el <b>Nombre o Parentesco</b> de esta persona (ej: <i>Pedro</i>, <i>Mamá</i>, <i>José</i>):`,
                [[{ text: '⏭️ Omitir / Guardar sin nombre', callback_data: `/skip_guest_name_${devId}_${guestChatId}` }]]
            );
            return res.status(200).send('OK');
        }

        // --- PENDIENTE: ASIGNAR O MODIFICAR NOMBRE DE FAMILIAR ---
        if (pending && (pending.action === 'SET_GUEST_NAME' || pending.action === 'RENAME_GUEST') && cleanText.length > 0 && !cleanText.startsWith('/')) {
            const devId = pending.devId;
            const guestChatId = pending.guestChatId;
            const guestName = cleanText.trim();
            await clearPendingState(chatId);

            const existingDev = getDevice(devId) || { deviceId: devId };
            if (!checkIsOwner(existingDev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede gestionar nombres de familiares.`, []);
                return res.status(200).send('OK');
            }

            setGuestName(devId, guestChatId, guestName);
            await saveToCloud();

            await sendTelegramMessage(chatId,
                `🎉 <b>¡Familiar configurado con éxito!</b>\n\n` +
                `👤 <b>Nombre:</b> <b>${guestName}</b>\n` +
                `👥 <b>Chat ID:</b> <code>${guestChatId}</code>\n` +
                `📍 <b>Monitor:</b> <b>${existingDev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `Ahora recibirá todas las alertas del monitor.`,
                [
                    [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                    [{ text: '📊 Ver Estado', callback_data: `/estado_${devId}` }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]
            );

            sendTelegramMessage(guestChatId,
                `🎉 <b>¡Hola ${guestName}! Fuiste registrado como Familiar Autorizado</b>\n\n` +
                `Ahora recibirás alertas de <b>${existingDev.alias || devId}</b> (<code>${devId}</code>).`,
                [[{ text: '📊 Ver Estado', callback_data: `/estado_${devId}` }]]
            ).catch(() => {});

            return res.status(200).send('OK');
        }

        // --- PENDIENTE: RENOMBRAR CASA / MONITOR ---
        if (pending && pending.action === 'RENAME_DEVICE' && cleanText.length > 0 && !cleanText.startsWith('/')) {
            const renameDevId = pending.devId;
            await clearPendingState(chatId);

            const existingDev = getDevice(renameDevId) || { deviceId: renameDevId };
            if (!checkIsOwner(existingDev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede renombrar este monitor.`, []);
                return res.status(200).send('OK');
            }

            global.aliases[renameDevId] = cleanText;
            existingDev.alias = cleanText;
            existingDev.chatId = existingDev.chatId || chatId;
            persistDevice(renameDevId, existingDev);
            await saveToCloud();
            await sendTelegramMessage(chatId,
                `✅ <b>¡Nombre asignado!</b>\n\n📍 <b>${cleanText}</b> (<code>${renameDevId}</code>)`,
                [[{ text: '📊 Ver Estado', callback_data: `/estado_${renameDevId}` }],
                 [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]]
            );
            return res.status(200).send('OK');
        }

        // Helper local: buscar dispositivos de un usuario (dueño o invitado) — excluir desvinculados
        const getMyDevs = () => {
            const cleanCid = String(chatId || '').trim();
            const altCid = cleanCid === '3307499449' ? '330749449' : (cleanCid === '330749449' ? '3307499449' : cleanCid);
            return devs.filter(d => {
                if (d.unlinked) return false;
                const devOwner = String(d.chatId || '').trim();
                const isOwner = devOwner === cleanCid || devOwner === altCid;
                const guests = (d.guestChatIds || []).map(g => String(g).trim());
                const isGuest = guests.includes(cleanCid) || guests.includes(altCid);
                return isOwner || isGuest;
            });
        };

        // --- COMANDOS PRINCIPALES ---
        if (text.startsWith('/skip_guest_name_')) {
            const parts = text.replace('/skip_guest_name_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const guestChatId = (parts[1] || '').trim();
            await clearPendingState(chatId);
            const dev = getDevice(devId) || { deviceId: devId };

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede registrar familiares.`, []);
                return res.status(200).send('OK');
            }

            await sendTelegramMessage(chatId,
                `✅ <b>Familiar registrado sin nombre personalizado.</b>\n\n` +
                `👥 <b>Chat ID:</b> <code>${guestChatId}</code>\n` +
                `📍 <b>Monitor:</b> <b>${dev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `💡 <i>Puedes asignarle un nombre en cualquier momento desde "👥 Gestión de Familiares" > "✏️ Modificar Nombre".</i>`,
                [
                    [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                    [{ text: '📊 Ver Estado', callback_data: `/estado_${devId}` }]
                ]
            );
            sendTelegramMessage(guestChatId,
                `🎉 <b>¡Fuiste agregado como Familiar Autorizado!</b>\n\nAhora recibirás alertas de <b>${dev.alias || devId}</b> (<code>${devId}</code>).`,
                [[{ text: '📊 Ver Estado', callback_data: `/estado_${devId}` }]]
            ).catch(() => {});

        } else if (text.startsWith('/pedirinvitado_')) {
            const devId = text.replace('/pedirinvitado_', '').toUpperCase().trim();
            const dev = getDevice(devId) || { deviceId: devId };

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede agregar familiares.`, []);
                return res.status(200).send('OK');
            }

            await setPendingState(chatId, {
                action: 'ADD_GUEST_CHAT_ID',
                devId: devId
            });
            await sendTelegramMessage(chatId,
                `👥 <b>Agregando Familiar a:</b> <code>${dev.alias || devId}</code> (<code>${devId}</code>)\n\n` +
                `👉 Escribe el Chat ID de Telegram de tu familiar.\n\n` +
                `💡 <i>Tu familiar escribe <b>hola</b> al bot y le aparece su Chat ID para copiarlo con 1 toque.</i>`,
                [[{ text: '❌ Cancelar', callback_data: '/invitar' }]]
            );

        } else if (text.startsWith('/modificarinvitado_')) {
            // MENÚ PARA SELECCIONAR QUÉ FAMILIAR MODIFICAR / RENOMBRAR
            const devId = text.replace('/modificarinvitado_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede gestionar familiares.`, []);
                return res.status(200).send('OK');
            }

            if (!dev || (dev.guestChatIds || []).length === 0) {
                await sendTelegramMessage(chatId,
                    `ℹ️ <b>No hay familiares registrados en <code>${dev ? (dev.alias || devId) : devId}</code>.</b>`,
                    [[{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }]]
                );
            } else {
                const guests = dev.guestChatIds;
                const devName = dev.alias || devId;

                let listMsg = `✏️ <b>MODIFICAR FAMILIAR — ${devName}</b>\n\n` +
                              `Selecciona el familiar al que deseas colocarle o cambiarle el nombre:\n\n`;

                const buttons = [];
                guests.forEach((gId, index) => {
                    const gName = getGuestName(dev, gId) || `Familiar ${index + 1}`;
                    listMsg += `• <b>${gName}</b> (<code>${gId}</code>) [<code>${dev.deviceId}</code>]\n`;
                    buttons.push([{ text: `✏️ ${gName} (${gId})`, callback_data: `/nombrarguest_${dev.deviceId}_${gId}` }]);
                });
                buttons.push([{ text: `🔙 Volver`, callback_data: '/invitar' }]);

                await sendTelegramMessage(chatId, listMsg, buttons);
            }

        } else if (text.startsWith('/nombrarguest_')) {
            // PEDIR EL NUEVO NOMBRE DE UN FAMILIAR ESPECÍFICO
            const parts = text.replace('/nombrarguest_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const guestChatId = (parts[1] || '').trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede renombrar familiares.`, []);
                return res.status(200).send('OK');
            }

            const devName = dev ? (dev.alias || devId) : devId;
            const currentName = getGuestName(dev, guestChatId) || 'Sin nombre';

            await setPendingState(chatId, {
                action: 'RENAME_GUEST',
                devId: devId,
                guestChatId: guestChatId
            });

            await sendTelegramMessage(chatId,
                `✏️ <b>Modificar Nombre de Familiar</b>\n\n` +
                `📍 <b>Monitor:</b> <b>${devName}</b> (<code>${devId}</code>)\n` +
                `👥 <b>Chat ID:</b> <code>${guestChatId}</code>\n` +
                `👤 <b>Nombre actual:</b> <b>${currentName}</b>\n\n` +
                `👉 Escribe el <b>Nuevo Nombre o Parentesco</b> (ej: <i>Pedro</i>, <i>Tío José</i>, <i>Mamá</i>):`,
                [[{ text: '❌ Cancelar', callback_data: '/invitar' }]]
            );

        } else if (text.startsWith('/askdelguest_')) {
            // PANTALLA DE CONFIRMACIÓN PARA ELIMINAR UN FAMILIAR ESPECÍFICO
            const parts = text.replace('/askdelguest_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const targetGuestId = (parts[1] || '').trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede eliminar familiares.`, []);
                return res.status(200).send('OK');
            }

            const devName = dev ? (dev.alias || devId) : devId;
            const gName = getGuestName(dev, targetGuestId) || 'Familiar';

            await sendTelegramMessage(chatId,
                `⚠️ <b>¿CONFIRMAS QUE DESEAS ELIMINAR ESTE FAMILIAR?</b>\n\n` +
                `👤 <b>Nombre:</b> <b>${gName}</b>\n` +
                `👥 <b>Chat ID:</b> <code>${targetGuestId}</code>\n` +
                `📍 <b>Monitor:</b> <b>${devName}</b> (<code>${devId}</code>)\n\n` +
                `⚠️ <i>Esta persona ya no tendrá acceso ni recibirá notificaciones cuando se vaya o vuelva la luz.</i>\n\n` +
                `¿Deseas continuar?`,
                [
                    [{ text: `🗑️ Sí, Eliminar a ${gName}`, callback_data: `/delguest_${devId}_${targetGuestId}` }],
                    [{ text: `❌ Cancelar`, callback_data: `/quitarinvitado_${devId}` }]
                ]
            );

        } else if (text.startsWith('/askdelallguests_')) {
            // PANTALLA DE CONFIRMACIÓN PARA ELIMINAR TODOS LOS FAMILIARES
            const devId = text.replace('/askdelallguests_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede eliminar familiares.`, []);
                return res.status(200).send('OK');
            }

            const devName = dev ? (dev.alias || devId) : devId;
            const count = (dev?.guestChatIds || []).length;

            await sendTelegramMessage(chatId,
                `🚨 <b>¿CONFIRMAS QUE DESEAS ELIMINAR TODOS LOS FAMILIARES?</b>\n\n` +
                `📍 <b>Monitor:</b> <b>${devName}</b> (<code>${devId}</code>)\n` +
                `👥 <b>Total a eliminar:</b> <b>${count} familiar(es)</b>\n\n` +
                `⚠️ <i>Todos los familiares autorizados perderán el acceso al monitor y dejarán de recibir alertas de luz de inmediato.</i>\n\n` +
                `¿Estás seguro de ejecutar esta acción?`,
                [
                    [{ text: `🗑️ Sí, Eliminar TODOS (${count})`, callback_data: `/delallguests_${devId}` }],
                    [{ text: `❌ Cancelar`, callback_data: `/quitarinvitado_${devId}` }]
                ]
            );

        } else if (text.startsWith('/delguest_')) {
            // ELIMINAR UN FAMILIAR ESPECÍFICO (UNO POR UNO) TRAS CONFIRMAR
            const parts = text.replace('/delguest_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const targetGuestId = (parts[1] || '').trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede eliminar familiares.`, []);
                return res.status(200).send('OK');
            }

            if (dev && targetGuestId) {
                const gName = getGuestName(dev, targetGuestId) || 'Familiar';
                dev.guestChatIds = (dev.guestChatIds || []).filter(g => String(g).trim() !== targetGuestId);
                if (dev.guestNames && dev.guestNames[targetGuestId]) {
                    delete dev.guestNames[targetGuestId];
                }
                persistDevice(devId, dev);
                await saveToCloud();

                await sendTelegramMessage(chatId,
                    `✅ <b>Familiar eliminado con éxito:</b>\n\n` +
                    `👤 <b>Nombre:</b> <b>${gName}</b>\n` +
                    `👥 <b>Chat ID:</b> <code>${targetGuestId}</code>\n` +
                    `📍 <b>Monitor:</b> <b>${dev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                    `Este familiar ya no recibirá alertas de luz ni tendrá acceso al monitor.`,
                    [
                        [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                    ]
                );

                // Notificar al familiar que fue desvinculado
                sendTelegramMessage(targetGuestId,
                    `ℹ️ <b>Notificación:</b> Has sido removido como familiar del monitor <b>${dev.alias || devId}</b>.`,
                    []
                ).catch(() => {});
            }

        } else if (text.startsWith('/delallguests_')) {
            // ELIMINAR TODOS LOS FAMILIARES DE UN MONITOR TRAS CONFIRMAR
            const devId = text.replace('/delallguests_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede eliminar familiares.`, []);
                return res.status(200).send('OK');
            }

            if (dev) {
                const prevGuests = [...(dev.guestChatIds || [])];
                dev.guestChatIds = [];
                dev.guestNames = {};
                persistDevice(devId, dev);
                await saveToCloud();

                await sendTelegramMessage(chatId,
                    `✅ <b>Todos los familiares de <code>${dev.alias || devId}</code> han sido eliminados.</b>\n\n` +
                    `Se eliminaron ${prevGuests.length} familiar(es) registrado(s).`,
                    [
                        [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                    ]
                );

                // Notificar a todos los familiares desvinculados
                for (const gId of prevGuests) {
                    if (gId) {
                        sendTelegramMessage(gId,
                            `ℹ️ <b>Notificación:</b> Has sido removido como familiar del monitor <b>${dev.alias || devId}</b>.`,
                            []
                        ).catch(() => {});
                    }
                }
            }

        } else if (text.startsWith('/quitarinvitado_')) {
            // MENÚ INTERACTIVO: PERMITE ELEGIR CUÁL FAMILIAR QUITAR (O TODOS)
            const devId = text.replace('/quitarinvitado_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede gestionar familiares.`, []);
                return res.status(200).send('OK');
            }

            if (!dev || (dev.guestChatIds || []).length === 0) {
                await sendTelegramMessage(chatId,
                    `ℹ️ <b>No hay familiares registrados en <code>${dev ? (dev.alias || devId) : devId}</code>.</b>`,
                    [[{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }]]
                );
            } else {
                const guests = dev.guestChatIds;
                const devName = dev.alias || devId;

                let listMsg = `👥 <b>ELIMINAR FAMILIAR — ${devName}</b>\n\n` +
                              `Selecciona el familiar que deseas eliminar de este monitor:\n\n`;

                const buttons = [];
                guests.forEach((gId, index) => {
                    const gName = getGuestName(dev, gId) || `Familiar ${index + 1}`;
                    listMsg += `• <b>${gName}</b> (<code>${gId}</code>) [<code>${dev.deviceId}</code>]\n`;
                    buttons.push([{ text: `❌ Quitar ${gName} (${gId})`, callback_data: `/askdelguest_${dev.deviceId}_${gId}` }]);
                });

                if (guests.length > 1) {
                    buttons.push([{ text: `🗑️ Quitar TODOS los Familiares (${guests.length})`, callback_data: `/askdelallguests_${dev.deviceId}` }]);
                }
                buttons.push([{ text: `🔙 Volver`, callback_data: '/invitar' }]);

                await sendTelegramMessage(chatId, listMsg, buttons);
            }

        } else if (text.startsWith('/pedirnombre_')) {
            const devId = text.replace('/pedirnombre_', '').toUpperCase().trim();
            const dev = getDevice(devId) || { deviceId: devId };

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede renombrar este monitor.`, []);
                return res.status(200).send('OK');
            }

            await setPendingState(chatId, {
                action: 'RENAME_DEVICE',
                devId: devId
            });
            await sendTelegramMessage(chatId,
                `✏️ <b>Renombrando:</b> <code>${dev.alias || devId}</code> (<code>${devId}</code>)\n\n👉 Escribe el nuevo nombre (ej: <i>Casa Maracay</i>):`,
                [[{ text: '❌ Cancelar', callback_data: '/casas' }]]
            );

        } else if (text.startsWith('/estado_')) {
            const devId = text.replace('/estado_', '').toUpperCase().trim();
            await sendTelegramMessage(chatId, buildStatusMsg(getDevice(devId), devId, chatId), [
                [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                [{ text: '📜 Ver Historial', callback_data: '/historial' }]
            ]);

        } else if (text.includes('/estado') || text.includes('estado')) {
            const now = Date.now();
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId,
                    `⚠️ <b>Dispositivo no vinculado.</b>\n\nTu Chat ID: <code>${chatId}</code>. Ingrésalo al configurar la placa.`, []);
            } else if (myDevs.length > 1) {
                await sendTelegramMessage(chatId, `🏠 <b>¿Cuál monitor deseas consultar?</b>`,
                    myDevs.map(d => {
                        const on = (now - d.lastSeen) < OFFLINE_THRESHOLD_MS;
                        const isOwn = checkIsOwner(d, chatId);
                        const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                        return [{ text: `${on ? '🟢' : '🔴'} ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/estado_${d.deviceId}` }];
                    })
                );
            } else {
                await sendTelegramMessage(chatId, buildStatusMsg(myDevs[0], myDevs[0].deviceId, chatId), [
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                    [{ text: '📜 Ver Historial', callback_data: '/historial' }]
                ]);
            }

        } else if (text.includes('/casas') || text.includes('/dispositivos') || text.includes('mis casas') || text.includes('monitores')) {
            const now = Date.now();
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes monitores vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else {
                let txt = `🏠 <b>TUS MONITORES (${myDevs.length}):</b>\n\n`;
                const btns = [];
                myDevs.forEach(d => {
                    const on = (now - d.lastSeen) < OFFLINE_THRESHOLD_MS;
                    const isOwn = checkIsOwner(d, chatId);
                    const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                    const geoSuffix = (d.city && d.isp) ? ` <i>(${d.city} — ${d.isp})</i>` : '';
                    txt += `• <b>${d.alias || d.deviceId}</b> [${roleTag}]${geoSuffix}: ${on ? '🟢 HAY LUZ' : '🔴 SIN LUZ'}\n`;
                    btns.push([{ text: `📍 ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/estado_${d.deviceId}` }]);
                });
                btns.push([{ text: '✏️ Cambiar Nombre', callback_data: '/renombrar' }]);
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.startsWith('/historial_')) {
            const devId = text.replace('/historial_', '').toUpperCase().trim();
            const dev = getDevice(devId);
            await sendTelegramMessage(chatId,
                dev ? buildHistoryMsg(dev, chatId) : `⚠️ No encontré el dispositivo <code>${devId}</code>.`,
                [[{ text: '📊 Estado en Vivo', callback_data: `/estado_${devId}` }],
                 [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]]
            );

        } else if (text.includes('/historial') || text.includes('historial') || text.includes('cortes')) {
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes monitores vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else if (myDevs.length > 1) {
                await sendTelegramMessage(chatId, `📜 <b>¿De cuál monitor deseas ver el historial de cortes?</b>`,
                    myDevs.map(d => {
                        const isOwn = checkIsOwner(d, chatId);
                        const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                        return [{ text: `📜 ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/historial_${d.deviceId}` }];
                    })
                );
            } else {
                await sendTelegramMessage(chatId, buildHistoryMsg(myDevs[0], chatId), [
                    [{ text: '📊 Estado en Vivo', callback_data: `/estado_${myDevs[0].deviceId}` }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]);
            }

        } else if (text.startsWith('/reporte_')) {
            const devId = text.replace('/reporte_', '').toUpperCase().trim();
            const dev = getDevice(devId);
            await sendTelegramMessage(chatId,
                dev ? (buildWeeklyReport(dev, chatId) || '⚠️ Sin datos suficientes.') : `⚠️ No encontré el dispositivo <code>${devId}</code>.`,
                [[{ text: '📊 Estado en Vivo', callback_data: `/estado_${devId}` }],
                 [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]]
            );

        } else if (text.includes('/reporte') || text.includes('reporte') || text.includes('semanal')) {
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes monitores vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else if (myDevs.length > 1) {
                await sendTelegramMessage(chatId, `📈 <b>¿De cuál monitor deseas generar el reporte semanal?</b>`,
                    myDevs.map(d => {
                        const isOwn = checkIsOwner(d, chatId);
                        const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                        return [{ text: `📈 ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/reporte_${d.deviceId}` }];
                    })
                );
            } else {
                await sendTelegramMessage(chatId, buildWeeklyReport(myDevs[0], chatId) || '⚠️ Sin datos suficientes.', [
                    [{ text: '📊 Estado en Vivo', callback_data: `/estado_${myDevs[0].deviceId}` }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]);
            }

        } else if (text.includes('/nombre') || text.includes('/renombrar') || text.includes('renombrar') || text.includes('asignar')) {
            const myDevs = devs.filter(d => checkIsOwner(d, chatId, true));
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes dispositivos como propietario administrador vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else {
                let txt = `🏷️ <b>¿A cuál monitor le cambias el nombre?</b>\n\n`;
                const btns = [];
                myDevs.forEach(d => {
                    txt += `• <b>${d.alias || d.deviceId}</b>\n`;
                    btns.push([{ text: `✏️ Renombrar ${d.alias || d.deviceId}`, callback_data: `/pedirnombre_${d.deviceId}` }]);
                });
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.includes('/invitar') || text.includes('invitar') || text.includes('familiar') || text.includes('invitado')) {
            const myDevs = devs.filter(d => checkIsOwner(d, chatId, true));
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ Solo el propietario administrador puede agregar o gestionar familiares en el monitor.`, []);
            } else {
                let txt = `👥 <b>GESTIÓN DE FAMILIARES E INVITADOS</b>\n\n`;
                const btns = [];
                myDevs.forEach(d => {
                    const guests = d.guestChatIds || [];
                    const n = guests.length;
                    const devName = d.alias || d.deviceId;
                    txt += `📍 <b>${devName}</b> (<code>${d.deviceId}</code>) — ${n} familiar(es):\n`;
                    if (n === 0) {
                        txt += `   <i>(Sin familiares registrados)</i>\n`;
                    } else {
                        guests.forEach((gId, idx) => {
                            const gName = getGuestName(d, gId) || `Familiar ${idx + 1}`;
                            txt += `   • <b>${gName}</b> (<code>${gId}</code>)\n`;
                        });
                    }
                    txt += `\n`;
                    btns.push([{ text: `➕ Agregar a ${devName}`, callback_data: `/pedirinvitado_${d.deviceId}` }]);
                    if (n > 0) {
                        btns.push([{ text: `✏️ Modificar Nombre en ${devName}`, callback_data: `/modificarinvitado_${d.deviceId}` }]);
                        btns.push([{ text: `❌ Quitar Familiar en ${devName}`, callback_data: `/quitarinvitado_${d.deviceId}` }]);
                    }
                });
                btns.push([{ text: '🏠 Mis Monitores', callback_data: '/casas' }]);
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.startsWith('/confirm_reset_step1_')) {
            // PASO 2 DE CONFIRMACIÓN: ALERTA CRÍTICA DE DESCONFIGURACIÓN
            const devId = text.replace('/confirm_reset_step1_', '').toUpperCase().trim();
            const myDev = devs.find(d => checkIsOwner(d, chatId, true) && d.deviceId.toUpperCase() === devId);
            if (!myDev) {
                await sendTelegramMessage(chatId, `⚠️ <b>Acceso Denegado o monitor no encontrado.</b> Solo el propietario puede reiniciar la placa.`, []);
            } else {
                const devName = myDev.alias || myDev.deviceId;
                await sendTelegramMessage(chatId,
                    `🚨 <b>¡ALERTA DE DESCONFIGURACIÓN!</b> 🚨\n\n` +
                    `⚠️ <b>Si continúas con esta acción:</b>\n` +
                    `• La placa <b>${devName}</b> (<code>${myDev.deviceId}</code>) <b>borrará la clave WiFi actual</b>.\n` +
                    `• El monitor se desconfigurará y <b>dejará de enviar alertas de luz</b>.\n` +
                    `• Emitirá su propia red WiFi (<code>Configurar-Luz</code>) para que te conectes desde tu celular y la vuelvas a configurar.\n\n` +
                    `¿Está totalmente seguro de proceder?`,
                    [
                        [{ text: "🔄 Sí, Desconfigurar y Reiniciar", callback_data: `/confirm_reset_final_${myDev.deviceId}` }],
                        [{ text: "❌ No, Cancelar", callback_data: "/casas" }]
                    ]
                );
            }

        } else if (text.startsWith('/confirm_reset_final_')) {
            // PASO 3: EJECUCIÓN FINAL DE LA ORDEN DE REINICIO
            const devId = text.replace('/confirm_reset_final_', '').toUpperCase().trim();
            const myDev = devs.find(d => checkIsOwner(d, chatId, true) && d.deviceId.toUpperCase() === devId);
            if (!myDev) {
                await sendTelegramMessage(chatId, `⚠️ <b>Acceso Denegado.</b> Solo el administrador propietario puede reiniciar la placa.`, []);
            } else {
                if (global.persistentStore[myDev.deviceId]) global.persistentStore[myDev.deviceId].resetRequested = true;
                if (global.devices[myDev.deviceId]) global.devices[myDev.deviceId].resetRequested = true;
                await saveToCloud();
                await sendTelegramMessage(chatId,
                    `✅ <b>¡Orden de reinicio enviada a la placa!</b>\n\n` +
                    `📱 <b>Dispositivo:</b> <code>${myDev.deviceId}</code>\n\n` +
                    `En su próximo reporte (máximo 60 segundos), la placa borrará su memoria WiFi y activará la red <code>Configurar-Luz</code>.`,
                    [[{ text: "📊 Ver Estado", callback_data: `/estado_${myDev.deviceId}` }]]
                );
            }

        } else if (text.includes('/reiniciar') || text.includes('reiniciar')) {
            // PASO 1 DE CONFIRMACIÓN: PREGUNTAR SI ESTÁ SEGURO
            const myDevs = devs.filter(d => checkIsOwner(d, chatId, true));
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ <b>Acceso Denegado.</b> Solo el administrador propietario puede reiniciar la placa.`, []);
            } else {
                const myDev = myDevs[0];
                const devName = myDev.alias || myDev.deviceId;
                await sendTelegramMessage(chatId,
                    `⚠️ <b>¿Está seguro de que desea reiniciar la placa?</b>\n\n` +
                    `📍 <b>Monitor:</b> <b>${devName}</b> (<code>${myDev.deviceId}</code>)\n\n` +
                    `Esta acción iniciará el proceso de reinicio WiFi del equipo.`,
                    [
                        [{ text: "⚠️ Sí, deseo continuar", callback_data: `/confirm_reset_step1_${myDev.deviceId}` }],
                        [{ text: "❌ Cancelar", callback_data: "/casas" }]
                    ]
                );
            }

        } else if (text.includes('/chatid') || text.includes('chatid') || text.includes('mi id')) {
            await sendTelegramMessage(chatId, `<code>${chatId}</code>`, [
                [{ text: '📊 Estado en Vivo', callback_data: '/estado' }],
                [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
            ]);

        } else if (text.includes('hola') || text.includes('/start') || text.includes('hello')) {
            const myDevs = getMyDevs();
            if (myDevs.length > 0) {
                const d = myDevs[0];
                const on = (Date.now() - d.lastSeen) < OFFLINE_THRESHOLD_MS;
                await sendTelegramMessage(chatId,
                    `⚡ <b>¡Hola ${senderName}! Bienvenido a Monitor de Luz</b>\n\n` +
                    `Tu monitor <b>${d.alias || d.deviceId}</b> está ${on ? '🟢 CON LUZ' : '🔴 SIN LUZ'}.\n\n¿Qué deseas hacer?`,
                    [
                        [{ text: '📍 Ver Ubicaciones (Web App) 📱', web_app: { url: `https://monitor-luz-vercel-six.vercel.app/devices?chatId=${chatId}` } }],
                        [{ text: '📊 Estado en Vivo', callback_data: '/estado' }],
                        [{ text: '🆔 Ver mi Chat ID', callback_data: '/chatid' }],
                        [{ text: '✏️ Renombrar Casas', callback_data: '/renombrar' }],
                        [{ text: '👥 Gestionar Familiares', callback_data: '/invitar' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                        [{ text: '📈 Reporte Semanal', callback_data: '/reporte' }],
                        [{ text: '📜 Historial de Cortes', callback_data: '/historial' }]
                    ]
                );
            } else {
                await sendTelegramMessage(chatId, `<code>${chatId}</code>`, [
                    [{ text: '📊 Estado en Vivo', callback_data: '/estado' }]
                ]);
            }

        } else if (!text.startsWith('/')) {
            const myDevs = getMyDevs();
            const queryNorm = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
            const matchedDev = myDevs.find(d => {
                const aliasNorm = (d.alias || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
                const devIdNorm = (d.deviceId || '').toLowerCase().trim();
                return (aliasNorm && (aliasNorm === queryNorm || queryNorm.includes(aliasNorm) || aliasNorm.includes(queryNorm))) ||
                       (devIdNorm && (devIdNorm === queryNorm || queryNorm.includes(devIdNorm)));
            });

            if (matchedDev) {
                await sendTelegramMessage(chatId, buildStatusMsg(matchedDev, matchedDev.deviceId, chatId), [
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                    [{ text: '📜 Ver Historial', callback_data: `/historial_${matchedDev.deviceId}` }]
                ]);
            } else {
                await sendTelegramMessage(chatId,
                    `💡 <i>Escribe <b>hola</b> para ver el menú, o usa los botones de abajo:</i>`,
                    [
                        [{ text: '📍 Ver Ubicaciones (Web App) 📱', web_app: { url: `https://monitor-luz-vercel-six.vercel.app/devices?chatId=${chatId}` } }],
                        [{ text: '📊 Estado en Vivo', callback_data: '/estado' }],
                        [{ text: '🆔 Ver mi Chat ID', callback_data: '/chatid' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                        [{ text: '✏️ Renombrar', callback_data: '/renombrar' }]
                    ]
                );
            }
        } else {
            await sendTelegramMessage(chatId,
                `💡 <i>Escribe <b>hola</b> para ver el menú, o usa los botones de abajo:</i>`,
                [
                    [{ text: '📍 Ver Ubicaciones (Web App) 📱', web_app: { url: `https://monitor-luz-vercel-six.vercel.app/devices?chatId=${chatId}` } }],
                    [{ text: '📊 Estado en Vivo', callback_data: '/estado' }],
                    [{ text: '🆔 Ver mi Chat ID', callback_data: '/chatid' }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                    [{ text: '✏️ Renombrar', callback_data: '/renombrar' }]
                ]
            );
        }

    } catch (e) {
        console.error('[WEBHOOK ERROR]:', e.message);
    }

    return res.status(200).send('OK');
});


// Helper: verificar si un chatId es el Titular (Dueño) de un dispositivo
function checkIsOwner(device, chatId, strict = false) {
    if (!device) return !strict;
    let reqId = String(chatId || '').trim();
    let devOwnerId = String(device.chatId || '').trim();
    if (reqId === '3307499449') reqId = '330749449';
    if (devOwnerId === '3307499449') devOwnerId = '330749449';

    // Lista de invitados registrados
    const guests = (device.guestChatIds || []).map(g => {
        let id = String(g).trim();
        return id === '3307499449' ? '330749449' : id;
    });

    // Si explícitamente es un familiar invitado registrado -> Invitado (NO Titular)
    if (reqId && guests.includes(reqId)) {
        return false;
    }

    // Si coincide con el Chat ID del titular registrado
    if (reqId && devOwnerId && reqId === devOwnerId) {
        return true;
    }

    // MODO ESTRICTO (Para acciones destructivas/administrativas como reiniciar WiFi o borrar historial):
    // Requiere OBLIGATORIAMENTE que el solicitante esté autenticado y coincida con el titular.
    if (strict) {
        return false;
    }

    // Si no se pasó chatId (acceso directo del titular desde navegador/favoritos para modo LECTURA)
    // se reconoce como Titular para visualización básica
    if (!reqId) {
        return true;
    }

    return false;
}

// 3. ENDPOINT PARA REGISTRAR ORDEN DE REINICIO REMOTO (POST /api/reset-wifi)
app.post('/api/reset-wifi', async (req, res) => {
    await loadFromCloud();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const reqChatId = (req.body.chatId || req.headers['x-chat-id'] || '').toString().trim();
    const device = getDevice(deviceId);

    if (!deviceId || !device) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    // CONTROL DE AUTENTICACIÓN ESTRICTO: Exige Chat ID de Titular
    if (!reqChatId) {
        return res.status(401).json({ 
            error: '🔒 AUTENTICACIÓN REQUERIDA: No se proporcionó identificación. Por favor abra el enlace desde su bot de Telegram como Titular para ejecutar esta acción crítica.' 
        });
    }

    // CONTROL DE PERMISOS ESTRICTO: Solo el Titular puede reiniciar/desconfigurar la placa
    const isOwner = checkIsOwner(device, reqChatId, true);
    if (!isOwner) {
        return res.status(403).json({ 
            error: '⛔ ACCESO DENEGADO: Usted es un Familiar Invitado o no está autorizado para desconfigurar o reiniciar la red WiFi de la placa. Solo el Titular puede realizar esta acción.' 
        });
    }

    device.resetRequested = true;
    device.unlinked = true;
    persistDevice(deviceId, device);
    await saveToCloud();

    return res.json({ success: true, message: 'Orden de reinicio registrada por el Titular.' });
});

// 3.1 ENDPOINT CUANDO EL DISPOSITIVO SE DESVINCULA (POST /api/device-unlinked)
app.post('/api/device-unlinked', async (req, res) => {
    await loadFromCloud();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const reqChatId = (req.body.chatId || req.headers['x-chat-id'] || '').toString().trim();
    const device = getDevice(deviceId);

    if (!deviceId || !device) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    // CONTROL DE SEGURIDAD: Solo el Titular puede desvincular el dispositivo
    if (!reqChatId || !checkIsOwner(device, reqChatId, true)) {
        return res.status(403).json({ error: '⛔ ACCESO DENEGADO: Solo el Titular verificado puede desvincular el dispositivo.' });
    }

    device.unlinked = true;
    device.resetRequested = true; // Forzar reinicio WiFi si vuelve a conectarse
    device.chatId = '';
    device.guestChatIds = []; // Limpiar familiares
    device.guestNames = {};
    device.alias = deviceId; // Restablecer alias
    if (global.aliases[deviceId]) delete global.aliases[deviceId];
    device.blackoutNotified = false;
    persistDevice(deviceId, device);
    await saveToCloud();

    return res.json({ success: true, message: 'Dispositivo marcado como desvinculado.' });
});

// 4. ENDPOINT PARA BORRAR EL HISTORIAL DE UN DISPOSITIVO (POST /api/clear-history)
app.post('/api/clear-history', async (req, res) => {
    await loadFromCloud();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const reqChatId = (req.body.chatId || req.headers['x-chat-id'] || '').toString().trim();
    const device = getDevice(deviceId);

    if (!deviceId || !device) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    // CONTROL DE AUTENTICACIÓN ESTRICTO: Exige Chat ID de Titular
    if (!reqChatId) {
        return res.status(401).json({ 
            error: '🔒 AUTENTICACIÓN REQUERIDA: No se proporcionó identificación. Por favor abra el enlace desde su bot de Telegram como Titular para ejecutar esta acción crítica.' 
        });
    }

    // CONTROL DE PERMISOS ESTRICTO: Solo el Titular puede borrar el historial
    const isOwner = checkIsOwner(device, reqChatId, true);
    if (!isOwner) {
        return res.status(403).json({ 
            error: '⛔ ACCESO DENEGADO: Usted es un Familiar Invitado o no está autorizado para borrar el historial de cortes. Solo el Titular puede realizar esta acción.' 
        });
    }

    device.history = [];
    persistDevice(deviceId, device);
    await saveToCloud();

    return res.json({ success: true, message: `Historial de ${deviceId} borrado exitosamente por el Titular.` });
});

// 5. ENDPOINT CRON JOB DE VERCEL PARA CHEQUEAR CORTES CADA MINUTO AUTOMÁTICAMENTE
app.get('/api/cron-check-blackout', (req, res) => {
    checkBlackoutAlerts();
    return res.json({ success: true, message: 'Chequeo automático de cortes ejecutado.' });
});

// 5.1 ENDPOINT CRON JOB PARA REPORTE SEMANAL DE LOS DOMINGOS A MEDIANOCHE
app.get('/api/cron-weekly-report', async (req, res) => {
    loadFromDisk();
    const combined = { ...global.persistentStore, ...global.devices };
    let sentCount = 0;
    const now = Date.now();

    for (const dev of Object.values(combined)) {
        if (!dev || !dev.deviceId) continue;
        let devChatId = (dev.chatId || '').toString().trim();
        if (devChatId === '3307499449') devChatId = '330749449';

        // GUARDIA ANTI-DUPLICADOS: Si ya se envió en los últimos 5 días, omitir
        if (dev.lastWeeklyReportSentAt && (now - dev.lastWeeklyReportSentAt < 5 * 24 * 60 * 60 * 1000)) {
            console.log(`[WEEKLY-REPORT] Reporte semanal ya enviado recientemente a ${dev.deviceId}. Omitiendo duplicado.`);
            continue;
        }

        if (devChatId) {
            const reportMsg = buildWeeklyReport(dev, devChatId);
            if (reportMsg) {
                await sendTelegramMessage(devChatId, reportMsg);
                dev.lastWeeklyReportSentAt = now;
                persistDevice(dev.deviceId, dev);
                sentCount++;
            }
        }
    }

    if (sentCount > 0) {
        await saveToCloud();
    }

    return res.json({ success: true, message: `Reporte semanal procesado. Enviado a ${sentCount} dispositivos.` });
});

// 5.2 ENDPOINT CRON JOB PARA REPORTE DIARIO DE ESTABILIDAD (TODAS LAS NOCHES A LAS 9:00 PM VET / 1:00 AM UTC)
app.get('/api/cron-daily-report', async (req, res) => {
    loadFromDisk();
    const combined = { ...global.persistentStore, ...global.devices };
    let sentCount = 0;
    const now = Date.now();

    for (const dev of Object.values(combined)) {
        if (!dev || !dev.deviceId) continue;
        let devChatId = (dev.chatId || '').toString().trim();
        if (devChatId === '3307499449') devChatId = '330749449';

        // GUARDIA: Si ya se envió en las últimas 12 horas, omitir
        if (dev.lastDailyReportSentAt && (now - dev.lastDailyReportSentAt < 12 * 60 * 60 * 1000)) {
            console.log(`[DAILY-REPORT] Reporte diario ya enviado recientemente a ${dev.deviceId}. Omitiendo.`);
            continue;
        }

        if (devChatId) {
            const reportMsg = buildDailyReport(dev, devChatId);
            if (reportMsg) {
                await sendTelegramMessage(devChatId, reportMsg);
                dev.lastDailyReportSentAt = now;
                persistDevice(dev.deviceId, dev);
                sentCount++;
            }
        }
    }

    if (sentCount > 0) {
        await saveToCloud();
    }

    return res.json({ success: true, message: `Reporte diario procesado. Enviado a ${sentCount} dispositivos.` });
});

// ENDPOINT ENRIQUECIDO PARA PANEL MULTI-DISPOSITIVOS (rápido, sin bloqueo y filtrado por seguridad)
app.get('/api/devices-list', (req, res) => {
    try {
        // Disparar carga en background si hace falta, sin bloquear
        if (!isCloudLoaded) {
            loadFromCloud().catch(() => {});
        }
        const combined = { ...global.persistentStore, ...global.devices };
        const now = Date.now();
        
        let reqChatId = String(req.query.chatId || '').trim();
        // Corrección de bug conocido de Telegram ID para Franklin
        if (reqChatId === '3307499449') reqChatId = '330749449';

        const devices = Object.values(combined).map(device => {
            const deviceId = (device.deviceId || device.id || '').toString().toUpperCase();
            if (!deviceId) return null;

            // Si el dispositivo está desvinculado, NO mostrarlo en la lista
            if (device.unlinked || device.status === 'unlinked') return null;

            // Lógica de filtrado por chatId
            let isOwner = true;
            let isGuest = false;
            if (reqChatId) {
                let devOwnerId = String(device.chatId || '').trim();
                if (devOwnerId === '3307499449') devOwnerId = '330749449';
                const guests = (device.guestChatIds || []).map(g => {
                    let id = String(g).trim();
                    return id === '3307499449' ? '330749449' : id;
                });

                isOwner = checkIsOwner(device, reqChatId);
                isGuest = guests.includes(reqChatId);

                // Si no es dueño ni invitado, no se le muestra este dispositivo
                if (!isOwner && !isGuest) {
                    return null;
                }
            } else {
                isOwner = true;
                isGuest = false;
            }

            const alias = global.aliases[deviceId] || device.alias || (deviceId === 'ESP-51A1B1' ? 'Apto Maracay' : deviceId);
            const lastSeen = device.lastSeen || 0;
            const elapsedMs = lastSeen ? Math.max(0, now - lastSeen) : null;
            const isOnline = lastSeen && elapsedMs !== null && elapsedMs < OFFLINE_THRESHOLD_MS;
            const statusCode = isOnline ? 'online' : 'offline';
            const uptimeMs = (isOnline && device.onlineSince) ? Math.max(0, now - device.onlineSince) : 0;
            return {
                deviceId,
                alias,
                lastSeen,
                elapsedMs,
                uptimeMs,
                statusCode,
                history: device.history || [],
                isOwner,
                isGuest: !isOwner,
                role: isOwner ? 'propietario' : 'invitado',
                roleLabel: isOwner ? 'Propietario' : 'Invitado'
            };
        }).filter(Boolean);

        devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return res.json({ devices, total: devices.length });
    } catch (e) {
        console.error('[devices-list ERROR]', e.message);
        return res.json({ devices: [], total: 0, error: e.message });
    }
});

app.get('/api/devices', (req, res) => {
    checkBlackoutAlerts();
    const combined = { ...global.persistentStore, ...global.devices };
    const list = Object.values(combined).sort((a, b) => b.lastSeen - a.lastSeen);
    return res.json(list);
});

// 7. ENDPOINT PARA CONSULTAR EL ESTADO E HISTORIAL (GET /api/status/:id)
app.get('/api/status/:id', async (req, res) => {
    await loadFromCloud();
    await checkBlackoutAlerts();
    const deviceId = (req.params.id || '').toString().trim().toUpperCase();
    const reqChatId = (req.query.chatId || req.headers['x-chat-id'] || '').toString().trim();
    const device = getDevice(deviceId);
    const storedAlias = global.aliases[deviceId] || (device ? device.alias : null) || (deviceId === 'ESP-51A1B1' ? 'Apto Maracay' : deviceId);

    if (!device) {
        return res.json({
            found: false,
            deviceId: deviceId,
            alias: storedAlias,
            status: 'offline',
            message: 'SE FUE LA LUZ',
            history: [],
            isOwner: true,
            isGuest: false,
            role: 'owner',
            roleLabel: 'Titular'
        });
    }

    const isOwner = checkIsOwner(device, reqChatId);
    const role = isOwner ? 'owner' : 'guest';
    const roleLabel = isOwner ? 'Titular' : 'Familiar Invitado';

    // Si el dispositivo fue reseteado o desvinculado
    if (device.unlinked) {
        return res.json({
            found: true,
            deviceId: deviceId,
            alias: storedAlias,
            lastSeen: device.lastSeen,
            status: 'unlinked',
            message: 'DISPOSITIVO DESVINCULADO',
            history: device.history || [],
            isOwner: isOwner,
            isGuest: !isOwner,
            role: role,
            roleLabel: roleLabel
        });
    }

    // Comprobar si este dispositivo específico está online (menos de OFFLINE_THRESHOLD_MS desde el último reporte)
    const now = Date.now();
    const elapsedMs = now - device.lastSeen;
    const isOnline = elapsedMs < OFFLINE_THRESHOLD_MS;
    const uptimeMs = isOnline ? (now - (device.onlineSince || device.lastSeen)) : 0;

    // Disparo inmediato de alerta de corte si la web detecta que está offline y no se había notificado
    if (!isOnline && !device.blackoutNotified && device.chatId) {
        await checkBlackoutAlerts();
    }

    return res.json({
        found: true,
        deviceId: deviceId,
        alias: storedAlias,
        lastSeen: device.lastSeen,
        onlineSince: device.onlineSince || device.lastSeen,
        elapsedMs: elapsedMs,
        uptimeMs: uptimeMs,
        status: isOnline ? 'online' : 'offline',
        message: isOnline ? 'HAY LUZ' : 'SE FUE LA LUZ',
        history: device.history || [],
        isOwner: isOwner,
        isGuest: !isOwner,
        role: role,
        roleLabel: roleLabel
    });
});

// 8. ENDPOINT DE SINCRONIZACIÓN PERSISTENTE BIDIRECCIONAL (POST /api/sync-history)
app.post('/api/sync-history', (req, res) => {
    loadFromDisk();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const clientHistory = req.body.history;

    if (!deviceId || !Array.isArray(clientHistory)) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }

    const device = getDevice(deviceId) || {
        deviceId: deviceId,
        lastSeen: Date.now(),
        onlineSince: Date.now(),
        chatId: '',
        history: [],
        blackoutNotified: false,
        blackoutStartTime: null,
        resetRequested: false
    };

    const serverHistory = device.history || [];
    // Combinar eventos del cliente y del servidor sin duplicados
    const historyMap = new Map();
    [...serverHistory, ...clientHistory].forEach(item => {
        if (item && item.id) {
            historyMap.set(item.id, item);
        } else if (item && item.start) {
            historyMap.set(`event_${item.start}`, item);
        }
    });

    // Ordenar del más reciente al más antiguo
    const mergedHistory = Array.from(historyMap.values()).sort((a, b) => b.start - a.start).slice(0, 50);

    device.history = mergedHistory;
    persistDevice(deviceId, device);

    return res.json({ success: true, history: mergedHistory });
});



// =========================================================================
// ENDPOINTS PARA GESTION DE FLOTA Y ACTUALIZACIONES OTA (FIRMWARE .BIN)
// =========================================================================
const multer = require('multer');
const { put } = require('@vercel/blob');
const upload = multer({ storage: multer.memoryStorage() });

// 9. SUBIR ARCHIVO .BIN (PENDIENTE)
app.post('/api/ota/upload', upload.single('firmware'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
        
        // Subir a Vercel Blob
        const blob = await put(`firmware-${Date.now()}.bin`, req.file.buffer, {
            access: 'public',
            token: process.env.BLOB_READ_WRITE_TOKEN
        });

        // Guardar como "pendiente" en Redis (aún no se despliega a las placas)
        await redis.set('ota_pending_firmware', blob.url);
        
        return res.json({ success: true, url: blob.url });
    } catch (error) {
        console.error('[OTA Upload Error]', error);
        return res.status(500).json({ error: error.message });
    }
});

// 10. DESPLEGAR ACTUALIZACIÓN (ACTIVAR)
app.post('/api/ota/deploy', async (req, res) => {
    try {
        const pendingUrl = await redis.get('ota_pending_firmware');
        if (!pendingUrl) return res.status(400).json({ error: 'No hay firmware pendiente' });

        // Leer la versión actual y subirla
        const currentVersion = await redis.get('ota_active_version') || 1.0;
        const newVersion = parseFloat(currentVersion) + 0.1;

        // Establecer como activo
        await redis.set('ota_active_firmware', pendingUrl);
        await redis.set('ota_active_version', newVersion.toFixed(1));
        
        // Limpiar el pendiente
        await redis.del('ota_pending_firmware');

        return res.json({ success: true, version: newVersion.toFixed(1) });
    } catch (error) {
        console.error('[OTA Deploy Error]', error);
        return res.status(500).json({ error: error.message });
    }
});

// 11. ENDPOINT DE DESCARGA DIRECTA PARA EL ESP8266 (AUTO-OTA)
app.all('/api/ota/download', async (req, res) => {
    console.log('OTA Download Request ALL:', req.method, req.url);
    console.log('OTA Download Request:', req.url, req.headers, req.query);
    try {
        const boardVersion = parseFloat(req.query.version || '1.0');
        const activeVersion = parseFloat(await redis.get('ota_active_version') || '1.0');
        const activeUrl = await redis.get('ota_active_firmware');

        if (activeUrl && activeVersion > boardVersion) {
            // Le decimos a la placa que sí hay actualización y la redirigimos al archivo .bin
            const response = await fetch(activeUrl);
            if (!response.ok) return res.status(500).send('Blob fetch failed');
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', response.headers.get('content-length'));
            const buffer = await response.arrayBuffer();
            return res.send(Buffer.from(buffer));
        } else {
            // Le decimos a la placa que NO hay actualizaciones (código 304 estándar de OTA)
            return res.status(304).send('Not Modified');
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// 12. ENDPOINT PARA EL PANEL DE ADMINISTRACIÓN (ESTADO OTA)
app.get('/api/ota/status', async (req, res) => {
    try {
        const activeVersion = await redis.get('ota_active_version') || '1.0';
        const pendingFirmware = await redis.get('ota_pending_firmware');
        return res.json({ 
            active_version: parseFloat(activeVersion).toFixed(1), 
            has_pending: !!pendingFirmware 
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// 13. ENDPOINT PROXY PARA BINANCE P2P (VES / USDT)
app.get('/api/p2p', async (req, res) => {
    try {
        const tradeType = (req.query.tradeType || 'BUY').toUpperCase();
        const payType = req.query.payType || '';
        const transAmount = req.query.transAmount || '';
        const rows = parseInt(req.query.rows || '15', 10);

        const payTypes = (payType && payType !== 'ALL') ? [payType] : [];

        const payload = {
            asset: 'USDT',
            fiat: 'VES',
            merchantCheck: false,
            page: 1,
            payTypes: payTypes,
            publisherType: null,
            rows: Math.min(rows, 20),
            tradeType: tradeType,
            transAmount: transAmount ? String(transAmount) : undefined
        };

        const binanceRes = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: JSON.stringify(payload)
        });

        if (!binanceRes.ok) {
            return res.status(502).json({ success: false, error: 'Binance P2P error: ' + binanceRes.status });
        }

        const data = await binanceRes.json();
        const rawAds = (data && data.data) ? data.data : [];

        const ads = rawAds.map(item => {
            const adv = item.adv || {};
            const advr = item.advertiser || {};
            const methods = (adv.tradeMethods || []).map(m => m.tradeMethodName || m.identifier).filter(Boolean);
            const ratePct = advr.monthFinishRate ? (advr.monthFinishRate * 100).toFixed(1) + '%' : '100%';

            return {
                name: advr.nickName || 'Comerciante',
                orders: advr.monthOrderCount || 0,
                rate: ratePct,
                price: parseFloat(adv.price || 0).toFixed(2),
                min: adv.minSingleTransAmount || '0',
                max: adv.dynamicMaxSingleTransAmount || adv.maxSingleTransAmount || '0',
                crypto: parseFloat(adv.tradableQuantity || adv.surplusAmount || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                banks: methods.slice(0, 2)
            };
        });

        const now = new Date();
        const timeStr = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });

        // Edge CDN Cache en Vercel: Cachea la respuesta 6 segundos en el CDN.
        // Las peticiones servidas desde la caché no consumen invocaciones de función serverless en la cuota mensual.
        res.setHeader('Cache-Control', 's-maxage=6, stale-while-revalidate=4');

        return res.json({
            success: true,
            updatedAt: timeStr,
            total: ads.length,
            ads: ads
        });
    } catch (e) {
        console.error('[P2P PROXY ERROR]:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// 14. ENDPOINT PARA DISPARAR ALERTA P2P A TELEGRAM
app.post('/api/p2p-alert', async (req, res) => {
    try {
        const body = req.body || {};
        const targetChatId = (body.chatId || '330749449').toString().trim();
        const tradeType = (body.tradeType || 'BUY').toUpperCase();
        const targetPrice = body.targetPrice || '0.00';
        const price = body.price || '0.00';
        const trader = body.trader || 'Comerciante P2P';
        const orders = body.orders || 0;
        const rate = body.rate || '100%';
        const bank = Array.isArray(body.bank) ? body.bank.join(', ') : (body.bank || 'Todos los Métodos');
        const crypto = body.crypto || '0.00';

        const now = new Date();
        const timeStr = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });

        const typeLabel = (tradeType === 'BUY') ? '🟢 COMPRAR USDT' : '🔴 VENDER USDT';

        const alertMsg = `🔔 <b>¡ALERTA P2P BINANCE! (PUESTO #1)</b> 🎯\n\n` +
                         `💵 <b>Operación:</b> <b>${typeLabel}</b>\n` +
                         `🎯 <b>Precio Objetivo Fijado:</b> <code>Bs ${targetPrice}</code>\n` +
                         `⚡ <b>Precio Oferta #1:</b> <b>Bs ${price}</b>\n` +
                         `━━━━━━━━━━━━━━━━━━━━\n` +
                         `👤 <b>Comerciante:</b> <b>${trader}</b>\n` +
                         `📊 <b>Reputación:</b> ${orders} órdenes (${rate})\n` +
                         `🏦 <b>Banco / Método:</b> ${bank}\n` +
                         `💰 <b>Saldo Disponible:</b> ${crypto} USDT\n` +
                         `⏰ <b>Hora de detección:</b> ${timeStr}\n\n` +
                         `🔗 <a href="https://p2p.binance.com/es/trade/all-payments/USDT?fiat=VES">Abrir Binance P2P</a>`;

        const result = await sendTelegramMessage(targetChatId, alertMsg, [
            [{ text: "📊 Ver Binance P2P Web", url: "https://p2p.binance.com/es/trade/all-payments/USDT?fiat=VES" }]
        ]);

        return res.json({ success: true, delivered: result.success });
    } catch (e) {
        console.error('[P2P ALERT ERROR]:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[MONITOR LUZ] Servidor activo escuchando en el puerto ${PORT}`);
    setInterval(async () => {
        try {
            await checkBlackoutAlerts();
        } catch (e) {
            console.error('[CRON CHECK ERROR]:', e.message);
        }
    }, 30000);
});

module.exports = app;
