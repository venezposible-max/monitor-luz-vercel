const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Memoria compartida en la función serverless de Vercel
global.devices = global.devices || {};

// 1. ENDPOINT PARA RECIBIR PING DE LA PLACA ESP8266 (POST /api/ping)
app.post('/api/ping', (req, res) => {
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();
    const boardUptimeMs = parseInt(req.body.uptimeMs || 0, 10);

    if (!deviceId) {
        return res.status(400).json({ error: 'Falta el parámetro deviceId' });
    }

    const now = Date.now();
    const onlineSince = boardUptimeMs > 0 ? (now - boardUptimeMs) : now;

    const existing = global.devices[deviceId] || {};
    const shouldReset = existing.resetRequested || false;

    global.devices[deviceId] = {
        deviceId: deviceId,
        lastSeen: now,
        onlineSince: onlineSince,
        resetRequested: false,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0',
        updatedAt: new Date(now).toISOString()
    };

    console.log(`[PING] Dispositivo ${deviceId} activo en Vercel.`);
    return res.json({ 
        success: true, 
        message: 'Ping recibido correctamente', 
        deviceId, 
        lastSeen: now, 
        onlineSince,
        action: shouldReset ? 'RESET_WIFI' : 'NONE'
    });
});

// 2. ENDPOINT WEBHOOK PARA RESPONDER AUTOMÁTICAMENTE EL CHAT ID EN TELEGRAM
app.post('/api/telegram-webhook', (req, res) => {
    try {
        const update = req.body;
        if (update && update.message && update.message.chat) {
            const chatId = update.message.chat.id;
            const senderName = update.message.from ? (update.message.from.first_name || 'Usuario') : 'Usuario';
            const botToken = "8541967821:AAGaTrOzPG9s_hRn2VnIOyq7-d21_XwJZ38";

            const replyMsg = `⚡ <b>¡Bienvenido a Monitor de Luz!</b>\n\n` +
                             `Hola <b>${senderName}</b>, tu número de <b>Chat ID</b> para configurar tu equipo es:\n\n` +
                             `👉 <code>${chatId}</code>\n\n` +
                             `📱 <i>Copia este número y pégalo en la casilla de Telegram al configurar la red 'Configurar-Luz' de tu dispositivo.</i>`;

            const https = require('https');
            const payload = JSON.stringify({
                chat_id: chatId,
                text: replyMsg,
                parse_mode: 'HTML'
            });

            const options = {
                hostname: 'api.telegram.org',
                path: `/bot${botToken}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };

            const request = https.request(options);
            request.write(payload);
            request.end();
        }
    } catch (e) {
        console.error('Error Webhook:', e);
    }
    return res.status(200).send('OK');
});

// 3. ENDPOINT PARA REGISTRAR ORDEN DE REINICIO REMOTO (POST /api/reset-wifi)
app.post('/api/reset-wifi', (req, res) => {
    const deviceId = (req.body.deviceId || req.body.id || '').toString().trim().toUpperCase();

    if (!deviceId || !global.devices[deviceId]) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    global.devices[deviceId].resetRequested = true;

    console.log(`[ORDEN] Solicitud de reinicio de WiFi registrada en Vercel para ${deviceId}`);
    return res.json({ success: true, message: 'Orden de reinicio registrada.' });
});

// 3. ENDPOINT PARA OBTENER TODOS LOS DISPOSITIVOS (GET /api/devices)
app.get('/api/devices', (req, res) => {
    const list = Object.values(global.devices).sort((a, b) => b.lastSeen - a.lastSeen);
    return res.json(list);
});

// 4. ENDPOINT PARA CONSULTAR EL ESTADO (GET /api/status/:id)
app.get('/api/status/:id', (req, res) => {
    const deviceId = (req.params.id || '').toString().trim().toUpperCase();
    const device = global.devices[deviceId];

    if (!device) {
        return res.json({
            found: false,
            deviceId: deviceId,
            status: 'unknown',
            message: 'El dispositivo no ha registrado ningún reporte todavía.'
        });
    }

    const now = Date.now();
    const elapsedMs = now - device.lastSeen;
    const isOnline = elapsedMs < 80000; // Menos de 80 segundos
    const uptimeMs = isOnline ? (now - (device.onlineSince || device.lastSeen)) : 0;

    return res.json({
        found: true,
        deviceId: deviceId,
        lastSeen: device.lastSeen,
        onlineSince: device.onlineSince || device.lastSeen,
        elapsedMs: elapsedMs,
        uptimeMs: uptimeMs,
        status: isOnline ? 'online' : 'offline',
        message: isOnline ? 'HAY LUZ' : 'SE FUE LA LUZ'
    });
});

module.exports = app;
