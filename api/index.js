const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');

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

// Memoria compartida en Vercel
global.devices = global.devices || {};
global.persistentStore = global.persistentStore || {
    "ESP-51A1B1": {
        deviceId: "ESP-51A1B1",
        chatId: "330749449",
        lastSeen: Date.now(),
        blackoutStartTime: null,
        blackoutNotified: false,
        unlinked: false,
        history: []
    }
};

const BOT_TOKEN = "8541967821:AAGaTrOzPG9s_hRn2VnIOyq7-d21_XwJZ38";
const TMP_FILE = '/tmp/monitor-luz-devices.json';

// Guardar datos del dispositivo en archivo /tmp para sobrevivir entre invocaciones
// Guardar datos del dispositivo en archivo /tmp
function saveToDisk() {
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(global.persistentStore), 'utf8');
    } catch (e) {
        console.error('Error guardando en /tmp:', e.message);
    }
}

// Cargar datos del archivo /tmp al iniciar
function loadFromDisk() {
    try {
        if (fs.existsSync(TMP_FILE)) {
            const raw = fs.readFileSync(TMP_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data && Object.keys(data).length > 0) {
                global.persistentStore = { ...global.persistentStore, ...data };
                global.devices = { ...global.persistentStore };
            }
        }
    } catch (e) {
        console.error('Error leyendo /tmp:', e.message);
    }
}

// Cargar datos al arrancar
loadFromDisk();

function persistDevice(deviceId, data) {
    loadFromDisk();
    global.persistentStore[deviceId] = {
        ...data,
        updatedAt: Date.now()
    };
    global.devices[deviceId] = global.persistentStore[deviceId];
    saveToDisk();
}

function getDevice(deviceId) {
    loadFromDisk();
    return global.persistentStore[deviceId] || global.devices[deviceId] || null;
}

