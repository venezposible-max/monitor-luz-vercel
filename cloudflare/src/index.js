/**
 * PowerWatch Cloudflare Worker
 * Alta Escala a Costo $0.00 con Cloudflare D1 (SQLite)
 */

const BOT_TOKEN = "8541967821:AAGaTrOzPG9s_hRn2VnIOyq7-d21_XwJZ38";
const OFFLINE_THRESHOLD_MS = 300000; // 5 minutos (300 segundos)

// --- HELPERS TELEGRAM ---

async function sendTelegramMessage(chatId, text, customButtons = null) {
    if (!chatId) return { success: false, messageId: null };
    try {
        const buttons = customButtons || [
            [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
            [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }]
        ];
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: String(chatId).trim(),
                text: text,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            })
        });
        const data = await res.json();
        return { success: data.ok, messageId: data.result?.message_id || null };
    } catch (e) {
        return { success: false, messageId: null };
    }
}

async function answerCallbackQuery(callbackQueryId) {
    if (!callbackQueryId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId })
        });
    } catch (e) {}
}

async function deleteTelegramMessage(chatId, messageId) {
    if (!chatId || !messageId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId).trim(), message_id: messageId })
        });
    } catch (e) {}
}

// --- HELPERS FECHA Y HORA (Venezuela America/Caracas) ---

function formatVETime(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });
}

function formatVEDate(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });
}

function formatDuration(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins <= 1) return "1 min";
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
}

function getWebUrl(devId, chatId = '') {
    const cid = String(chatId || '').trim();
    const cidParam = cid ? `&chatId=${encodeURIComponent(cid)}` : '';
    return `https://monitor-luz-vercel-six.vercel.app/?id=${devId}${cidParam}`;
}

// --- D1 DATABASE OPERATIONS ---

async function getDeviceFull(db, deviceId) {
    const devId = String(deviceId || '').toUpperCase().trim();
    if (!devId) return null;

    const dev = await db.prepare("SELECT * FROM devices WHERE device_id = ?").bind(devId).first();
    if (!dev) return null;

    const guestsRows = await db.prepare("SELECT guest_chat_id, guest_name FROM guests WHERE device_id = ?").bind(devId).all();
    const guestChatIds = [];
    const guestNames = {};
    for (const g of (guestsRows.results || [])) {
        guestChatIds.push(String(g.guest_chat_id).trim());
        if (g.guest_name) guestNames[String(g.guest_chat_id).trim()] = g.guest_name;
    }

    const historyRows = await db.prepare("SELECT * FROM history WHERE device_id = ? ORDER BY start_time DESC LIMIT 30").bind(devId).all();
    const history = (historyRows.results || []).map(h => ({
        id: h.id,
        start: h.start_time,
        end: h.end_time,
        startTimeStr: h.start_time_str,
        endTimeStr: h.end_time_str,
        startDateStr: h.start_date_str,
        endDateStr: h.end_date_str,
        durationStr: h.duration_str,
        durationMs: h.duration_ms,
        type: h.event_type
    }));

    let lastAlertMessages = {};
    try { lastAlertMessages = JSON.parse(dev.last_alert_messages || '{}'); } catch(e) {}

    return {
        deviceId: dev.device_id,
        alias: dev.alias || dev.device_id,
        chatId: dev.chat_id || '',
        lastSeen: dev.last_seen || 0,
        onlineSince: dev.online_since || 0,
        blackoutNotified: Boolean(dev.blackout_notified),
        blackoutStartTime: dev.blackout_start_time || null,
        lastAlertMessageId: dev.last_alert_msg_id || null,
        lastAlertMessages: lastAlertMessages,
        ip: dev.ip || '',
        city: dev.city || '',
        region: dev.region || '',
        isp: dev.isp || '',
        unlinked: Boolean(dev.unlinked),
        resetRequested: Boolean(dev.reset_requested),
        updatedAt: dev.updated_at || 0,
        guestChatIds: guestChatIds,
        guestNames: guestNames,
        history: history
    };
}

async function getAllDevicesFull(db) {
    const devsRows = await db.prepare("SELECT * FROM devices").all();
    const all = [];
    for (const dev of (devsRows.results || [])) {
        const full = await getDeviceFull(db, dev.device_id);
        if (full) all.push(full);
    }
    return all;
}

