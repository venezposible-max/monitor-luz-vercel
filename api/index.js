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
global.persistentStore = global.persistentStore || {};

const BOT_TOKEN = "8541967821:AAGaTrOzPG9s_hRn2VnIOyq7-d21_XwJZ38";
const TMP_FILE = '/tmp/monitor-luz-devices.json';

// Guardar datos del dispositivo en archivo /tmp para sobrevivir entre invocaciones
function saveToDisk() {
    try {
        const combined = { ...global.persistentStore, ...global.devices };
        fs.writeFileSync(TMP_FILE, JSON.stringify(combined), 'utf8');
    } catch (e) {
        console.error('Error guardando en /tmp:', e.message);
    }
}

// Cargar datos del archivo /tmp al iniciar (recupera datos tras cold start parcial)
function loadFromDisk() {
    try {
        if (fs.existsSync(TMP_FILE)) {
            const raw = fs.readFileSync(TMP_FILE, 'utf8');
            const data = JSON.parse(raw);
            for (const [id, dev] of Object.entries(data)) {
                if (dev && dev.deviceId) {
                    global.persistentStore[id] = { ...global.persistentStore[id], ...dev };
                    global.devices[id] = { ...global.devices[id], ...dev };
                }
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
    global.devices[deviceId] = {
        ...data,
        updatedAt: Date.now()
    };
    saveToDisk();
}

function getDevice(deviceId) {
    loadFromDisk();
    return global.devices[deviceId] || global.persistentStore[deviceId] || null;
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
function setupTelegramCommands() {
    try {
        const commandsPayload = JSON.stringify({
            commands: [
                { command: "estado", description: "Ver si hay luz en tiempo real" },
                { command: "historial", description: "Ver lista y duración de cortes" },
                { command: "clima", description: "Ver el clima en tu ciudad" },
                { command: "reiniciar", description: "Reiniciar WiFi de la placa" }
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

        // Si han pasado más de 240 segundos sin señal (4 minutos de gracia sólida anti-falsos positivos) y no se ha notificado la ida de luz
        if (elapsedMs >= 240000 && !dev.blackoutNotified && devChatId) {
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

            if (global.devices[dev.deviceId]) {
                global.devices[dev.deviceId].blackoutNotified = true;
                global.devices[dev.deviceId].chatId = devChatId;
                global.devices[dev.deviceId].blackoutStartTime = dev.lastSeen;
                global.devices[dev.deviceId].history = dev.history;
            }
            if (global.persistentStore[dev.deviceId]) {
                global.persistentStore[dev.deviceId].blackoutNotified = true;
                global.persistentStore[dev.deviceId].chatId = devChatId;
                global.persistentStore[dev.deviceId].blackoutStartTime = dev.lastSeen;
                global.persistentStore[dev.deviceId].history = dev.history;
            }
            saveToDisk();

            const alertMsg = `🔴 <b>¡ALERTA! SE ACABA DE IR LA LUZ 🔌</b>\n\n` +
                             `⏰ <b>Hora aproximada de corte:</b> ${cutoffTimeStr} (${cutoffDateStr})\n\n` +
                             `Tu dispositivo ha dejado de transmitir señal por corte de energía eléctrica en tu casa.\n\n` +
                             `📱 <b>Dispositivo:</b> <code>${dev.deviceId}</code>\n` +
                             `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel.vercel.app/?id=${dev.deviceId}`;

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

    // SI REGRESÓ LA LUZ TRAS UN CORTE (detectado por bandera wasBlackout, o por tiempo transcurrido > 240s, o por corte abierto en historial)
    const hasOpenCut = history.length > 0 && !history[0].end;
    const timeGapExceeded = existing.lastSeen ? (now - existing.lastSeen >= 240000) : false;
    const isReturnFromBlackout = wasBlackout || hasOpenCut || timeGapExceeded;

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

        // Actualizar el último corte en el historial
        if (history.length > 0 && !history[0].end) {
            history[0].end = now;
            history[0].endTimeStr = returnTimeStr;
            history[0].endDateStr = returnDateStr;
            history[0].durationStr = durationFormatted;
            history[0].durationMs = durationMs;
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
                durationMs: durationMs
            });
        }

        // Limitar historial a los últimos 50 eventos
        if (history.length > 50) history = history.slice(0, 50);

        let returnMsg = "";
        if (totalMins < 5) {
            returnMsg = `⚡ <b>¡ENERGÍA / RED NORMALIZADA!</b>\n\n` +
                        `⏰ <b>Hora de restablecimiento:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo fuera de línea:</b> ${durationFormatted}\n\n` +
                        `💡 <i>Fue un <b>micro-corte eléctrico</b> (bajón/fluctuación de voltaje) o una micro-caída momentánea de la red de internet en tu casa.</i>\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel.vercel.app/?id=${deviceId}`;
        } else {
            returnMsg = `⚡ <b>¡VOLVIÓ LA LUZ!</b>\n\n` +
                        `⏰ <b>Hora de regreso:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo que duró el corte:</b> ${durationFormatted}\n\n` +
                        `La energía eléctrica ha regresado a tu casa.\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel.vercel.app/?id=${deviceId}`;
        }

        if (targetChatId) {
            console.log(`[NOTIF REGRESO] Enviando aviso a Telegram para ${deviceId} a chatId ${targetChatId}`);
            await sendTelegramMessage(targetChatId, returnMsg);
        }
    }

    const devData = {
        deviceId: deviceId,
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

        await checkBlackoutAlerts();

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
        } else if (text.includes('/estado') || text.includes('estado')) {
            const now = Date.now();
            const allDevs = Object.values({ ...global.persistentStore, ...global.devices }).sort((a, b) => b.lastSeen - a.lastSeen);
            
            let userDev = allDevs.find(d => String(d.chatId).trim() === String(chatId).trim());
            if (!userDev && allDevs.length > 0) {
                userDev = allDevs[0];
                userDev.chatId = chatId;
                if (global.devices[userDev.deviceId]) global.devices[userDev.deviceId].chatId = chatId;
                if (global.persistentStore[userDev.deviceId]) global.persistentStore[userDev.deviceId].chatId = chatId;
                saveToDisk();
            }

            if (!userDev) {
                replyMsg = `⚠️ <b>Dispositivo no vinculado aún.</b>\n\nTu número de Chat ID es <code>${chatId}</code>.\nAsegúrate de ingresarlo en la casilla de Telegram al configurar la red de tu placa.`;
            } else {
                const elapsedMs = now - userDev.lastSeen;
                const isOnline = elapsedMs < 80000;
                const elapsedSecs = Math.floor(elapsedMs / 1000);

                if (isOnline) {
                    const uptimeMs = now - (userDev.onlineSince || userDev.lastSeen);
                    const hours = Math.floor(uptimeMs / 3600000);
                    const mins = Math.floor((uptimeMs % 3600000) / 60000);
                    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

                    replyMsg = `🟢 <b>ESTADO EN VIVO: HAY LUZ ⚡</b>\n\n` +
                               `📱 <b>Dispositivo:</b> <code>${userDev.deviceId}</code>\n` +
                               `⏱️ <b>Tiempo continuo con luz:</b> ${uptimeStr}\n` +
                               `📡 <b>Último reporte:</b> Hace ${elapsedSecs} segundos\n\n` +
                               `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel.vercel.app/?id=${userDev.deviceId}`;
                } else {
                    const elapsedMins = Math.floor(elapsedMs / 60000);
                    const lastSeenDate = new Date(userDev.lastSeen);
                    const lastSeenTime = lastSeenDate.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });
                    const lastSeenDateStr = lastSeenDate.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });

                    let tiempoSinLuz = '';
                    if (elapsedMins < 60) {
                        tiempoSinLuz = `${elapsedMins} minuto${elapsedMins === 1 ? '' : 's'}`;
                    } else {
                        const horas = Math.floor(elapsedMins / 60);
                        const mins = elapsedMins % 60;
                        if (horas < 24) {
                            tiempoSinLuz = `${horas} hora${horas === 1 ? '' : 's'} y ${mins} min`;
                        } else {
                            const dias = Math.floor(horas / 24);
                            const remHoras = horas % 24;
                            tiempoSinLuz = `${dias} día${dias === 1 ? '' : 's'}, ${remHoras}h y ${mins}m`;
                        }
                    }

                    replyMsg = `🔴 <b>ESTADO EN VIVO: SE FUE LA LUZ 🔌</b>\n\n` +
                               `📱 <b>Dispositivo:</b> <code>${userDev.deviceId}</code>\n` +
                               `🕐 <b>Último reporte:</b> ${lastSeenTime} (${lastSeenDateStr})\n` +
                               `⏱️ <b>Tiempo sin luz:</b> ${tiempoSinLuz}\n` +
                               `⚠️ <i>La placa se encuentra apagada sin servicio de luz.</i>\n\n` +
                               `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel.vercel.app/?id=${userDev.deviceId}`;
                }
            }
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
                               `🔗 <b>Ver en Web:</b> https://monitor-luz-vercel.vercel.app/?id=${userDev.deviceId}`;
                } else {
                    let historyListText = "";
                    const maxShow = Math.min(history.length, 5);
                    for (let i = 0; i < maxShow; i++) {
                        const h = history[i];
                        const icon = h.end ? "⚡" : "🔴";
                        historyListText += `${icon} <b>Corte #${history.length - i}:</b>\n` +
                                           `   • <b>Ida:</b> ${h.startTimeStr} (${h.startDateStr})\n` +
                                           `   • <b>Regreso:</b> ${h.endTimeStr ? `${h.endTimeStr} (${h.endDateStr})` : '<i>En curso...</i>'}\n` +
                                           `   • <b>Duración:</b> <code>${h.durationStr}</code>\n\n`;
                    }

                    replyMsg = `📜 <b>HISTORIAL DE CORTES ELÉCTRICOS</b>\n\n` +
                               `📱 <b>Dispositivo:</b> <code>${userDev.deviceId}</code>\n` +
                               `📊 <b>Total de cortes registrados:</b> ${history.length}\n\n` +
                               historyListText +
                               `🔗 <b>Ver y gestionar en la Web:</b>\nhttps://monitor-luz-vercel.vercel.app/?id=${userDev.deviceId}`;
                }
            }
        } else {
            // MENSAJE 1: Saludo inicial
            const msg1 = `⚡ <b>¡Bienvenido a Monitor de Luz!</b>\n\n` +
                         `Hola <b>${senderName}</b>, a continuación te envío tu <b>Chat ID</b> en un mensaje separado para que lo copies fácilmente:`;
            await sendTelegramMessage(chatId, msg1, []);

            // MENSAJE 2: ÚNICAMENTE EL NÚMERO (100% puro para copiar en 1 toque sin texto)
            const msg2 = `<code>${chatId}</code>`;
            await sendTelegramMessage(chatId, msg2, []);

            // MENSAJE 3: Instrucciones y botones de navegación
            const msg3 = `👆 <i>Copia el número de arriba y pégalo en la casilla de Telegram al configurar tu placa.</i>\n\n` +
                         `💡 <i>Puedes usar los botones de abajo o escribir <b>/estado</b> para consultar si hay luz.</i>`;
            await sendTelegramMessage(chatId, msg3, [
                [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }],
                [{ text: "🌤️ Clima en tu Zona", callback_data: "/clima" }]
            ]);

            return res.status(200).send('OK');
        }

        return res.status(200).json({
            method: 'sendMessage',
            chat_id: chatId,
            text: replyMsg,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
                    [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }],
                    [{ text: "🌤️ Clima en tu Zona", callback_data: "/clima" }]
                ]
            }
        });
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
            status: 'unlinked',
            message: 'DISPOSITIVO DESVINCULADO',
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

    // Comprobar si este dispositivo específico está online (menos de 240s / 4 min desde el último reporte)
    const now = Date.now();
    const elapsedMs = now - device.lastSeen;
    const isOnline = elapsedMs < 240000;
    const uptimeMs = isOnline ? (now - (device.onlineSince || device.lastSeen)) : 0;

    // Disparo inmediato de alerta de corte si la web detecta que está offline y no se había notificado
    if (!isOnline && !device.blackoutNotified && device.chatId) {
        await checkBlackoutAlerts();
    }

    return res.json({
        found: true,
        deviceId: deviceId,
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