// Función para enviar mensajes de Telegram garantizada (Promise awaitable para serverless)
function sendTelegramMessage(chatId, text, customButtons = null) {
    if (!chatId) return Promise.resolve(false);
    return new Promise((resolve) => {
        try {
            const buttons = customButtons || [
                [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }],
                [{ text: "🌤️ Clima en tu Zona", callback_data: "/clima" }]
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
                    resolve(true);
                });
            });

            request.setTimeout(4000, () => {
                request.destroy();
                resolve(false);
            });

            request.on('error', (err) => {
                console.error('[TELEGRAM ERROR]:', err.message);
                resolve(false);
            });

            request.write(payload);
            request.end();
        } catch (e) {
            console.error('Error enviando Telegram:', e);
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
                { command: "renombrar", description: "✏️ Asignar o Renombrar Casas" },
                { command: "casas", description: "🏠 Mis Casas / Monitores" },
                { command: "reporte", description: "📈 Reporte semanal de estabilidad" },
                { command: "historial", description: "📜 Ver lista y duración de cortes" },
                { command: "clima", description: "🌤️ Ver el clima en tu ciudad" },
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

// Función inteligente para generar el Reporte Semanal de Estabilidad Eléctrica
function buildWeeklyReport(device) {
    if (!device) return null;
    const now = Date.now();
    const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
    const history = device.history || [];

    // Filtrar eventos ocurridos en los últimos 7 días
    const weekEvents = history.filter(h => (h.start && h.start >= oneWeekAgo) || (h.end && h.end >= oneWeekAgo));

    let totalBlackoutMs = 0;
    let longCutsCount = 0;
    let microCutsCount = 0;
    let longestCutMs = 0;
    let longestCutStr = "Ninguno";

    weekEvents.forEach(evt => {
        const dur = evt.durationMs || (evt.end && evt.start ? (evt.end - evt.start) : 0);
        totalBlackoutMs += dur;
        if (dur >= 300000) { // Mayor a 5 minutos
            longCutsCount++;
            if (dur > longestCutMs) {
                longestCutMs = dur;
                longestCutStr = `${evt.durationStr} (${evt.startDateStr || ''})`;
            }
        } else if (dur > 0) {
            microCutsCount++;
        }
    });

    const totalWeekMs = 7 * 24 * 60 * 60 * 1000;
    const blackoutHours = (totalBlackoutMs / (1000 * 60 * 60)).toFixed(1);
    const lightHours = Math.max(0, (168 - (totalBlackoutMs / (1000 * 60 * 60)))).toFixed(1);
    const stabilityPct = Math.max(0, Math.min(100, ((1 - (totalBlackoutMs / totalWeekMs)) * 100))).toFixed(1);

    let diagnostic = "✨ <b>Excelente:</b> Suministro eléctrico continuo y muy estable.";
    if (stabilityPct < 80) {
        diagnostic = "⚠️ <b>Inestable:</b> Se recomienda mantener protectores de voltaje activos.";
    } else if (stabilityPct < 95) {
        diagnostic = "👍 <b>Bueno:</b> Estabilidad dentro del promedio aceptable.";
    }

    const startDate = new Date(oneWeekAgo).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', timeZone: 'America/Caracas' });
    const endDate = new Date(now).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', timeZone: 'America/Caracas' });

    return `📊 <b>CRÉALO PowerWatch — REPORTE SEMANAL</b> ⚡\n` +
           `🗓️ <b>Período:</b> ${startDate} al ${endDate}\n` +
           `📱 <b>Dispositivo:</b> <code>${device.deviceId}</code>\n` +
           `━━━━━━━━━━━━━━━━━━━━\n\n` +
           `🟢 <b>Tiempo con Luz:</b> ${lightHours}h (<code>${stabilityPct}%</code>)\n` +
           `🔴 <b>Tiempo sin Luz:</b> ${blackoutHours}h\n\n` +
           `📈 <b>Desglose de la Semana:</b>\n` +
           `• 🔌 <b>Cortes Eléctricos (>5m):</b> ${longCutsCount}\n` +
           `• ⏱️ <b>Corte más largo:</b> ${longestCutStr}\n` +
           `• 〽️ <b>Fluctuaciones / Bajones:</b> ${microCutsCount}\n\n` +
           `💡 <b>Diagnóstico:</b>\n${diagnostic}\n\n` +
           `🔗 <b>Ver Monitor Web:</b>\nhttps://monitor-luz-vercel-six.vercel.app/?id=${device.deviceId}`;
}

// Comprobador de cortes de luz automático (Multi-Usuario 100% Genérico para CUALQUIER ESP)
async function checkBlackoutAlerts() {
    loadFromDisk();
    const now = Date.now();
    const combined = { ...global.persistentStore, ...global.devices };

    for (const dev of Object.values(combined)) {
        if (!dev.lastSeen || !dev.deviceId) continue;
        const elapsedMs = now - dev.lastSeen;

        let devChatId = (dev.chatId || '').toString().trim();
        if (devChatId === '3307499449') devChatId = '330749449'; // Sanitizar typo común

        // Si han pasado 300 segundos sin señal (5 minutos de gracia sólida anti-falsos positivos) y no se ha notificado la ida de luz
        if (elapsedMs >= 300000 && !dev.blackoutNotified && devChatId) {
            dev.blackoutNotified = true;
            dev.chatId = devChatId;
            dev.blackoutStartTime = dev.lastSeen; // Momento exacto en que se fue la luz
            dev.history = dev.history || [];

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

            persistDevice(dev.deviceId, {
                ...dev,
                blackoutNotified: true,
                chatId: devChatId,
                blackoutStartTime: dev.lastSeen,
                history: dev.history
            });

            const alertMsg = `⚠️ <b>¡ALERTA DE DESCONEXIÓN! 🔌🌐</b>\n\n` +
                             `📍 <b>Ubicación:</b> <code>${dev.alias || dev.deviceId}</code>\n` +
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
            await sendTelegramMessage(devChatId, alertMsg);
        }
    }
}

// 1. ENDPOINT PARA RECIBIR PING DE LA PLACA ESP8266 (POST /api/ping)
app.post('/api/ping', async (req, res) => {
    loadFromDisk();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const boardUptimeMs = parseInt(req.body.uptimeMs || 0, 10);
    const chatId = (req.body.chatId || req.body.telegramChatId || '').toString().trim();

    if (!deviceId) {
        return res.status(400).json({ error: 'Falta el parámetro deviceId' });
    }

    const now = Date.now();
    const onlineSince = boardUptimeMs > 0 ? (now - boardUptimeMs) : now;

    const existing = getDevice(deviceId) || {};
    const shouldReset = existing.resetRequested || false;
    const wasBlackout = existing.blackoutNotified || false;
    let targetChatId = chatId || existing.chatId || '';

    // Sanitizar typo común de chatId
    if (targetChatId === '3307499449') targetChatId = '330749449';

    let history = existing.history || [];

    // SI REGRESÓ LA LUZ / INTERNET TRAS UN CORTE (detectado por bandera wasBlackout o por corte abierto en historial)
    const hasOpenCut = history.length > 0 && !history[0].end;
    const isReturnFromBlackout = wasBlackout || hasOpenCut;

    const offlinePings = parseInt(req.body.offlinePings || req.body.missedPings || 0, 10);
    // Prioridad estricta de alias: preservar siempre el alias guardado previamente
    const incomingAlias = (req.body.alias || req.body.name || '').toString().trim();
    const deviceAlias = existing.alias || (incomingAlias && incomingAlias !== deviceId ? incomingAlias : deviceId);

    if (isReturnFromBlackout && (existing.lastSeen || existing.blackoutStartTime || hasOpenCut)) {
        // Obtener el momento real del corte:
        let blackoutStart = null;
        if (hasOpenCut && history[0].start) {
            blackoutStart = history[0].start;
        } else if (existing.blackoutStartTime) {
            blackoutStart = existing.blackoutStartTime;
        } else if (existing.lastSeen) {
            blackoutStart = existing.lastSeen;
        } else {
            blackoutStart = now - 240000;
        }

        const durationMs = Math.max(now - blackoutStart, 60000);
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

        // DISCRIMINACIÓN: ¿Fue corte eléctrico, caída de internet, o fluctuación?
        // Si el uptime de la placa es mayor a la duración del corte o tiene más de 5 pings acumulados en RAM -> La luz nunca se fue, solo cayó el internet
        const isOnlyInternetDrop = (boardUptimeMs > durationMs) || (offlinePings > 5);
        
        let eventType = 'power_outage';
        if (totalMins < 5) {
            eventType = 'fluctuation';
        } else if (isOnlyInternetDrop) {
            eventType = 'internet_drop';
        }

        // Actualizar el último corte en el historial
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
                startTimeStr: startDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Caracas' }),
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

        let returnMsg = "";
        if (eventType === 'fluctuation') {
            returnMsg = `⚡ <b>¡ENERGÍA / RED NORMALIZADA!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>\n` +
                        `⏰ <b>Hora de restablecimiento:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo fuera de línea:</b> ${durationFormatted}\n\n` +
                        `💡 <i>Fue un <b>micro-corte eléctrico</b> (bajón de voltaje) o una micro-caída de internet en tu casa.</i>\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        } else if (eventType === 'internet_drop') {
            returnMsg = `🌐 <b>¡SERVICIO DE INTERNET RESTABLECIDO!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>\n` +
                        `⏰ <b>Hora de reconexión:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo sin conexión:</b> ${durationFormatted}\n\n` +
                        `💡 <i>Confirmado: **En tu casa SÍ hubo luz todo el tiempo**. La falla fue exclusivamente de tu **proveedor de internet (CANTV/Fibra)**.</i>\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        } else {
            returnMsg = `⚡ <b>¡VOLVIÓ LA LUZ!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>\n` +
                        `⏰ <b>Hora de regreso:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo que duró el corte:</b> ${durationFormatted}\n\n` +
                        `La energía eléctrica ha regresado a tu casa.\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        }

        if (targetChatId) {
            console.log(`[NOTIF REGRESO] Enviando aviso a Telegram para ${deviceId} a chatId ${targetChatId}`);
            await sendTelegramMessage(targetChatId, returnMsg);
        }
    }

    const devData = {
        deviceId: deviceId,
        alias: existing.alias || deviceAlias,
        lastSeen: now,
        onlineSince: onlineSince,
        chatId: targetChatId,
        blackoutNotified: false, // Resetear bandera al volver la luz
        blackoutStartTime: null,
        history: history,
        resetRequested: false,
        unlinked: false, // El dispositivo ya está vinculado y reportando
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0',
        updatedAt: new Date(now).toISOString()
    };

    global.devices[deviceId] = devData;
    persistDevice(deviceId, devData);

    console.log(`[PING] Dispositivo ${deviceId} activo.`);

    await checkBlackoutAlerts();

    return res.json({ 
        success: true, 
        message: 'Ping recibido', 
        deviceId, 
        lastSeen: now, 
        onlineSince,
        action: shouldReset ? 'RESET_WIFI' : 'NONE'
    });
});

// 2. ENDPOINT WEBHOOK CON RESPUESTA DIRECTA ULTRA-RÁPIDA (POST /api/telegram-webhook)
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        loadFromDisk();
        const update = req.body;
        let chatId = null;
        let text = "";
        let senderName = "Usuario";

        if (update && update.callback_query) {
            chatId = (update.callback_query.message.chat.id || '').toString();
            text = (update.callback_query.data || '').toLowerCase().trim();
            senderName = update.callback_query.from ? (update.callback_query.from.first_name || 'Usuario') : 'Usuario';
        } else if (update && update.message && update.message.chat) {
            chatId = (update.message.chat.id || '').toString();
            text = (update.message.text || '').toLowerCase().trim();
            senderName = update.message.from ? (update.message.from.first_name || 'Usuario') : 'Usuario';
        }

        if (!chatId) {
            return res.status(200).send('OK');
        }

        global.lastInteractedChatId = chatId;

        // Ejecutar chequeo de alertas en segundo plano para no bloquear la velocidad de respuesta al usuario
        checkBlackoutAlerts().catch(e => console.error('Error background checkBlackoutAlerts:', e));

        let replyMsg = "";

        if (text.includes('/clima') || text.includes('clima') || text.includes('tiempo')) {
            const allDevs = Object.values({ ...global.persistentStore, ...global.devices }).sort((a, b) => b.lastSeen - a.lastSeen);
            const userDev = allDevs.find(d => String(d.chatId).trim() === String(chatId).trim()) || (allDevs.length > 0 ? allDevs[0] : null);

            const cityName = "Maracay, Aragua";
            const temp = 26;
            const weatherText = "⛅ Parcialmente Nublado";
            const wind = 10;

            const now = Date.now();
            const isOnline = userDev ? ((now - userDev.lastSeen) < 80000) : false;
            const devId = userDev ? userDev.deviceId : (allDevs.length > 0 ? allDevs[0].deviceId : 'ESP-DISPOSITIVO');

            replyMsg = `🌤️ <b>ESTADO DEL CLIMA EN VIVO</b>\n\n` +
                       `📍 <b>Ubicación:</b> ${cityName}\n` +
                       `🌡️ <b>Temperatura:</b> ${temp} °C\n` +
                       `☁️ <b>Estado del cielo:</b> ${weatherText}\n` +
                       `💨 <b>Viento:</b> ${wind} km/h\n\n` +
                       `⚡ <b>Estado Eléctrico:</b> ${isOnline ? 'HAY LUZ 🟢' : 'SE FUE LA LUZ 🔴'}\n\n` +
                       `💡 <i>Puedes consultar otra ciudad escribiendo por ejemplo: <b>/clima valencia</b></i>`;
        } else if (text.includes('/reiniciar')) {
            const allDevs = Object.values({ ...global.persistentStore, ...global.devices });
            const userDev = allDevs.find(d => String(d.chatId).trim() === String(chatId).trim()) || (allDevs.length > 0 ? allDevs[0] : null);
            if (userDev) {
                if (global.devices[userDev.deviceId]) global.devices[userDev.deviceId].resetRequested = true;
                if (global.persistentStore[userDev.deviceId]) global.persistentStore[userDev.deviceId].resetRequested = true;
                saveToDisk();
                replyMsg = `🔄 <b>Orden de reinicio enviada a:</b> <code>${userDev.deviceId}</code>\n\nLa placa se reiniciará en unos segundos.`;
            } else {
                replyMsg = `⚠️ <b>No encontré tu dispositivo vinculado.</b>\n\nAsegúrate de ingresar tu Chat ID (<code>${chatId}</code>) al configurar tu equipo.`;
            }
        } else if (text.startsWith('/pedirnombre_')) {
            const devId = text.replace('/pedirnombre_', '').toUpperCase().trim();
            const targetDev = getDevice(devId) || { deviceId: devId };
            const currentName = targetDev ? (targetDev.alias || devId) : devId;

            // Guardar estado de renombrado pendiente para este usuario
            global.pendingRenameForChat = global.pendingRenameForChat || {};
            global.pendingRenameForChat[chatId] = devId;

            replyMsg = `✏️ <b>Cambiando nombre a:</b> <code>${currentName}</code> (<code>${devId}</code>)\n\n` +
                       `👉 <b>Escribe a continuación el nuevo nombre que deseas asignarle</b> (Ejemplo: <i>Casa Maracay</i> o <i>Apartamento</i>):`;
            await sendTelegramMessage(chatId, replyMsg, []);
            return res.status(200).send('OK');
        } else if (text.startsWith('/estado_')) {
            const devId = text.replace('/estado_', '').toUpperCase().trim();
            const userDev = getDevice(devId);
            if (!userDev) {
                replyMsg = `⚠️ <b>Dispositivo no encontrado:</b> <code>${devId}</code>`;
            } else {
                const now = Date.now();
                const elapsedMs = now - userDev.lastSeen;
                const isOnline = elapsedMs < 240000;
                const devName = userDev.alias || userDev.deviceId;

                if (isOnline) {
                    const uptimeMs = now - (userDev.onlineSince || userDev.lastSeen);
                    const hours = Math.floor(uptimeMs / 3600000);
                    const mins = Math.floor((uptimeMs % 3600000) / 60000);
                    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

                    replyMsg = `🟢 <b>ESTADO EN VIVO: HAY LUZ ⚡</b>\n\n` +
                               `📍 <b>Ubicación:</b> <code>${devName}</code>\n` +
                               `📱 <b>ID:</b> <code>${userDev.deviceId}</code>\n` +
                               `⏱️ <b>Tiempo continuo con luz:</b> ${uptimeStr}\n` +
                               `📡 <b>Último reporte:</b> Hace ${Math.floor(elapsedMs / 1000)} segundos\n\n` +
                               `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${userDev.deviceId}`;
                } else {
                    const elapsedMins = Math.floor(elapsedMs / 60000);
                    const lastSeenDate = new Date(userDev.lastSeen);
                    const lastSeenTime = lastSeenDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });
                    const lastSeenDateStr = lastSeenDate.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });

                    let tiempoSinLuz = elapsedMins < 60 ? `${elapsedMins} min` : `${Math.floor(elapsedMins / 60)}h y ${elapsedMins % 60}m`;

                    replyMsg = `🔴 <b>ESTADO EN VIVO: SE FUE LA LUZ 🔌</b>\n\n` +
                               `📍 <b>Ubicación:</b> <code>${devName}</code>\n` +
                               `📱 <b>ID:</b> <code>${userDev.deviceId}</code>\n` +
                               `🕐 <b>Último reporte:</b> ${lastSeenTime} (${lastSeenDateStr})\n` +
                               `⏱️ <b>Tiempo sin luz:</b> ${tiempoSinLuz}\n\n` +
                               `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${userDev.deviceId}`;
                }
            }
            await sendTelegramMessage(chatId, replyMsg, [
                [{ text: "🏠 Mis Casas / Monitores", callback_data: "/casas" }],
                [{ text: "📜 Ver Historial", callback_data: "/historial" }]
            ]);
            return res.status(200).send('OK');
        } else if (text.includes('/nombre') || text.includes('nombre') || text.includes('/renombrar') || text.includes('renombrar') || text.includes('asignar')) {
            const combinedDevs = Object.values({ ...global.persistentStore, ...global.devices });
            let allDevs = combinedDevs.filter(d => String(d.chatId).trim() === String(chatId).trim());
            if (allDevs.length === 0 && combinedDevs.length > 0) {
                allDevs = [combinedDevs[0]];
            }
            const parts = text.split(' ').filter(p => p.trim().length > 0);

            // Si el usuario escribió directamente: /nombre ESP-51A1B1 Casa Caracas o /nombre Casa Caracas
            if (parts.length >= 2 && !text.includes('/renombrar')) {
                let targetDev = null;
                let newName = "";

                if (parts.length >= 3 && allDevs.some(d => d.deviceId.toUpperCase() === parts[1].toUpperCase())) {
                    targetDev = allDevs.find(d => d.deviceId.toUpperCase() === parts[1].toUpperCase());
                    newName = parts.slice(2).join(' ').trim();
                } else if (allDevs.length > 0) {
                    targetDev = allDevs[0];
                    newName = parts.slice(1).join(' ').trim();
                }

                if (targetDev && newName) {
                    targetDev.alias = newName;
                    persistDevice(targetDev.deviceId, targetDev);
                    const msgOk = `✅ <b>¡Nombre asignado con éxito!</b>\n\n📍 <b>${newName}</b> (<code>${targetDev.deviceId}</code>)\n\nAhora todas las alertas e informes saldrán identificados con este nombre.`;
                    await sendTelegramMessage(chatId, msgOk, [
                        [{ text: "📊 Ver Estado en Vivo", callback_data: `/estado_${targetDev.deviceId}` }],
                        [{ text: "🏠 Ver Mis Monitores", callback_data: "/casas" }]
                    ]);
                    return res.status(200).send('OK');
                }
            }

            // Si el usuario tocó "Asignar o Renombrar Casas": Mostrar lista interactiva pura
            if (allDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ <b>No tienes dispositivos vinculados a tu Chat ID (<code>${chatId}</code>).</b>`, []);
                return res.status(200).send('OK');
            } else {
                let listText = `🏷️ <b>¿A cuál de tus monitores deseas cambiarle el nombre?</b>\n\n`;
                const buttons = [];
                allDevs.forEach(dev => {
                    const currentName = dev.alias || dev.deviceId;
                    listText += `• <b>${currentName}</b> (<code>${dev.deviceId}</code>)\n`;
                    buttons.push([{ text: `✏️ Renombrar ${currentName}`, callback_data: `/pedirnombre_${dev.deviceId}` }]);
                });
                await sendTelegramMessage(chatId, listText, buttons);
                return res.status(200).send('OK');
            }
        } else if (text.includes('/dispositivos') || text.includes('/casas') || text.includes('mis casas') || text.includes('monitores')) {
            const allDevs = Object.values({ ...global.persistentStore, ...global.devices }).filter(d => String(d.chatId).trim() === String(chatId).trim());
            if (allDevs.length === 0) {
                replyMsg = `⚠️ <b>No tienes dispositivos vinculados a tu Chat ID (<code>${chatId}</code>).</b>`;
            } else {
                let listText = `🏠 <b>TUS MONITORES VINCULADOS (${allDevs.length}):</b>\n\n`;
                const buttons = [];
                allDevs.forEach((dev) => {
                    const isOnline = (Date.now() - dev.lastSeen) < 240000;
                    const statusIcon = isOnline ? "🟢 HAY LUZ" : "🔴 SIN LUZ";
                    const name = dev.alias || dev.deviceId;
                    listText += `• <b>${name}</b> (<code>${dev.deviceId}</code>): ${statusIcon}\n`;
                    buttons.push([{ text: `📍 Consultar ${name}`, callback_data: `/estado_${dev.deviceId}` }]);
                });
                buttons.push([{ text: "✏️ Cambiar Nombre a un Monitor", callback_data: "/renombrar" }]);
                await sendTelegramMessage(chatId, listText, buttons);
                return res.status(200).send('OK');
            }
        } else if (text.includes('/estado') || text.includes('estado')) {
            const now = Date.now();
            const allDevs = Object.values({ ...global.persistentStore, ...global.devices }).filter(d => String(d.chatId).trim() === String(chatId).trim());

            if (allDevs.length === 0) {
                replyMsg = `⚠️ <b>Dispositivo no vinculado aún.</b>\n\nTu número de Chat ID es <code>${chatId}</code>.\nAsegúrate de ingresarlo al configurar tu placa.`;
            } else if (allDevs.length > 1) {
                // Si tiene 2 o más placas, abrir menú selector interactivo
                let listText = `🏠 <b>Tienes ${allDevs.length} monitores vinculados.</b>\n\n¿Cuál de tus casas deseas consultar en vivo?`;
                const buttons = allDevs.map(dev => {
                    const isOnline = (now - dev.lastSeen) < 240000;
                    const icon = isOnline ? "🟢" : "🔴";
                    const name = dev.alias || dev.deviceId;
                    return [{ text: `${icon} ${name}`, callback_data: `/estado_${dev.deviceId}` }];
                });
                await sendTelegramMessage(chatId, listText, buttons);
                return res.status(200).send('OK');
            } else {
                // Si tiene 1 sola placa, mostrar directo su estado
                const userDev = allDevs[0];
                const elapsedMs = now - userDev.lastSeen;
                const isOnline = elapsedMs < 240000;
                const devName = userDev.alias || userDev.deviceId;

                if (isOnline) {
                    const uptimeMs = now - (userDev.onlineSince || userDev.lastSeen);
                    const hours = Math.floor(uptimeMs / 3600000);
                    const mins = Math.floor((uptimeMs % 3600000) / 60000);
                    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

                    replyMsg = `🟢 <b>ESTADO EN VIVO: HAY LUZ ⚡</b>\n\n` +
                               `📍 <b>Ubicación:</b> <code>${devName}</code>\n` +
                               `📱 <b>ID:</b> <code>${userDev.deviceId}</code>\n` +
                               `⏱️ <b>Tiempo continuo con luz:</b> ${uptimeStr}\n` +
                               `📡 <b>Último reporte:</b> Hace ${Math.floor(elapsedMs / 1000)} segundos\n\n` +
                               `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${userDev.deviceId}`;
                } else {
                    const elapsedMins = Math.floor(elapsedMs / 60000);
                    const lastSeenDate = new Date(userDev.lastSeen);
                    const lastSeenTime = lastSeenDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });
                    const lastSeenDateStr = lastSeenDate.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });

                    let tiempoSinLuz = elapsedMins < 60 ? `${elapsedMins} min` : `${Math.floor(elapsedMins / 60)}h y ${elapsedMins % 60}m`;

                    replyMsg = `🔴 <b>ESTADO EN VIVO: SE FUE LA LUZ 🔌</b>\n\n` +
                               `📍 <b>Ubicación:</b> <code>${devName}</code>\n` +
                               `📱 <b>ID:</b> <code>${userDev.deviceId}</code>\n` +
                               `🕐 <b>Último reporte:</b> ${lastSeenTime} (${lastSeenDateStr})\n` +
                               `⏱️ <b>Tiempo sin luz:</b> ${tiempoSinLuz}\n\n` +
                               `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${userDev.deviceId}`;
                }
            }
            await sendTelegramMessage(chatId, replyMsg, [
                [{ text: "🏠 Mis Casas / Monitores", callback_data: "/casas" }],
                [{ text: "📜 Ver Historial", callback_data: "/historial" }]
            ]);
            return res.status(200).send('OK');
        } else if (text.includes('/historial') || text.includes('historial') || text.includes('cortes') || text.includes('registro')) {
            const allDevs = Object.values({ ...global.persistentStore, ...global.devices }).sort((a, b) => b.lastSeen - a.lastSeen);
            const userDev = allDevs.find(d => String(d.chatId).trim() === String(chatId).trim()) || (allDevs.length > 0 ? allDevs[0] : null);

            if (!userDev) {
                replyMsg = `⚠️ <b>No encontré tu dispositivo vinculado.</b>\n\nAsegúrate de ingresar tu Chat ID (<code>${chatId}</code>) al configurar tu equipo.`;
            } else {
                const history = userDev.history || [];
                if (history.length === 0) {
                    replyMsg = `📜 <b>HISTORIAL DE CORTES ELÉCTRICOS</b>\n\n` +
                               `📱 <b>Dispositivo:</b> <code>${userDev.deviceId}</code>\n\n` +
                               `✨ <i>No hay registros de cortes de luz almacenados. ¡El servicio ha estado estable!</i>\n\n` +
                               `🔗 <b>Ver en Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${userDev.deviceId}`;
                } else {
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
                                           `   • <b>Inicio:</b> ${h.startTimeStr} (${h.startDateStr})\n` +
                                           `   • <b>Fin:</b> ${h.endTimeStr ? `${h.endTimeStr} (${h.endDateStr})` : '<i>En curso...</i>'}\n` +
                                           `   • <b>Duración:</b> <code>${h.durationStr}</code>\n\n`;
                    }

                    replyMsg = `📜 <b>HISTORIAL DE EVENTOS</b>\n\n` +
                               `📍 <b>Ubicación:</b> <code>${userDev.alias || userDev.deviceId}</code>\n` +
                               `📊 <b>Total de eventos registrados:</b> ${history.length}\n\n` +
                               historyListText +
                               `🔗 <b>Ver y gestionar en la Web:</b>\nhttps://monitor-luz-vercel-six.vercel.app/?id=${userDev.deviceId}`;
                }
            }
            await sendTelegramMessage(chatId, replyMsg, [
                [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                [{ text: "🏠 Mis Casas / Monitores", callback_data: "/casas" }]
            ]);
            return res.status(200).send('OK');
        } else if (text.includes('/reporte') || text.includes('reporte') || text.includes('/resumen') || text.includes('resumen') || text.includes('semanal')) {
            const allDevs = Object.values({ ...global.persistentStore, ...global.devices }).sort((a, b) => b.lastSeen - a.lastSeen);
            const userDev = allDevs.find(d => String(d.chatId).trim() === String(chatId).trim()) || (allDevs.length > 0 ? allDevs[0] : null);

            if (!userDev) {
                replyMsg = `⚠️ <b>No encontré tu dispositivo vinculado.</b>\n\nAsegúrate de ingresar tu Chat ID (<code>${chatId}</code>) al configurar tu equipo.`;
            } else {
                replyMsg = buildWeeklyReport(userDev);
            }
            await sendTelegramMessage(chatId, replyMsg, [
                [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                [{ text: "📜 Ver Historial", callback_data: "/historial" }]
            ]);
            return res.status(200).send('OK');
        } else if (text.includes('hola') || text.includes('/start') || text.includes('hello')) {
            const combinedDevs = Object.values({ ...global.persistentStore, ...global.devices });
            let allDevs = combinedDevs.filter(d => String(d.chatId).trim() === String(chatId).trim());
            if (allDevs.length === 0 && combinedDevs.length > 0) {
                allDevs = [combinedDevs[0]];
            }
            
            if (allDevs.length > 0) {
                const devName = allDevs[0].alias || allDevs[0].deviceId;
                const isOnline = (Date.now() - allDevs[0].lastSeen) < 240000;
                const statusStr = isOnline ? "🟢 HAY LUZ" : "🔴 SIN LUZ";

                const msg = `⚡ <b>¡Hola ${senderName}! Bienvenido a Monitor de Luz</b>\n\n` +
                            `Tu monitor <b>${devName}</b> está activo (${statusStr}).\n\n` +
                            `¿Qué deseas realizar?`;
                await sendTelegramMessage(chatId, msg, [
                    [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                    [{ text: "✏️ Asignar o Renombrar Casas", callback_data: "/renombrar" }],
                    [{ text: "🏠 Mis Casas / Monitores", callback_data: "/casas" }],
                    [{ text: "📈 Reporte Semanal", callback_data: "/reporte" }],
                    [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }]
                ]);
            } else {
                const msg1 = `⚡ <b>¡Hola ${senderName}! Tu Chat ID de Telegram es:</b>\n\n` +
                             `<code>${chatId}</code>\n\n` +
                             `<i>Utiliza este número al configurar la conexión WiFi de tu monitor.</i>`;
                await sendTelegramMessage(chatId, msg1, [
                    [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                    [{ text: "🏠 Mis Casas / Monitores", callback_data: "/casas" }]
                ]);
            }

            return res.status(200).send('OK');
        } else {
            // Si el usuario tenía seleccionado un monitor para renombrar:
            global.pendingRenameForChat = global.pendingRenameForChat || {};
            const targetDevId = global.pendingRenameForChat[chatId];
            if (targetDevId && text.trim().length > 0) {
                delete global.pendingRenameForChat[chatId];
                const targetDev = getDevice(targetDevId) || { deviceId: targetDevId };
                const newName = text.trim();
                targetDev.alias = newName;
                persistDevice(targetDevId, targetDev);

                const msgOk = `✅ <b>¡Nombre asignado con éxito!</b>\n\n📍 <b>${newName}</b> (<code>${targetDevId}</code>)\n\nAhora todas las alertas e informes saldrán identificados con este nombre.`;
                await sendTelegramMessage(chatId, msgOk, [
                    [{ text: "📊 Ver Estado en Vivo", callback_data: `/estado_${targetDevId}` }],
                    [{ text: "🏠 Ver Mis Monitores", callback_data: "/casas" }]
                ]);
                return res.status(200).send('OK');
            }

            if (replyMsg) {
                await sendTelegramMessage(chatId, replyMsg, [
                    [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                    [{ text: "🏠 Mis Casas / Monitores", callback_data: "/casas" }],
                    [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }]
                ]);
                return res.status(200).send('OK');
            }

            // Si escribe cualquier otra cosa no reconocida:
            const msgUnknown = `💡 <i>Escribe la palabra <b>hola</b> para recibir la bienvenida o conocer tu Chat ID, o utiliza los botones del menú de abajo:</i>`;
            await sendTelegramMessage(chatId, msgUnknown, [
                [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                [{ text: "✏️ Asignar o Renombrar Casas", callback_data: "/renombrar" }],
                [{ text: "🏠 Mis Casas / Monitores", callback_data: "/casas" }]
            ]);
            return res.status(200).send('OK');
        }
    } catch (e) {
        console.error('Error Webhook:', e);
        return res.status(200).send('OK');
    }
});