// Helper: verificar titular
function checkIsOwner(dev, chatId, strict = false) {
    if (!dev) return !strict;
    let reqId = String(chatId || '').trim();
    let devOwnerId = String(dev.chatId || '').trim();
    if (reqId === '3307499449') reqId = '330749449';
    if (devOwnerId === '3307499449') devOwnerId = '330749449';

    const guests = (dev.guestChatIds || []).map(g => {
        let id = String(g).trim();
        return id === '3307499449' ? '330749449' : id;
    });

    if (reqId && guests.includes(reqId)) return false;
    if (reqId && devOwnerId && reqId === devOwnerId) return true;
    if (strict) return false;
    return !devOwnerId;
}

function getGuestName(dev, guestChatId) {
    const cid = String(guestChatId || '').trim();
    if (!cid || !dev) return null;
    return (dev.guestNames && dev.guestNames[cid]) || null;
}

// --- MENSAJES FORMATEADOS ---

function buildStatusMsg(dev, devId, targetChatId = '') {
    if (!dev) return `⚠️ <b>Dispositivo no encontrado:</b> <code>${devId || 'ESP-DESCONOCIDO'}</code>`;
    const now = Date.now();
    const lastSeen = dev.lastSeen || now;
    const elapsed = now - lastSeen;
    const online = elapsed < OFFLINE_THRESHOLD_MS;
    const name = dev.alias || dev.deviceId || devId;
    const activeDevId = dev.deviceId || devId;
    const webLink = getWebUrl(activeDevId, targetChatId || dev.chatId);

    const isOwner = checkIsOwner(dev, targetChatId);
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
        const t = formatDuration(elapsed);
        const ts = formatVETime(lastSeen);
        const ds = formatVEDate(lastSeen);
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
        if (dur >= 300000) longCutsCount++;
        else if (dur > 0) microCutsCount++;
        if (dur > longestCutMs) longestCutMs = dur;
    });

    const totalWeekMs = 7 * 24 * 60 * 60 * 1000;
    const blackoutHours = (totalBlackoutMs / 3600000).toFixed(1);
    const lightHours = ((totalWeekMs - totalBlackoutMs) / 3600000).toFixed(1);
    const stabilityPct = Math.max(0, Math.min(100, ((totalWeekMs - totalBlackoutMs) / totalWeekMs * 100).toFixed(1)));

    let diagnostic = "🌟 <b>Excelente:</b> Suministro eléctrico continuo sin cortes significativos.";
    if (stabilityPct < 80) diagnostic = "🚨 <b>Crítico:</b> Frecuencia severa de cortes eléctricos esta semana.";
    else if (stabilityPct < 95) diagnostic = "⚠️ <b>Inestable:</b> Se registraron varias interrupciones en el servicio.";

    const longestCutStr = formatDuration(longestCutMs);

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

// --- COMANDOS WEBHOOK TELEGRAM ---