// 3. ENDPOINT PARA REGISTRAR ORDEN DE REINICIO REMOTO (POST /api/reset-wifi)
app.post('/api/reset-wifi', (req, res) => {
    loadFromDisk();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const device = getDevice(deviceId);

    if (!deviceId || !device) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    device.resetRequested = true;
    device.unlinked = true;
    persistDevice(deviceId, device);

    return res.json({ success: true, message: 'Orden de reinicio registrada.' });
});

// 3.1 ENDPOINT CUANDO EL DISPOSITIVO SE DESVINCULA (POST /api/device-unlinked)
app.post('/api/device-unlinked', (req, res) => {
    loadFromDisk();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const device = getDevice(deviceId);

    if (device) {
        device.unlinked = true;
        device.chatId = '';
        device.blackoutNotified = false;
        persistDevice(deviceId, device);
    }

    return res.json({ success: true, message: 'Dispositivo marcado como desvinculado.' });
});

// 4. ENDPOINT PARA BORRAR EL HISTORIAL DE UN DISPOSITIVO (POST /api/clear-history)
app.post('/api/clear-history', (req, res) => {
    loadFromDisk();
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const device = getDevice(deviceId);

    if (!deviceId || !device) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    device.history = [];
    persistDevice(deviceId, device);

    return res.json({ success: true, message: `Historial de ${deviceId} borrado exitosamente en la web y Telegram.` });
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

    for (const dev of Object.values(combined)) {
        if (!dev || !dev.deviceId) continue;
        let devChatId = (dev.chatId || '').toString().trim();
        if (devChatId === '3307499449') devChatId = '330749449';

        if (devChatId) {
            const reportMsg = buildWeeklyReport(dev);
            if (reportMsg) {
                await sendTelegramMessage(devChatId, reportMsg);
                sentCount++;
            }
        }
    }

    return res.json({ success: true, message: `Reporte semanal enviado a ${sentCount} dispositivos.` });
});