async function handleTelegramWebhook(request, env) {
    try {
        const update = await request.json();
        if (!update) return new Response('OK', { status: 200 });

        let chatId = null;
        let text = '';
        let senderName = 'Usuario';
        let callbackQueryId = null;

        if (update.callback_query) {
            chatId = String(update.callback_query.message.chat.id || '');
            text = String(update.callback_query.data || '').toLowerCase().trim();
            senderName = (update.callback_query.from && update.callback_query.from.first_name) || 'Usuario';
            callbackQueryId = update.callback_query.id;
            await answerCallbackQuery(callbackQueryId);
        } else if (update.message && update.message.chat) {
            chatId = String(update.message.chat.id || '');
            text = String(update.message.text || '').toLowerCase().trim();
            senderName = (update.message.from && update.message.from.first_name) || 'Usuario';
        }

        if (!chatId) return new Response('OK', { status: 200 });
        if (chatId === '3307499449') chatId = '330749449';

        const cleanText = (update.message && update.message.text) ? update.message.text.trim() : text;
        const devs = await getAllDevicesFull(env.DB);

        // Funciones auxiliares dentro del webhook
        const getDevice = (id) => devs.find(d => d.deviceId.toUpperCase() === String(id || '').toUpperCase().trim());
        const getMyDevs = () => devs.filter(d => {
            const isOwner = checkIsOwner(d, chatId);
            const isGuest = (d.guestChatIds || []).includes(chatId);
            return isOwner || isGuest;
        });

        // Gestión de estados pendientes
        let pending = null;
        const pendingRow = await env.DB.prepare("SELECT state_json FROM pending_states WHERE chat_id = ?").bind(chatId).first();
        if (pendingRow) {
            try { pending = JSON.parse(pendingRow.state_json); } catch(e) {}
        }

        if (pending && cleanText.startsWith('/') && !cleanText.startsWith('/skip_guest_name_')) {
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();
            pending = null;
        }

        // 1. PENDIENTE: AGREGAR FAMILIAR
        if (pending && pending.action === 'ADD_GUEST_CHAT_ID' && /^\d+$/.test(cleanText)) {
            const devId = pending.devId;
            const guestChatId = cleanText;
            const existingDev = getDevice(devId);

            if (!checkIsOwner(existingDev, chatId, true)) {
                await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede agregar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            await env.DB.prepare("INSERT OR REPLACE INTO guests (device_id, guest_chat_id, guest_name) VALUES (?, ?, '')").bind(devId, guestChatId).run();
            await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

            const nextState = { action: 'SET_GUEST_NAME', devId: devId, guestChatId: guestChatId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(nextState), Date.now()).run();

            await sendTelegramMessage(chatId,
                `✅ <b>¡Chat ID registrado!</b> (<code>${guestChatId}</code>)\n\n` +
                `📍 <b>Monitor:</b> <b>${existingDev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `✏️ Ahora escribe el <b>Nombre o Parentesco</b> de esta persona (ej: <i>Pedro</i>, <i>Mamá</i>, <i>José</i>):`,
                [[{ text: '⏭️ Omitir / Guardar sin nombre', callback_data: `/skip_guest_name_${devId}_${guestChatId}` }]]
            );
            return new Response('OK', { status: 200 });
        }

        // 2. PENDIENTE: ASIGNAR NOMBRE FAMILIAR
        if (pending && (pending.action === 'SET_GUEST_NAME' || pending.action === 'RENAME_GUEST') && cleanText.length > 0 && !cleanText.startsWith('/')) {
            const devId = pending.devId;
            const guestChatId = pending.guestChatId;
            const guestName = cleanText.trim();
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();

            const existingDev = getDevice(devId);
            if (!checkIsOwner(existingDev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede gestionar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            await env.DB.prepare("INSERT OR REPLACE INTO guests (device_id, guest_chat_id, guest_name) VALUES (?, ?, ?)").bind(devId, guestChatId, guestName).run();
            await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

            await sendTelegramMessage(chatId,
                `🎉 <b>¡Familiar configurado con éxito!</b>\n\n` +
                `👤 <b>Nombre:</b> <b>${guestName}</b>\n` +
                `👥 <b>Chat ID:</b> <code>${guestChatId}</code>\n` +
                `📍 <b>Monitor:</b> <b>${existingDev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `Esta persona ahora recibirá alertas automáticas cada vez que se vaya o regrese la luz en este monitor.`,
                [
                    [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]
            );

            sendTelegramMessage(guestChatId,
                `👋 <b>¡Hola! Has sido agregado como familiar</b> al monitor <b>${existingDev.alias || devId}</b> por su propietario.\n\n` +
                `A partir de ahora recibirás alertas automáticas en este chat cada vez que se vaya o regrese la luz.`,
                [[{ text: '📊 Consultar Estado', callback_data: `/estado_${devId}` }]]
            ).catch(() => {});
            return new Response('OK', { status: 200 });
        }

        // 3. PENDIENTE: RENOMBRAR MONITOR
        if (pending && pending.action === 'RENAME_MONITOR' && cleanText.length > 0 && !cleanText.startsWith('/')) {
            const renameDevId = pending.devId;
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();

            const existingDev = getDevice(renameDevId);
            if (!checkIsOwner(existingDev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede renombrar este monitor.`, []);
                return new Response('OK', { status: 200 });
            }

            const newAlias = cleanText.trim();
            await env.DB.prepare("UPDATE devices SET alias = ?, updated_at = ? WHERE device_id = ?").bind(newAlias, Date.now(), renameDevId).run();

            await sendTelegramMessage(chatId,
                `✅ <b>¡Nombre actualizado con éxito!</b>\n\n📍 Ahora tu monitor <code>${renameDevId}</code> se llama: <b>${newAlias}</b>`,
                [
                    [{ text: "📊 Ver Estado en Vivo", callback_data: `/estado_${renameDevId}` }],
                    [{ text: "🏠 Mis Monitores", callback_data: "/casas" }]
                ]
            );
            return new Response('OK', { status: 200 });
        }

        // --- COMANDOS Y MENÚS TELEGRAM ---

        if (text.startsWith('/skip_guest_name_')) {
            const parts = text.replace('/skip_guest_name_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const guestChatId = (parts[1] || '').trim();
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();

            const dev = getDevice(devId);
            await sendTelegramMessage(chatId,
                `✅ <b>Familiar guardado (sin nombre asignado):</b>\n\n` +
                `👥 <b>Chat ID:</b> <code>${guestChatId}</code>\n` +
                `📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b>\n\n` +
                `Recibirá todas las alertas de luz normalmente. Puedes asignarle un nombre en cualquier momento desde /invitar.`,
                [
                    [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]
            );

        } else if (text.startsWith('/pedirinvitado_')) {
            const devId = text.replace('/pedirinvitado_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede agregar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            const state = { action: 'ADD_GUEST_CHAT_ID', devId: devId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();

            await sendTelegramMessage(chatId,
                `👥 <b>AGREGAR FAMILIAR / INVITADO</b>\n\n` +
                `📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `👉 Por favor, <b>escribe o pega el Chat ID de Telegram</b> de la persona que deseas agregar.\n\n` +
                `💡 <i>(Dile a tu familiar que le hable a este bot y pulse /chatid para saber su número)</i>:`,
                [[{ text: '❌ Cancelar', callback_data: '/invitar' }]]
            );

        } else if (text.startsWith('/quitarinvitado_')) {
            const devId = text.replace('/quitarinvitado_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede gestionar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            const guests = dev?.guestChatIds || [];
            if (guests.length === 0) {
                await sendTelegramMessage(chatId, `ℹ️ El monitor <b>${dev?.alias || devId}</b> no tiene familiares registrados.`, []);
                return new Response('OK', { status: 200 });
            }

            let listMsg = `❌ <b>ELIMINAR FAMILIAR</b>\n\n📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b>\n\nSelecciona el familiar que deseas eliminar:`;
            const buttons = guests.map(gId => {
                const gName = getGuestName(dev, gId) || `Chat ID ${gId}`;
                return [{ text: `🗑️ Eliminar ${gName}`, callback_data: `/delguest_${devId}_${gId}` }];
            });
            if (guests.length > 1) {
                buttons.push([{ text: `🚨 Eliminar TODOS los Familiares`, callback_data: `/delallguests_${devId}` }]);
            }
            buttons.push([{ text: `🔙 Volver`, callback_data: '/invitar' }]);
            await sendTelegramMessage(chatId, listMsg, buttons);

        } else if (text.startsWith('/delguest_')) {
            const parts = text.replace('/delguest_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const targetGuestId = (parts[1] || '').trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede eliminar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            if (dev && targetGuestId) {
                const gName = getGuestName(dev, targetGuestId) || 'Familiar';
                await env.DB.prepare("DELETE FROM guests WHERE device_id = ? AND guest_chat_id = ?").bind(devId, targetGuestId).run();
                await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

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

                sendTelegramMessage(targetGuestId,
                    `ℹ️ <b>Notificación:</b> Has sido removido como familiar del monitor <b>${dev.alias || devId}</b>.`,
                    []
                ).catch(() => {});
            }

        } else if (text.startsWith('/delallguests_')) {
            const devId = text.replace('/delallguests_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede eliminar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            if (dev) {
                const prevCount = (dev.guestChatIds || []).length;
                await env.DB.prepare("DELETE FROM guests WHERE device_id = ?").bind(devId).run();
                await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

                await sendTelegramMessage(chatId,
                    `✅ <b>Todos los familiares de <code>${dev.alias || devId}</code> han sido eliminados.</b>\n\n` +
                    `Se eliminaron ${prevCount} familiar(es) registrado(s).`,
                    [
                        [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                    ]
                );
            }

        } else if (text.startsWith('/pedirnombre_')) {
            const devId = text.replace('/pedirnombre_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede renombrar este monitor.`, []);
                return new Response('OK', { status: 200 });
            }

            const state = { action: 'RENAME_MONITOR', devId: devId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();

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
                await sendTelegramMessage(chatId, `⚠️ <b>Dispositivo no vinculado.</b>\n\nTu Chat ID: <code>${chatId}</code>. Ingrésalo al configurar la placa.`, []);
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
                        btns.push([{ text: `❌ Quitar Familiar en ${devName}`, callback_data: `/quitarinvitado_${d.deviceId}` }]);
                    }
                });
                btns.push([{ text: '🏠 Mis Monitores', callback_data: '/casas' }]);
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.startsWith('/confirm_reset_step1_')) {
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
            const devId = text.replace('/confirm_reset_final_', '').toUpperCase().trim();
            const myDev = devs.find(d => checkIsOwner(d, chatId, true) && d.deviceId.toUpperCase() === devId);
            if (!myDev) {
                await sendTelegramMessage(chatId, `⚠️ <b>Acceso Denegado.</b> Solo el administrador propietario puede reiniciar la placa.`, []);
            } else {
                await env.DB.prepare("UPDATE devices SET reset_requested = 1, updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();
                await sendTelegramMessage(chatId,
                    `✅ <b>¡Orden de reinicio enviada a la placa!</b>\n\n` +
                    `📱 <b>Dispositivo:</b> <code>${myDev.deviceId}</code>\n\n` +
                    `En su próximo reporte (máximo 60 segundos), la placa borrará su memoria WiFi y activará la red <code>Configurar-Luz</code>.`,
                    [[{ text: "📊 Ver Estado", callback_data: `/estado_${myDev.deviceId}` }]]
                );
            }

        } else if (text.includes('/reiniciar') || text.includes('reiniciar')) {
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

        } else {
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
        }

    } catch (e) {
        console.error('[WEBHOOK ERROR]:', e.message);
    }

    return new Response('OK', { status: 200 });
}

// --- ENDPOINT POST /api/ping ---

async function handlePing(request, env) {
    let body = {};
    try { body = await request.json(); } catch(e) {}

    const deviceId = (body.deviceId || body.id || '').toString().trim().toUpperCase();
    if (!deviceId) return new Response(JSON.stringify({ error: 'Falta deviceId' }), { status: 400 });

    const boardUptimeMs = parseInt(body.uptimeMs || 0, 10);
    const chatId = (body.chatId || body.telegramChatId || '').toString().trim();
    const offlinePings = parseInt(body.offlinePings || body.missedPings || 0, 10);
    const incomingAlias = (body.alias || body.name || '').toString().trim();

    const now = Date.now();
    const existing = await getDeviceFull(env.DB, deviceId);

    const shouldReset = existing ? existing.resetRequested : false;
    const wasBlackout = existing ? existing.blackoutNotified : false;
    let targetChatId = chatId || (existing ? existing.chatId : '');
    if (targetChatId === '3307499449') targetChatId = '330749449';

    let deviceAlias = existing?.alias || ((incomingAlias && incomingAlias !== deviceId) ? incomingAlias : deviceId);
    let isUnlinkedNow = existing ? existing.unlinked : false;

    if (shouldReset) {
        targetChatId = '';
        deviceAlias = deviceId;
        isUnlinkedNow = true;
        await env.DB.prepare("DELETE FROM guests WHERE device_id = ?").bind(deviceId).run();
    } else if (chatId) {
        isUnlinkedNow = false;
    }

    const history = existing?.history || [];
    const hasOpenCut = history.length > 0 && !history[0].end;

    let blackoutStart = null;
    if (hasOpenCut && history[0].start) blackoutStart = history[0].start;
    else if (existing?.blackoutStartTime) blackoutStart = existing.blackoutStartTime;
    else if (existing?.lastSeen) blackoutStart = existing.lastSeen;
    else blackoutStart = now - OFFLINE_THRESHOLD_MS;

    const computedDurationMs = Math.max(now - blackoutStart, 60000);
    const chipStayedPoweredOn = boardUptimeMs > (computedDurationMs + 5000);
    const wasAlertSent = wasBlackout || Boolean(existing?.blackoutStartTime) || Boolean(existing?.lastAlertMessageId);
    const isReturnFromBlackout = !shouldReset && (wasAlertSent || computedDurationMs >= OFFLINE_THRESHOLD_MS);

    let onlineSince = existing?.onlineSince || (boardUptimeMs > 0 ? (now - boardUptimeMs) : now);
    if (isReturnFromBlackout && !chipStayedPoweredOn) {
        onlineSince = boardUptimeMs > 0 ? (now - boardUptimeMs) : now;
    }

    // Si regresa de un apagón
    if (isReturnFromBlackout && (existing?.lastSeen || existing?.blackoutStartTime || hasOpenCut)) {
        const durationFormatted = formatDuration(computedDurationMs);
        const returnTimeStr = formatVETime(now);
        const returnDateStr = formatVEDate(now);

        let eventType = 'power_outage';
        if (chipStayedPoweredOn) eventType = 'internet_drop';
        else if (Math.round(computedDurationMs / 60000) < 5) eventType = 'fluctuation';

        // Cerrar corte abierto en D1
        if (hasOpenCut) {
            await env.DB.prepare("UPDATE history SET end_time = ?, end_time_str = ?, end_date_str = ?, duration_str = ?, duration_ms = ?, event_type = ? WHERE id = ?")
                .bind(now, returnTimeStr, returnDateStr, durationFormatted, computedDurationMs, eventType, history[0].id).run();
        } else {
            const eventId = `event_${blackoutStart}`;
            await env.DB.prepare("INSERT OR REPLACE INTO history (id, device_id, start_time, end_time, start_time_str, end_time_str, start_date_str, end_date_str, duration_str, duration_ms, event_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(eventId, deviceId, blackoutStart, now, formatVETime(blackoutStart), returnTimeStr, formatVEDate(blackoutStart), returnDateStr, durationFormatted, computedDurationMs, eventType).run();
        }

        const geoSuffix = (existing?.city && existing?.isp) ? ` <i>(${existing.city}, ${existing.region || ''} — ${existing.isp} 🌐)</i>` : '';

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

        if (targetChatId && (wasAlertSent || computedDurationMs >= OFFLINE_THRESHOLD_MS)) {
            await sendTelegramMessage(targetChatId, returnMsg);
            const guests = existing?.guestChatIds || [];
            for (const gId of guests) {
                if (gId && gId !== targetChatId) {
                    await sendTelegramMessage(gId, returnMsg, [
                        [{ text: "📊 Consultar Estado en Vivo", callback_data: `/estado_${deviceId}` }]
                    ]);
                }
            }
        }
    }

    // Geolocalización nativa gratuita de Cloudflare en 0ms
    const incomingIp = request.headers.get('cf-connecting-ip') || '0.0.0.0';
    const city = request.cf?.city || existing?.city || '';
    const region = request.cf?.region || existing?.region || '';
    const isp = request.cf?.asOrganization || existing?.isp || '';

    // Guardar dispositivo en D1
    await env.DB.prepare(`
        INSERT INTO devices (device_id, alias, chat_id, last_seen, online_since, blackout_notified, blackout_start_time, last_alert_msg_id, last_alert_messages, ip, city, region, isp, unlinked, reset_requested, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, '{}', ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            alias = excluded.alias,
            chat_id = excluded.chat_id,
            last_seen = excluded.last_seen,
            online_since = excluded.online_since,
            blackout_notified = 0,
            blackout_start_time = NULL,
            last_alert_msg_id = NULL,
            last_alert_messages = '{}',
            ip = excluded.ip,
            city = excluded.city,
            region = excluded.region,
            isp = excluded.isp,
            unlinked = excluded.unlinked,
            reset_requested = 0,
            updated_at = excluded.updated_at
    `).bind(
        deviceId,
        deviceAlias,
        targetChatId,
        now,
        onlineSince,
        incomingIp,
        city,
        region,
        isp,
        isUnlinkedNow ? 1 : 0,
        existing ? existing.updatedAt : now
    ).run();

    return new Response(JSON.stringify({
        success: true,
        timestamp: now,
        action: shouldReset ? 'RESET_WIFI' : 'NONE'
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

// --- COMANDOS CRON AUTOMÁTICOS (CADA 1 MINUTO) ---

async function checkBlackoutAlerts(env) {
    const now = Date.now();
    const threshold = now - OFFLINE_THRESHOLD_MS;

    const devsRows = await env.DB.prepare(`
        SELECT * FROM devices 
        WHERE last_seen > 0 
          AND last_seen <= ? 
          AND blackout_notified = 0 
          AND unlinked = 0 
          AND chat_id != ''
    `).bind(threshold).all();

    for (const dev of (devsRows.results || [])) {
        const deviceId = dev.device_id;
        const devChatId = String(dev.chat_id || '').trim();
        if (!devChatId) continue;

        const timeStr = formatVETime(dev.last_seen);
        const dateStr = formatVEDate(dev.last_seen);
        const devName = dev.alias || deviceId;

        const geoSuffix = (dev.city && dev.isp) ? ` <i>(${dev.city}, ${dev.region || ''} — ${dev.isp} 🌐)</i>` : '';

        const alertMsg = `🔴 <b>¡ALERTA DE CORTE DE ENERGÍA / DESCONEXIÓN!</b> 🔴\n\n` +
                         `📍 <b>Ubicación:</b> <b>${devName}</b>${geoSuffix}\n` +
                         `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                         `⏰ <b>Hora de desconexión:</b> ${timeStr} (${dateStr})\n\n` +
                         `El monitor ha dejado de reportar a nuestros servidores. Es muy probable que se haya ido la luz en tu zona o haya una interrupción del servicio eléctrico.\n\n` +
                         `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;

        const ownerSend = await sendTelegramMessage(devChatId, alertMsg);
        const lastAlertMessages = {};
        if (ownerSend.messageId) lastAlertMessages[devChatId] = ownerSend.messageId;

        const guestsRows = await env.DB.prepare("SELECT guest_chat_id FROM guests WHERE device_id = ?").bind(deviceId).all();
        for (const g of (guestsRows.results || [])) {
            const gId = String(g.guest_chat_id).trim();
            if (gId && gId !== devChatId) {
                const gSend = await sendTelegramMessage(gId, alertMsg, [
                    [{ text: "📊 Consultar Estado en Vivo", callback_data: `/estado_${deviceId}` }]
                ]);
                if (gSend.messageId) lastAlertMessages[gId] = gSend.messageId;
            }
        }

        const eventId = `event_${dev.last_seen}`;
        await env.DB.prepare(`
            INSERT OR REPLACE INTO history (id, device_id, start_time, end_time, start_time_str, end_time_str, start_date_str, end_date_str, duration_str, duration_ms, event_type)
            VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, 'En curso...', 0, 'power_outage')
        `).bind(eventId, deviceId, dev.last_seen, timeStr, dateStr).run();

        await env.DB.prepare(`
            UPDATE devices 
            SET blackout_notified = 1,
                blackout_start_time = ?,
                last_alert_msg_id = ?,
                last_alert_messages = ?
            WHERE device_id = ?
        `).bind(dev.last_seen, ownerSend.messageId || null, JSON.stringify(lastAlertMessages), deviceId).run();

        console.log(`[ALERT] Notified blackout for ${deviceId}`);
    }
}

// --- WORKER ENTRYPOINT ---

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // Endpoint de Ping de la placa ESP8266
        if (pathname === '/api/ping' && request.method === 'POST') {
            const res = await handlePing(request, env);
            return new Response(res.body, { status: res.status, headers: { ...corsHeaders, ...res.headers } });
        }

        // Endpoint Webhook de Telegram
        if (pathname === '/api/telegram-webhook' && request.method === 'POST') {
            return await handleTelegramWebhook(request, env);
        }

        // Endpoint lista de dispositivos en vivo (para el dashboard web)
        if (pathname === '/api/devices' && request.method === 'GET') {
            const devs = await getAllDevicesFull(env.DB);
            return new Response(JSON.stringify(devs), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Endpoint historial de cortes por dispositivo
        if (pathname.startsWith('/api/history/') && request.method === 'GET') {
            const devId = pathname.replace('/api/history/', '').toUpperCase().trim();
            const dev = await getDeviceFull(env.DB, devId);
            return new Response(JSON.stringify(dev?.history || []), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Endpoint detalle de un dispositivo
        if (pathname.startsWith('/api/device/') && request.method === 'GET') {
            const devId = pathname.replace('/api/device/', '').toUpperCase().trim();
            const dev = await getDeviceFull(env.DB, devId);
            if (!dev) return new Response(JSON.stringify({ error: 'Device not found' }), { status: 404, headers: corsHeaders });
            return new Response(JSON.stringify(dev), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Root / healthcheck
        if (pathname === '/' || pathname === '/api/health') {
            return new Response(JSON.stringify({ status: 'ok', service: 'PowerWatch Cloudflare Worker', timestamp: Date.now() }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders });
    },

    // Cron Trigger automático ejecutado cada minuto por Cloudflare
    async scheduled(event, env, ctx) {
        ctx.waitUntil(checkBlackoutAlerts(env));
    }
};