// 6. ENDPOINT PARA OBTENER TODOS LOS DISPOSITIVOS (GET /api/devices)
app.get('/api/devices', (req, res) => {
    checkBlackoutAlerts();
    const combined = { ...global.persistentStore, ...global.devices };
    const list = Object.values(combined).sort((a, b) => b.lastSeen - a.lastSeen);
    return res.json(list);
});

// 7. ENDPOINT PARA CONSULTAR EL ESTADO E HISTORIAL (GET /api/status/:id)
app.get('/api/status/:id', async (req, res) => {
    await checkBlackoutAlerts();
    const deviceId = (req.params.id || '').toString().trim().toUpperCase();
    const device = getDevice(deviceId);

    if (!device) {
        return res.json({
            found: false,
            deviceId: deviceId,
            status: 'offline',
            message: 'SE FUE LA LUZ',
            history: []
        });
    }

    // Si el dispositivo fue reseteado o desvinculado
    if (device.unlinked) {
        return res.json({
            found: true,
            deviceId: deviceId,
            lastSeen: device.lastSeen,
            status: 'unlinked',
            message: 'DISPOSITIVO DESVINCULADO',
            history: device.history || []
        });
    }

    // Comprobar si este dispositivo específico está online (menos de 300s / 5 min desde el último reporte)
    const now = Date.now();
    const elapsedMs = now - device.lastSeen;
    const isOnline = elapsedMs < 300000;
    const uptimeMs = isOnline ? (now - (device.onlineSince || device.lastSeen)) : 0;

    // Disparo inmediato de alerta de corte si la web detecta que está offline y no se había notificado
    if (!isOnline && !device.blackoutNotified && device.chatId) {
        await checkBlackoutAlerts();
    }

    return res.json({
        found: true,
        deviceId: deviceId,
        alias: device.alias || deviceId,
        lastSeen: device.lastSeen,
        onlineSince: device.onlineSince || device.lastSeen,
        elapsedMs: elapsedMs,
        uptimeMs: uptimeMs,
        status: isOnline ? 'online' : 'offline',
        message: isOnline ? 'HAY LUZ' : 'SE FUE LA LUZ',
        history: device.history || []
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

module.exports = app;
